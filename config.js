import 'dotenv/config';

export const CONFIG = {
  SUPERBASE_URL: process.env.SUPERBASE_URL,
  SUPERBASE_KEY: process.env.SUPERBASE_KEY,
  NAMESPACE: 'wa_bot',
  BOT_PREFIX: '.',
  ADMIN_IDS: process.env.ADMIN_IDS?.split(',') || [], // comma-separated WhatsApp JIDs
  VULGAR_WORDS: ['bitch', 'fuck', 'shit', 'ass', 'damn'],
  NODE_ENV: process.env.NODE_ENV || 'production',
  TIMEZONE: 'Africa/Lagos'
};
