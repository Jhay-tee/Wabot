import { CONFIG } from './config.js';

export const isAdmin = (jid) => CONFIG.ADMIN_IDS.includes(jid);

export const parseJid = (jid) => jid?.split(':')[0] || jid;

export const formatTime = (date) => {
  return new Date(date).toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE });
};

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
