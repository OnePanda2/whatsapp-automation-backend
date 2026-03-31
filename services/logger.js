// ============================================================
// services/logger.js — Centralized Logging to Supabase
// ============================================================
// WHAT THIS DOES:
//   Logs every significant event to the automation_logs table.
//   This includes automation start/stop, follow-ups sent,
//   AI calls, payment events, subscription checks, and errors.
//
// WHERE TO PLACE: backend/services/logger.js
// ============================================================

const supabase = require('./supabase');

/**
 * Log an event to the automation_logs table.
 *
 * @param {Object} params
 * @param {string} params.userId — UUID of the user
 * @param {string} params.action — e.g., "automation_start", "followup_sent", "payment_success"
 * @param {string} params.status — "success", "error", "info"
 * @param {string} params.message — Human-readable description of the event
 */
async function log({ userId, action, status, message }) {
  try {
    const { error } = await supabase.from('automation_logs').insert({
      user_id: userId,
      action,
      status,
      message,
      timestamp: new Date().toISOString(),
    });

    if (error) {
      // If logging itself fails, at least print to console
      console.error('❌ Failed to write log to DB:', error.message);
      console.error('   Original log:', { userId, action, status, message });
    }
  } catch (err) {
    console.error('❌ Logger crash:', err.message);
  }
}

// Convenience wrappers
const logInfo = (userId, action, message) =>
  log({ userId, action, status: 'info', message });

const logSuccess = (userId, action, message) =>
  log({ userId, action, status: 'success', message });

const logError = (userId, action, message) =>
  log({ userId, action, status: 'error', message });

module.exports = { log, logInfo, logSuccess, logError };
