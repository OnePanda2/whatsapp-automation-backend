// ============================================================
// services/supabase.js — Supabase Client Initialization
// ============================================================
// WHAT THIS DOES:
//   Creates a single, reusable Supabase client using the
//   service-role key so the backend can read/write ALL tables
//   without Row Level Security restrictions.
//
// WHERE TO PLACE: backend/services/supabase.js
// ============================================================

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

module.exports = supabase;
