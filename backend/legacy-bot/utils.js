// utils.js
import { CONFIG } from './config.js';

/**
 * Check if a user is a static admin (bot owner)
 * @param {string} jid - User JID
 * @returns {boolean}
 */
export const isAdminStatic = (jid) => {
  if (!jid || !CONFIG.ADMIN_IDS || !Array.isArray(CONFIG.ADMIN_IDS)) return false;
  return CONFIG.ADMIN_IDS.includes(jid) || CONFIG.ADMIN_IDS.includes(parseJid(jid));
};

/**
 * Parse JID to remove device ID and server part
 * Example: 2348105686810:82@s.whatsapp.net → 2348105686810@s.whatsapp.net
 * @param {string} jid
 * @returns {string}
 */
export const parseJid = (jid) => {
  if (!jid) return '';
  // Remove device ID (e.g., :82) and keep only number@s.whatsapp.net
  return jid.split(':')[0] || jid;
};

/**
 * Format date/time according to config timezone
 * @param {Date|string} date
 * @returns {string}
 */
export const formatTime = (date) => {
  if (!date) return 'Invalid Date';
  
  try {
    return new Date(date).toLocaleString('en-US', {
      timeZone: CONFIG.TIMEZONE || 'Africa/Lagos',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch (err) {
    console.warn('Invalid date in formatTime:', date);
    return new Date(date).toLocaleString();
  }
};

/**
 * Simple delay utility
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
export const delay = (ms) => 
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clean and normalize JID
 * @param {string} jid
 * @returns {string}
 */
export const normalizeJid = (jid) => {
  if (!jid) return '';
  let cleaned = jid.trim();
  if (!cleaned.endsWith('@s.whatsapp.net') && !cleaned.endsWith('@g.us')) {
    cleaned += '@s.whatsapp.net';
  }
  return cleaned;
};

/**
 * Check if a JID is a group
 * @param {string} jid
 * @returns {boolean}
 */
export const isGroup = (jid) => jid?.endsWith('@g.us') || false;

/**
 * Check if a JID is a user (private chat)
 * @param {string} jid
 * @returns {boolean}
 */
export const isUser = (jid) => jid?.endsWith('@s.whatsapp.net') || false;

export default {
  isAdminStatic,
  parseJid,
  formatTime,
  delay,
  normalizeJid,
  isGroup,
  isUser,
};