// ============================================================
// routes/auth.js — User Registration & Login Routes
// ============================================================
// WHAT THIS DOES:
//   - POST /api/auth/register — Register a new user by email
//   - POST /api/auth/login — Login (verify user exists)
//   - GET  /api/auth/me — Get current user info (requires auth)
//
// WHERE TO PLACE: backend/routes/auth.js
// ============================================================

const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { logInfo, logError } = require('../services/logger');
const { authenticateUser } = require('../middleware/auth');

/**
 * POST /api/auth/register
 * Register a new user. Idempotent — if user exists, return existing.
 * Body: { email: "user@example.com" }
 */
router.post('/register', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'Valid email is required',
      });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check if user already exists
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('email', cleanEmail)
      .single();

    if (existing) {
      return res.json({
        success: true,
        message: 'User already registered',
        user: { id: existing.id, email: existing.email },
      });
    }

    // Create new user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({ email: cleanEmail })
      .select()
      .single();

    if (error) {
      console.error('❌ Registration error:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to register user',
      });
    }

    // Create a default inactive subscription
    await supabase.from('subscriptions').insert({
      user_id: newUser.id,
      status: 'inactive',
      plan: 'free',
    });

    await logInfo(newUser.id, 'user_registered', `New user registered: ${cleanEmail}`);

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: { id: newUser.id, email: newUser.email },
    });
  } catch (err) {
    console.error('❌ Registration crash:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Registration service unavailable',
    });
  }
});

/**
 * POST /api/auth/login
 * Verify user exists and return their info.
 * Body: { email: "user@example.com" }
 */
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'Valid email is required',
      });
    }

    const cleanEmail = email.toLowerCase().trim();

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', cleanEmail)
      .single();

    if (error || !user) {
      return res.status(404).json({
        success: false,
        error: 'User not found. Please register first.',
      });
    }

    await logInfo(user.id, 'user_login', `User logged in: ${cleanEmail}`);

    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
    });
  } catch (err) {
    console.error('❌ Login crash:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Login service unavailable',
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user info. Requires x-user-email header.
 */
router.get('/me', authenticateUser, async (req, res) => {
  try {
    // Get subscription status too
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        createdAt: req.user.created_at,
      },
      subscription: subscription
        ? {
            status: subscription.status,
            plan: subscription.plan,
            expiresAt: subscription.expires_at,
          }
        : { status: 'inactive', plan: 'free', expiresAt: null },
    });
  } catch (err) {
    console.error('❌ /me crash:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Service unavailable',
    });
  }
});

module.exports = router;
