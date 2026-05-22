import 'dotenv/config';

export const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  // Legacy code: do not use anon key for server writes. The legacy-bot now
  // reuses the backend service-role client (backend/src/lib/supabase.js).
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  NAMESPACE: 'wa_bot',
  BOT_PREFIX: '.',
  ADMIN_IDS: process.env.ADMIN_IDS?.split(',') || [], // optional static admins
  VULGAR_WORDS: ['bitch', 'fuck', 'shit', 'ass'],
  NODE_ENV: process.env.NODE_ENV || 'production',
  TIMEZONE: 'Africa/Lagos'
};
