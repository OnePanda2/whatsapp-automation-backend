// ============================================================
// services/queue.js — Automation Queue Processing Service
// ============================================================
// WHAT THIS DOES:
//   Manages the automation_queue table. Schedules follow-up
//   tasks, processes them sequentially, respects timing limits,
//   and enforces daily/hourly caps to prevent spam.
//
// WHERE TO PLACE: backend/services/queue.js
// ============================================================

const supabase = require('./supabase');
const { generateFollowUp, getOptimalDelay, shouldFollowUp } = require('./ai');
require('dotenv').config();

const MAX_PER_HOUR = parseInt(process.env.MAX_FOLLOWUPS_PER_HOUR) || 8;
const MAX_PER_DAY = parseInt(process.env.MAX_FOLLOWUPS_PER_DAY) || 40;
const STALE_HOURS = parseInt(process.env.STALE_CHAT_THRESHOLD_HOURS) || 24;

/**
 * Find conversations that need follow-up for a specific user.
 * A conversation is "stale" when:
 *   - The last message was sent BY the user (not received)
 *   - No reply has been received for > STALE_HOURS
 *   - The conversation is not already marked as "completed" or "paused"
 *   - There is no pending queue item for this conversation
 */
async function detectStaleConversations(userId) {
  const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  // Get conversations where last message was sent by user and is older than threshold
  const { data: staleChats, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'waiting_reply')
    .lt('last_message_time', cutoff);

  if (error) {
    console.error('❌ Error finding stale conversations:', error.message);
    return [];
  }

  if (!staleChats || staleChats.length === 0) return [];

  // Filter out conversations that already have a pending queue item
  const { data: pendingQueue } = await supabase
    .from('automation_queue')
    .select('contact_name')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing']);

  const pendingContacts = new Set((pendingQueue || []).map((q) => q.contact_name));

  return staleChats.filter((chat) => !pendingContacts.has(chat.contact_name));
}

/**
 * Schedule follow-up messages for stale conversations.
 * Uses AI to determine optimal timing for each.
 */
async function scheduleFollowUps(userId) {
  const staleChats = await detectStaleConversations(userId);

  if (staleChats.length === 0) {
    return { scheduled: 0, message: 'No stale conversations found' };
  }

  // Check daily limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count: todayCount } = await supabase
    .from('automation_queue')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('scheduled_time', todayStart.toISOString())
    .in('status', ['pending', 'processing', 'completed']);

  const remainingToday = MAX_PER_DAY - (todayCount || 0);
  if (remainingToday <= 0) {
    return { scheduled: 0, message: 'Daily follow-up limit reached' };
  }

  const chatsToProcess = staleChats.slice(0, remainingToday);
  let scheduledCount = 0;

  for (const chat of chatsToProcess) {
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    const hourOfDay = now.getHours();
    const hoursSince = Math.floor(
      (Date.now() - new Date(chat.last_message_time).getTime()) / (1000 * 60 * 60)
    );

    // Get the follow-up count for this contact
    const { count: followUpCount } = await supabase
      .from('automation_queue')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('contact_name', chat.contact_name)
      .eq('status', 'completed');

    // AI validation: Is follow-up actually needed based on text?
    if (chat.last_message_sent && chat.last_message_sent.trim() !== '') {
      const isNeeded = await shouldFollowUp({ lastMessageSent: chat.last_message_sent });
      
      if (!isNeeded) {
        console.log(`🤖 AI determined no follow-up needed for ${chat.contact_name}. Marking resolved.`);
        await supabase
          .from('conversations')
          .update({ status: 'resolved' })
          .eq('user_id', userId)
          .eq('contact_name', chat.contact_name);
          
        continue; // Skip queuing
      }
    }

    // AI decides optimal delay
    const delayMinutes = await getOptimalDelay({
      hoursSinceLastMessage: hoursSince,
      followUpCount: followUpCount || 0,
      dayOfWeek,
      hourOfDay,
    });

    const scheduledTime = new Date(Date.now() + delayMinutes * 60 * 1000);

    // Generate the follow-up message
    const message = await generateFollowUp({
      contactName: chat.contact_name,
      lastMessageSent: chat.last_message_sent || '',
      hoursSinceLastMessage: hoursSince,
      followUpCount: followUpCount || 0,
    });

    // Insert into queue
    const { error } = await supabase.from('automation_queue').insert({
      user_id: userId,
      contact_name: chat.contact_name,
      scheduled_time: scheduledTime.toISOString(),
      message: message,
      status: 'pending',
      retry_count: 0,
    });

    if (error) {
      console.error(`❌ Failed to queue follow-up for ${chat.contact_name}:`, error.message);
    } else {
      scheduledCount++;
      console.log(
        `✅ Queued follow-up for ${chat.contact_name} at ${scheduledTime.toLocaleTimeString()}`
      );
    }
  }

  return { scheduled: scheduledCount, message: `Scheduled ${scheduledCount} follow-ups` };
}

/**
 * Get pending queue items that are ready to send (scheduled_time <= now).
 */
async function getPendingTasks(userId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('automation_queue')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .lte('scheduled_time', now)
    .order('scheduled_time', { ascending: true })
    .limit(1); // Process one at a time for safety

  if (error) {
    console.error('❌ Error fetching pending tasks:', error.message);
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Mark a queue task as processing (locked).
 */
async function markTaskProcessing(taskId) {
  const { error } = await supabase
    .from('automation_queue')
    .update({ status: 'processing' })
    .eq('id', taskId);

  if (error) {
    console.error('❌ Error marking task as processing:', error.message);
    return false;
  }
  return true;
}

/**
 * Mark a queue task as completed.
 */
async function markTaskCompleted(taskId) {
  const { error } = await supabase
    .from('automation_queue')
    .update({ status: 'completed' })
    .eq('id', taskId);

  if (error) {
    console.error('❌ Error marking task completed:', error.message);
    return false;
  }
  return true;
}

/**
 * Mark a queue task as failed with retry logic.
 */
async function markTaskFailed(taskId, retryCount) {
  const maxRetries = 3;

  if (retryCount >= maxRetries) {
    // Max retries exceeded — mark as permanently failed
    const { error } = await supabase
      .from('automation_queue')
      .update({ status: 'failed', retry_count: retryCount })
      .eq('id', taskId);

    if (error) console.error('❌ Error marking task as failed:', error.message);
    return false;
  }

  // Reschedule with exponential backoff (5min, 15min, 45min)
  const backoffMinutes = 5 * Math.pow(3, retryCount);
  const newScheduledTime = new Date(Date.now() + backoffMinutes * 60 * 1000);

  const { error } = await supabase
    .from('automation_queue')
    .update({
      status: 'pending',
      retry_count: retryCount + 1,
      scheduled_time: newScheduledTime.toISOString(),
    })
    .eq('id', taskId);

  if (error) {
    console.error('❌ Error rescheduling task:', error.message);
    return false;
  }
  return true;
}

/**
 * Check if the user is within their hourly rate limit.
 */
async function isWithinHourlyLimit(userId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('automation_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action', 'followup_sent')
    .eq('status', 'success')
    .gte('timestamp', oneHourAgo);

  if (error) {
    console.error('❌ Error checking hourly limit:', error.message);
    return false; // Fail closed — don't send if we can't check
  }

  return (count || 0) < MAX_PER_HOUR;
}

module.exports = {
  detectStaleConversations,
  scheduleFollowUps,
  getPendingTasks,
  markTaskProcessing,
  markTaskCompleted,
  markTaskFailed,
  isWithinHourlyLimit,
};
