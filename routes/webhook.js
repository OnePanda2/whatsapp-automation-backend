// ============================================================
// routes/webhook.js — Razorpay Webhook Handler
// ============================================================
// WHAT THIS DOES:
//   Receives payment confirmation webhooks from Razorpay.
//   Verifies the signature cryptographically to prevent fraud.
//   Only activates subscription AFTER verified backend confirmation.
//   NEVER trusts frontend for payment success.
//
// WHERE TO PLACE: backend/routes/webhook.js
// ============================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const supabase = require('../services/supabase');
const { logSuccess, logError } = require('../services/logger');
require('dotenv').config();

/**
 * POST /api/webhook/razorpay
 * Razorpay sends this webhook when a payment is captured.
 * We verify the signature, then activate the user's subscription.
 *
 * IMPORTANT: This route must use express.raw() for body parsing
 * because we need the raw body to verify the HMAC signature.
 * This is configured in server.js.
 */
router.post('/razorpay', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('❌ RAZORPAY_WEBHOOK_SECRET is not set');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Get the signature from Razorpay's headers
    const signature = req.headers['x-razorpay-signature'];

    if (!signature) {
      console.error('❌ Missing Razorpay signature header');
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify the signature using HMAC SHA256
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error('❌ Razorpay webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Parse the webhook payload
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = payload.event;

    console.log(`📩 Razorpay webhook received: ${event}`);

    // Handle payment captured event
    if (event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;

      if (!payment) {
        console.error('❌ No payment entity in webhook payload');
        return res.status(400).json({ error: 'Invalid payload' });
      }

      const userId = payment.notes?.user_id;
      const email = payment.notes?.email;
      const plan = payment.notes?.plan || 'pro_monthly';

      if (!userId) {
        console.error('❌ No user_id in payment notes');
        return res.status(400).json({ error: 'Missing user_id' });
      }

      // Calculate subscription expiry (30 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      // Upsert subscription — activate or renew
      const { error: subError } = await supabase
        .from('subscriptions')
        .upsert(
          {
            user_id: userId,
            status: 'active',
            plan: plan,
            expires_at: expiresAt.toISOString(),
            razorpay_payment_id: payment.id,
            razorpay_order_id: payment.order_id,
          },
          { onConflict: 'user_id' }
        );

      if (subError) {
        console.error('❌ Failed to activate subscription:', subError.message);
        await logError(userId, 'payment_activation_failed', subError.message);
        return res.status(500).json({ error: 'Failed to activate subscription' });
      }

      await logSuccess(
        userId,
        'payment_success',
        `Payment captured: ₹${payment.amount / 100}. Plan: ${plan}. Expires: ${expiresAt.toLocaleDateString()}`
      );

      console.log(`✅ Subscription activated for user ${userId} (${email})`);

      return res.json({ success: true });
    }

    // Handle payment failed event
    if (event === 'payment.failed') {
      const payment = payload.payload?.payment?.entity;
      const userId = payment?.notes?.user_id;

      if (userId) {
        await logError(
          userId,
          'payment_failed',
          `Payment failed: ${payment?.error_description || 'Unknown error'}`
        );
      }

      console.log('⚠️ Payment failed event received');
      return res.json({ success: true });
    }

    // Acknowledge other events without processing
    return res.json({ success: true, message: `Event ${event} acknowledged` });
  } catch (err) {
    console.error('❌ Webhook handler crash:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
