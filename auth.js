// auth.js
import { isAdminStatic, normalizeJid } from './utils.js';

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
      const participant = metadata.participants.find(p => p.id === cleanJid);

      if (participant) {
        // ✅ Baileys v7 uses boolean flags
        return participant.admin === true || participant.isAdmin === true;
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
    const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const participant = metadata.participants.find(p => p.id === botJid);

    return participant?.admin === true || participant?.isAdmin === true;
  } catch (err) {
    console.error('Bot admin check failed:', err.message);
    return false;
  }
};
