// ============================================================
// server.js — Main Express Server
// ============================================================
// WHAT THIS DOES:
//   Entry point for the backend API. Sets up Express with
//   security headers, CORS, logging, and routes.
//   Also starts a cron job to periodically scan for stale
//   conversations and schedule follow-ups automatically.
//
// WHERE TO PLACE: backend/server.js
//
// HOW TO RUN:
//   1. Copy .env.example to .env and fill in your keys
//   2. Run: npm install
//   3. Run: npm run dev (for development with auto-reload)
//   4. Run: npm start (for production)
//
// HOW TO TEST:
//   Visit http://localhost:3000/api/health in your browser.
//   You should see: { "status": "ok", "timestamp": "..." }
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');

// Import routes
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscription');
const webhookRoutes = require('./routes/webhook');
const automationRoutes = require('./routes/automation');
const leadRoutes = require('./routes/leads');

// Import services
const supabase = require('./services/supabase');
const { scheduleFollowUps } = require('./services/queue');
const { logInfo } = require('./services/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SECURITY ────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────
// Allow requests from the extension and landing page
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like server-to-server or curl)
      if (!origin) return callback(null, true);

      const allowed =
        origin.startsWith('chrome-extension://') ||
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        /^https:\/\/.*\.vercel\.app$/.test(origin) ||
        /^https:\/\/.*\.netlify\.app$/.test(origin);

      if (allowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-user-email', 'x-razorpay-signature'],
    credentials: true,
  })
);

// ─── BODY PARSING ────────────────────────────────────────
// For Razorpay webhooks, we need the raw body for signature verification
// So we apply JSON parsing conditionally
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── REQUEST LOGGING ────────────────────────────────────
app.use(morgan('combined'));

// ─── HEALTH CHECK ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── ROUTES ──────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/leads', leadRoutes);

// ─── 404 HANDLER ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('❌ Unhandled error:', err.message);
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// ─── CRON: AUTO-SCAN FOR STALE CHATS ────────────────────
// Runs every 30 minutes — scans all active subscribers for stale chats
// and schedules follow-ups automatically.
cron.schedule('*/30 * * * *', async () => {
  console.log('⏰ Cron: Scanning for stale conversations...');
  try {
    // Get all users with active subscriptions
    const { data: activeUsers, error } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('status', 'active');

    if (error || !activeUsers) {
      console.error('❌ Cron: Failed to fetch active users:', error?.message);
      return;
    }

    for (const sub of activeUsers) {
      try {
        const result = await scheduleFollowUps(sub.user_id);
        if (result.scheduled > 0) {
          console.log(`  ✅ Scheduled ${result.scheduled} follow-ups for user ${sub.user_id}`);
          await logInfo(
            sub.user_id,
            'cron_scan',
            `Auto-scan: ${result.message}`
          );
        }
      } catch (userErr) {
        console.error(`  ❌ Cron error for user ${sub.user_id}:`, userErr.message);
      }
    }
  } catch (cronErr) {
    console.error('❌ Cron crash:', cronErr.message);
  }
});

// ─── START SERVER ────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  WhatsApp AI Follow-Up Automation — Backend');
  console.log('═══════════════════════════════════════════════');
  console.log(`  🚀 Server running on port ${PORT}`);
  console.log(`  🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  📋 Health check: http://localhost:${PORT}/api/health`);
  console.log('═══════════════════════════════════════════════');
  console.log('');
});
