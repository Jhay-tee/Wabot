import { isAdminStatic, normalizeJid } from './utils.js';

/**
 * Check if a given user is an admin.
 */
export const isAdmin = async (sock, groupJid, userJid) => {
  const cleanJid = normalizeJid(userJid);

  // ✅ Always allow static admins (bot owner IDs from .env)
  if (isAdminStatic(cleanJid)) return true;

  // ✅ For groups, check WhatsApp metadata
  if (groupJid?.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(groupJid);
      const participant = metadata.participants.find(
        p => normalizeJid(p.id) === cleanJid
      );

      return ['admin', 'superadmin'].includes(participant?.admin);
    } catch (err) {
      console.error('Admin check failed:', err.message);
      return false;
    }
  }

  return false;
};

/**
 * Check if the bot itself is an admin in the group.
 */
export const isBotAdmin = async (sock, groupJid) => {
  if (!groupJid?.endsWith('@g.us')) return false;
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const botJid = normalizeJid(sock.user.id);

    const participant = metadata.participants.find(
      p => normalizeJid(p.id) === botJid
    );

    return ['admin', 'superadmin'].includes(participant?.admin);
  } catch (err) {
    console.error('Bot admin check failed:', err.message);
    return false;
  }
};
