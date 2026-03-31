// ============================================================
// middleware/auth.js — Authentication Middleware
// ============================================================
// WHAT THIS DOES:
//   Validates that incoming API requests include a valid user
//   email or user ID. Looks up the user in Supabase and
//   attaches the user object to req.user for downstream use.
//
// WHERE TO PLACE: backend/middleware/auth.js
// ============================================================

const supabase = require('../services/supabase');

/**
 * Middleware: Validate user by email header.
 * Expects header: x-user-email
 */
async function authenticateUser(req, res, next) {
  const email = req.headers['x-user-email'];

  if (!email) {
    return res.status(401).json({
      success: false,
      error: 'Missing x-user-email header',
    });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'User not found. Please register first.',
      });
    }

    // Attach user to request for downstream handlers
    req.user = user;
    next();
  } catch (err) {
    console.error('❌ Auth middleware error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Authentication service unavailable',
    });
  }
}

/**
 * Middleware: Validate active subscription.
 * Must be used AFTER authenticateUser.
 */
async function requireSubscription(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated',
    });
  }

  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .single();

    if (error || !subscription) {
      return res.status(403).json({
        success: false,
        error: 'Active subscription required. Please upgrade.',
        subscriptionStatus: 'inactive',
      });
    }

    // Check if subscription has expired
    if (subscription.expires_at && new Date(subscription.expires_at) < new Date()) {
      // Mark as expired in DB
      await supabase
        .from('subscriptions')
        .update({ status: 'inactive' })
        .eq('user_id', req.user.id);

      return res.status(403).json({
        success: false,
        error: 'Subscription expired. Please renew.',
        subscriptionStatus: 'expired',
      });
    }

    req.subscription = subscription;
    next();
  } catch (err) {
    console.error('❌ Subscription check error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Subscription service unavailable',
    });
  }
}

module.exports = { authenticateUser, requireSubscription };
