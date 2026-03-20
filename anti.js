import { CONFIG } from './config.js';
import { incrementStrike, resetStrikes } from './db.js';
import { logger } from './logger.js';

export const checkAntiLink = async (message, isAdmin, groupJid, userJid, client) => {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  if (!isAdmin && urlRegex.test(message)) {
    const strikes = await incrementStrike(groupJid, userJid);
    if (strikes >= 3) {
      await client.groupParticipantsUpdate(groupJid, [userJid], 'remove');
      logger.info(`Removed ${userJid} for 3 strikes in ${groupJid}`);
      await resetStrikes(groupJid, userJid);
    }
    return true; // message violates
  }
  return false;
};

export const checkAntiVulgar = async (message, isAdmin, groupJid, userJid, client) => {
  const containsVulgar = CONFIG.VULGAR_WORDS.some((word) => message.toLowerCase().includes(word));
  if (!isAdmin && containsVulgar) {
    await client.sendMessage(groupJid, { text: `@${userJid.split('@')[0]} This kind of message is not allowed in this group.` }, { quoted: null });
    logger.info(`Deleted vulgar message from ${userJid} in ${groupJid}`);
    return true;
  }
  return false;
};
