// auth.js
import { isAdminStatic, normalizeJid } from './utils.js';

export const isAdmin = async (sock, groupJid, userJid) => {
  const cleanJid = normalizeJid(userJid);

  // Always allow static admins (bot owner IDs from .env)
  if (isAdminStatic(cleanJid)) return true;

  // For groups, check WhatsApp metadata
  if (groupJid?.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const participant = metadata.participants.find(p => p.id === cleanJid);
      return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch (err) {
      console.error('Admin check failed:', err.message);
      return false;
    }
  }

  return false;
};
