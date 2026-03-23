import { CONFIG } from './config.js';

/**
 * Extract text from a WhatsApp message, unwrapping ephemeral/viewOnce/interactive containers
 * @param {object} msg - Baileys message object
 * @returns {string}
 */
export const extractText = (msg) => {
  const innerMsg = msg.message?.ephemeralMessage?.message 
                || msg.message?.viewOnceMessage?.message 
                || msg.message;

  return (
    innerMsg?.conversation ||
    innerMsg?.extendedTextMessage?.text ||
    innerMsg?.imageMessage?.caption ||
    innerMsg?.videoMessage?.caption ||
    innerMsg?.buttonsResponseMessage?.selectedButtonId ||
    innerMsg?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
};

/**
 * Check if a user is a static admin (bot owner)
 */
export const isAdminStatic = (jid) => {
  if (!jid || !CONFIG.ADMIN_IDS || !Array.isArray(CONFIG.ADMIN_IDS)) return false;
  return CONFIG.ADMIN_IDS.includes(jid) || CONFIG.ADMIN_IDS.includes(parseJid(jid));
};

export const parseJid = (jid) => {
  if (!jid) return '';
  return jid.split(':')[0] || jid;
};

export const formatTime = (date) => {
  if (!date) return 'Invalid Date';
  try {
    return new Date(date).toLocaleString('en-US', {
      timeZone: CONFIG.TIMEZONE || 'Africa/Lagos',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(date).toLocaleString();
  }
};

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const normalizeJid = (jid) => {
  if (!jid) return '';
  let cleaned = jid.trim();
  if (!cleaned.endsWith('@s.whatsapp.net') && !cleaned.endsWith('@g.us')) {
    cleaned += '@s.whatsapp.net';
  }
  return cleaned;
};

export const isGroup = (jid) => jid?.endsWith('@g.us') || false;
export const isUser = (jid) => jid?.endsWith('@s.whatsapp.net') || false;

export default {
  extractText,
  isAdminStatic,
  parseJid,
  formatTime,
  delay,
  normalizeJid,
  isGroup,
  isUser,
};
