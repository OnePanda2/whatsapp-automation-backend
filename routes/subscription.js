// ============================================================
// routes/subscription.js — Subscription Management Routes
// ============================================================
// WHAT THIS DOES:
//   - GET  /api/subscription/status — Check subscription status
//   - POST /api/subscription/create-order — Create Razorpay order
//
// WHERE TO PLACE: backend/routes/subscription.js
// ============================================================

const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const supabase = require('../services/supabase');
const { authenticateUser } = require('../middleware/auth');
const { logInfo, logError } = require('../services/logger');
require('dotenv').config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * GET /api/subscription/status
 * Check the current subscription status of the authenticated user.
 */
router.get('/status', authenticateUser, async (req, res) => {
  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !subscription) {
      return res.json({
        success: true,
        subscription: { status: 'inactive', plan: 'free', expiresAt: null },
      });
    }

    // Check expiry
    if (
      subscription.status === 'active' &&
      subscription.expires_at &&
      new Date(subscription.expires_at) < new Date()
    ) {
      await supabase
        .from('subscriptions')
        .update({ status: 'inactive' })
        .eq('id', subscription.id);

      return res.json({
        success: true,
        subscription: { status: 'expired', plan: subscription.plan, expiresAt: subscription.expires_at },
      });
    }

    return res.json({
      success: true,
      subscription: {
        status: subscription.status,
        plan: subscription.plan,
        expiresAt: subscription.expires_at,
      },
    });
  } catch (err) {
    console.error('❌ Subscription status error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Subscription service unavailable',
    });
  }
});

/**
 * POST /api/subscription/create-order
 * Create a Razorpay order for the user to pay.
 * Returns the order ID needed by the frontend to open Razorpay checkout.
 */
router.post('/create-order', authenticateUser, async (req, res) => {
  try {
    const amount = parseInt(process.env.RAZORPAY_PLAN_AMOUNT) || 49900; // Amount in paise (₹499)
    const currency = process.env.RAZORPAY_PLAN_CURRENCY || 'INR';

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `rcpt_${req.user.id.substring(0, 8)}_${Date.now()}`.substring(0, 40),
      notes: {
        user_id: req.user.id,
        email: req.user.email,
        plan: 'pro_monthly',
      },
    });

    await logInfo(
      req.user.id,
      'order_created',
      `Razorpay order created: ${order.id} for ₹${amount / 100}`
    );

    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('❌ Order creation error details:', JSON.stringify(err, null, 2));
    const errorMessage = err.message || (err.error && err.error.description) || 'Payment gateway error';
    console.error('❌ Order creation error:', errorMessage);
    
    await logError(req.user.id, 'order_creation_failed', errorMessage);
    return res.status(500).json({
      success: false,
      error: 'Failed to create payment order',
      details: errorMessage
    });
  }
});

module.exports = router;
