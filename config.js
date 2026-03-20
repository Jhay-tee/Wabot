import 'dotenv/config';

export const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  NAMESPACE: 'wa_bot',
  BOT_PREFIX: '.',
  ADMIN_IDS: process.env.ADMIN_IDS?.split(',') || [], // optional static admins
  VULGAR_WORDS: ['bitch', 'fuck', 'shit', 'ass'],
  NODE_ENV: process.env.NODE_ENV || 'production',
  TIMEZONE: 'Africa/Lagos'
};
