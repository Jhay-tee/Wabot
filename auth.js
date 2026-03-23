import { isAdminStatic, normalizeJid, parseJid } from './utils.js';

/**
 * Check if a given user is an admin.
 * - Static admins (from .env) are always treated as admins.
 * - For groups, checks WhatsApp metadata to see if the user is admin.
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
        p => parseJid(p.id) === parseJid(cleanJid)
      );

      if (participant) {
        // Baileys v7: admin is a string ('admin' or 'superadmin')
        return participant.admin === 'admin' || participant.admin === 'superadmin';
      }
      return false;
    } catch (err) {
      console.error('Admin check failed:', err.message);
      return false;
    }
  }

  return false;
};

/**
 * Check if the bot itself is an admin in the group.
 * - Returns true only if the bot’s JID is marked as admin in group metadata.
 * - If not a group, returns false.
 */
export const isBotAdmin = async (sock, groupJid) => {
  if (!groupJid?.endsWith('@g.us')) return false;
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const botJid = parseJid(sock.user.id) + '@s.whatsapp.net';
    const participant = metadata.participants.find(
      p => parseJid(p.id) === parseJid(botJid)
    );

    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (err) {
    console.error('Bot admin check failed:', err.message);
    return false;
  }
};
