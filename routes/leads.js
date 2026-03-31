// ============================================================
// routes/leads.js — LinkedIn Lead Capture & Management
// ============================================================

const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// Helper to handle Monthly Reset Logic and Limits
async function enforceLimits(user_email) {
  // 1. Fetch user data
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, runs_used, runs_limit, billing_cycle_start')
    .eq('email', user_email)
    .single();

  if (userError || !user) {
    throw new Error('User not found or Supabase unreachable');
  }

  let { runs_used, runs_limit, billing_cycle_start } = user;

  // 2. Monthly Reset Logic
  const now = new Date();
  const cycleStart = new Date(billing_cycle_start);
  const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;

  if (now.getTime() > cycleStart.getTime() + thirtyDaysInMs) {
    // Reset limits
    runs_used = 0;
    const { error: updateError } = await supabase
      .from('users')
      .update({ runs_used: 0, billing_cycle_start: now.toISOString() })
      .eq('email', user_email);

    if (updateError) console.error('Error resetting billing cycle:', updateError);
  }

  // 3. Limit Check
  if (runs_used >= runs_limit) {
    return { limited: true, user };
  }

  return { limited: false, user };
}

/**
 * POST /api/leads/capture
 * Scrape destination for LinkedIn leads.
 */
router.post('/capture', async (req, res) => {
  try {
    const { user_email, name, job_title, company, profile_url } = req.body;

    console.log(`[LinkedIn] Capture started for user: ${user_email}, profile: ${profile_url}`);

    if (!user_email || !profile_url) {
      console.warn(`[LinkedIn] Missing required fields`);
      return res.status(400).json({ 
        error: "Missing required fields", 
        missing: ['user_email', 'profile_url'].filter(f => !req.body[f]) 
      });
    }

    // 1. Duplicate check
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('user_email', user_email)
      .eq('profile_url', profile_url)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[LinkedIn] Duplicate found for profile: ${profile_url}`);
      return res.status(200).json({ status: "duplicate", message: "Lead already captured" });
    }

    // 2. Enforce limits and Monthly Reset
    let limitCheck;
    try {
      limitCheck = await enforceLimits(user_email);
    } catch (err) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    if (limitCheck.limited) {
      console.warn(`[LinkedIn] User ${user_email} reached limit (${limitCheck.user.runs_used}/${limitCheck.user.runs_limit})`);
      return res.status(403).json({ code: "limit_reached" });
    }

    // 3. Insert lead
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert([{
        user_email,
        name: name || null,
        job_title: job_title || null,
        company: company || null,
        profile_url
      }])
      .select('id, name, profile_url, captured_at')
      .single();

    if (insertError) {
      console.error(`[LinkedIn] Insert error:`, insertError);
      return res.status(503).json({ error: "Database unavailable" });
    }

    // 4. Increment usage
    await supabase
      .from('users')
      .update({ runs_used: limitCheck.user.runs_used + 1 })
      .eq('email', user_email);

    console.log(`[LinkedIn] Capture success for ${profile_url}. Lead ID: ${newLead.id}`);

    return res.status(201).json({
      success: true,
      lead: newLead
    });

  } catch (err) {
    console.error('[LinkedIn] Unknown error:', err.message);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

/**
 * GET /api/leads/all?email=user@example.com
 * Returns all leads for this user.
 */
router.get('/all', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "Missing required query parameter: email" });
    }

    const { data: leads, error } = await supabase
      .from('leads')
      .select('*')
      .eq('user_email', email)
      .order('captured_at', { ascending: false });

    if (error) {
       console.error('[LinkedIn GET] DB Error:', error);
       return res.status(503).json({ error: "Database unavailable" });
    }

    return res.status(200).json({ leads: leads || [] });

  } catch (err) {
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

/**
 * PATCH /api/leads/:id/status
 * Updates lead status inline.
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['new', 'contacted', 'closed'].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const { error } = await supabase
      .from('leads')
      .update({ status })
      .eq('id', id);

    if (error) {
       console.error('[LinkedIn PATCH] DB Error:', error);
       return res.status(503).json({ error: "Database unavailable" });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

/**
 * GET /api/leads/stats?email=user@example.com
 * Aggregated stats for the dashboard header.
 */
router.get('/stats', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "Missing required query parameter: email" });
    }

    // Run parallel queries
    const [leadsResponse, userResponse, subResponse] = await Promise.all([
      supabase.from('leads').select('status').eq('user_email', email),
      supabase.from('users').select('runs_used, runs_limit').eq('email', email).single(),
      supabase.from('subscriptions').select('plan').eq('user_id', (await getUserIdByEmail(email))) // Needs user ID
    ]);

    if (leadsResponse.error || userResponse.error) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    const leads = leadsResponse.data || [];
    
    // Calculate aggregates
    const stats = {
      total: leads.length,
      new: leads.filter(l => l.status === 'new').length,
      contacted: leads.filter(l => l.status === 'contacted').length,
      closed: leads.filter(l => l.status === 'closed').length,
      runs_used: userResponse.data.runs_used,
      runs_limit: userResponse.data.runs_limit,
      plan: (subResponse.data && subResponse.data.length > 0) ? subResponse.data[0].plan : 'free'
    };

    return res.status(200).json(stats);

  } catch (err) {
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// Helper for subcription lookup
async function getUserIdByEmail(email) {
  const { data } = await supabase.from('users').select('id').eq('email', email).single();
  return data ? data.id : null;
}

module.exports = router;
