// utils.js

import { CONFIG } from './config.js';

/**
 * Extract text from a WhatsApp message, unwrapping ephemeral/viewOnce/interactive containers
 * @param {object} msg - Baileys message object
 * @returns {string}
 */
export const extractText = (msg) => {
  // Unwrap ephemeral/viewOnce containers
  const innerMsg =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message;

  // ✅ Cover all common message types
  return (
    innerMsg?.conversation || // plain typed text
    innerMsg?.extendedTextMessage?.text || // replies/quotes
    innerMsg?.ephemeralMessage?.message?.extendedTextMessage?.text || // nested case
    innerMsg?.imageMessage?.caption || // image with caption
    innerMsg?.videoMessage?.caption || // video with caption
    innerMsg?.documentMessage?.caption || // document with caption
    innerMsg?.audioMessage?.caption || // audio with caption
    innerMsg?.stickerMessage?.caption || // sticker with caption
    innerMsg?.buttonsResponseMessage?.selectedButtonId || // button press
    innerMsg?.listResponseMessage?.singleSelectReply?.selectedRowId || // list selection
    innerMsg?.templateButtonReplyMessage?.selectedId || // template button reply
    innerMsg?.pollUpdateMessage?.pollCreationMessage?.name || // poll name
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

/**
 * Format ISO date/time string into human-friendly text
 */
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

/**
 * Parse user input like "6:30pm" into a Date object
 * Returns a Date scheduled for today or tomorrow if time has passed
 */
export const parseTimeString = (input) => {
  const now = new Date();
  const match = input.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!match) return null;

  let [ , hour, minute, meridian ] = match;
  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);

  if (meridian.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (meridian.toLowerCase() === 'am' && hour === 12) hour = 0;

  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);

  // If time has already passed today, schedule for tomorrow
  if (scheduled <= now) {
    scheduled.setDate(scheduled.getDate() + 1);
  }

  return scheduled;
};

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalize JIDs so comparisons always succeed
 */
export const normalizeJid = (jid) => {
  if (!jid) return '';
  let cleaned = jid.split(':')[0].trim();

  // Convert @c.us → @s.whatsapp.net
  if (cleaned.endsWith('@c.us')) {
    cleaned = cleaned.replace('@c.us', '@s.whatsapp.net');
  }

  // Default to user JID if no suffix
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
  parseTimeString,
  delay,
  normalizeJid,
  isGroup,
  isUser,
};
