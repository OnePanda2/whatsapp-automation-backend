// ============================================================
// routes/automation.js — Automation Control & Queue Routes
// ============================================================
// WHAT THIS DOES:
//   - POST /api/automation/scan — Scan for stale chats and schedule follow-ups
//   - GET  /api/automation/next-task — Get next pending task from queue
//   - POST /api/automation/task/:id/complete — Mark a task as completed
//   - POST /api/automation/task/:id/fail — Mark a task as failed
//   - POST /api/automation/conversations/sync — Sync conversation state from extension
//   - GET  /api/automation/logs — Get recent automation logs
//   - GET  /api/automation/stats — Get automation statistics
//
// WHERE TO PLACE: backend/routes/automation.js
// ============================================================

const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { authenticateUser, requireSubscription } = require('../middleware/auth');
const {
  scheduleFollowUps,
  getPendingTasks,
  markTaskProcessing,
  markTaskCompleted,
  markTaskFailed,
  isWithinHourlyLimit,
} = require('../services/queue');
const { validateChatContext } = require('../services/ai');
const { logInfo, logSuccess, logError } = require('../services/logger');

// Auth is applied per-route. Stats and logs are available to all users.
// Automation actions (scan, tasks, sync) require active subscription.

/**
 * POST /api/automation/scan
 * Trigger a scan for stale conversations and schedule follow-ups.
 */
router.post('/scan', authenticateUser, requireSubscription, async (req, res) => {
  try {
    await logInfo(req.user.id, 'scan_triggered', 'Manual scan triggered by user');

    const result = await scheduleFollowUps(req.user.id);

    return res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('❌ Scan error:', err.message);
    await logError(req.user.id, 'scan_failed', err.message);
    return res.status(500).json({
      success: false,
      error: 'Scan failed',
    });
  }
});

/**
 * GET /api/automation/next-task
 * Get the next pending task from the queue (if within rate limits).
 */
router.get('/next-task', authenticateUser, requireSubscription, async (req, res) => {
  try {
    const withinLimit = await isWithinHourlyLimit(req.user.id);
    if (!withinLimit) {
      return res.json({
        success: true,
        task: null,
        message: 'Hourly rate limit reached. Waiting.',
      });
    }

    const task = await getPendingTasks(req.user.id);

    if (!task) {
      return res.json({
        success: true,
        task: null,
        message: 'No pending tasks',
      });
    }

    await markTaskProcessing(task.id);

    return res.json({
      success: true,
      task: {
        id: task.id,
        contactName: task.contact_name,
        message: task.message,
        scheduledTime: task.scheduled_time,
        retryCount: task.retry_count,
      },
    });
  } catch (err) {
    console.error('❌ Next-task error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch next task',
    });
  }
});

/**
 * POST /api/automation/task/:id/complete
 */
router.post('/task/:id/complete', authenticateUser, requireSubscription, async (req, res) => {
  try {
    const taskId = req.params.id;

    await markTaskCompleted(taskId);

    const { data: task } = await supabase
      .from('automation_queue')
      .select('contact_name')
      .eq('id', taskId)
      .single();

    if (task) {
      await supabase
        .from('conversations')
        .update({
          last_followup_time: new Date().toISOString(),
          status: 'followed_up',
        })
        .eq('user_id', req.user.id)
        .eq('contact_name', task.contact_name);
    }

    await logSuccess(
      req.user.id,
      'followup_sent',
      `Follow-up sent to ${task?.contact_name || 'unknown'}`
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Task complete error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to complete task' });
  }
});

/**
 * POST /api/automation/task/:id/fail
 */
router.post('/task/:id/fail', authenticateUser, requireSubscription, async (req, res) => {
  try {
    const taskId = req.params.id;
    const { reason } = req.body;

    const { data: task } = await supabase
      .from('automation_queue')
      .select('retry_count, contact_name')
      .eq('id', taskId)
      .single();

    const retryCount = task?.retry_count || 0;
    const willRetry = await markTaskFailed(taskId, retryCount);

    await logError(
      req.user.id,
      'followup_failed',
      `Follow-up to ${task?.contact_name || 'unknown'} failed: ${reason || 'Unknown'}. Retry: ${willRetry}`
    );

    return res.json({
      success: true,
      willRetry,
      retryCount: retryCount + 1,
    });
  } catch (err) {
    console.error('❌ Task fail error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to record failure' });
  }
});

/**
 * POST /api/automation/validate-context
 * Evaluates the full opened chat context string before we blindly send the message.
 */
router.post('/validate-context', authenticateUser, requireSubscription, async (req, res) => {
  try {
    const { contactName, chatHistory, taskId } = req.body;

    if (!contactName || !chatHistory) {
      return res.status(400).json({ success: false, error: 'Missing chat payload' });
    }

    const isNeeded = await validateChatContext({ contactName, chatHistory });

    if (!isNeeded && taskId) {
      // If the AI says it's resolved, mark the queue task as completed (or aborted) immediately
      // so we don't try it again. We also update the conversation status to resolved.
      await markTaskCompleted(taskId);
      await supabase
        .from('conversations')
        .update({ status: 'resolved' })
        .eq('user_id', req.user.id)
        .eq('contact_name', contactName);

      await logSuccess(
        req.user.id,
        'followup_aborted',
        `AI determined follow-up no longer needed for ${contactName}`
      );
    }

    return res.json({ success: true, isNeeded });
  } catch (err) {
    console.error('❌ Context validate error:', err.message);
    // Fail OPEN — if we can't validate, go ahead and send it
    return res.json({ success: true, isNeeded: true });
  }
});

/**
 * POST /api/automation/conversations/sync
 */
router.post('/conversations/sync', authenticateUser, requireSubscription, async (req, res) => {
  try {
    const { conversations } = req.body;

    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({
        success: false,
        error: 'conversations array is required',
      });
    }

    let upserted = 0;

    // Fetch existing so we don't blindly overwrite 'resolved' statuses
    const { data: existingConvos } = await supabase
      .from('conversations')
      .select('contact_name, last_message_time, status')
      .eq('user_id', req.user.id);
      
    const existingMap = new Map();
    if (existingConvos) {
      existingConvos.forEach(c => existingMap.set(c.contact_name, c));
    }

    for (const convo of conversations) {
      let status = convo.lastSender === 'me' ? 'waiting_reply' : 'replied';

      // Preserve resolved status if there are no explicitly new messages
      const existing = existingMap.get(convo.contactName);
      if (existing && existing.status === 'resolved') {
        const newTime = new Date(convo.lastMessageTime || new Date()).getTime();
        const oldTime = new Date(existing.last_message_time).getTime();
        
        // Only override 'resolved' if the new message time is at least 60 seconds newer
        // (to account for parsing jitter between WhatsApp Web timestamps)
        if (newTime <= oldTime + 60000) {
          status = 'resolved';
        }
      }

      const { error } = await supabase.from('conversations').upsert(
        {
          user_id: req.user.id,
          contact_name: convo.contactName,
          last_message_time: convo.lastMessageTime || new Date().toISOString(),
          last_message_sent: convo.lastMessageSent || '',
          status: status,
        },
        { onConflict: 'user_id,contact_name' }
      );

      if (!error) upserted++;
    }

    await logInfo(
      req.user.id,
      'conversations_synced',
      `Synced ${upserted}/${conversations.length} conversations`
    );

    return res.json({
      success: true,
      synced: upserted,
      total: conversations.length,
    });
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    return res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

/**
 * GET /api/automation/logs
 * Available to ALL logged-in users (no subscription needed).
 */
router.get('/logs', authenticateUser, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const { data: logs, error } = await supabase
      .from('automation_logs')
      .select('*')
      .eq('user_id', req.user.id)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch logs' });
    }

    return res.json({ success: true, logs: logs || [] });
  } catch (err) {
    console.error('❌ Logs error:', err.message);
    return res.status(500).json({ success: false, error: 'Service unavailable' });
  }
});

/**
 * GET /api/automation/stats
 * Available to ALL logged-in users (no subscription needed).
 */
router.get('/stats', authenticateUser, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const { count: totalSent } = await supabase
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('action', 'followup_sent')
      .eq('status', 'success');

    const { count: todaySent } = await supabase
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('action', 'followup_sent')
      .eq('status', 'success')
      .gte('timestamp', todayStart.toISOString());

    const { count: pendingCount } = await supabase
      .from('automation_queue')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('status', 'pending');

    const { count: activeConversations } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .eq('status', 'waiting_reply');

    return res.json({
      success: true,
      stats: {
        totalFollowUpsSent: totalSent || 0,
        todayFollowUpsSent: todaySent || 0,
        pendingInQueue: pendingCount || 0,
        activeConversations: activeConversations || 0,
      },
    });
  } catch (err) {
    console.error('❌ Stats error:', err.message);
    return res.status(500).json({ success: false, error: 'Service unavailable' });
  }
});

module.exports = router;
