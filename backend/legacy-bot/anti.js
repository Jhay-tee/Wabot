// antiSpam.js (or moderation.js)
import { CONFIG } from './config.js';
import { addUserStrike, resetUserStrikes } from './db.js';
import { logger } from './logger.js';

/**
 * Checks for links and applies anti-link rules
 * @returns {Promise<boolean>} - Returns true if action was taken
 */
export const checkAntiLink = async (messageText, isAdmin, groupJid, userJid, client) => {
  if (!messageText || isAdmin) return false;

  const urlRegex = /(https?:\/\/[^\s]+)/i;
  if (!urlRegex.test(messageText)) return false;

  try {
    const strikes = await addUserStrike(groupJid, userJid);
    logger.info(`Anti-Link: Strike ${strikes} added for ${userJid} in ${groupJid}`);

    await client.sendMessage(groupJid, {
      text: `⚠️ @${userJid.split('@')[0]} Links are not allowed in this group!\nYou now have ${strikes} strike(s).`,
      mentions: [userJid],
    });

    if (strikes >= 3) {
      await client.groupParticipantsUpdate(groupJid, [userJid], 'remove');
      logger.warn(`🔨 Removed ${userJid} after reaching 3 strikes (Anti-Link) in ${groupJid}`);

      await resetUserStrikes(groupJid, userJid);
      await client.sendMessage(groupJid, {
        text: `🚫 @${userJid.split('@')[0]} has been removed for repeated link violations.`,
        mentions: [userJid],
      });
    }

    return true;
  } catch (error) {
    logger.error(`Error in checkAntiLink: ${error.message}`);
    return false;
  }
};

/**
 * Checks for vulgar/abusive words
 * @returns {Promise<boolean>} - Returns true if action was taken
 */
export const checkAntiVulgar = async (msg, isAdmin, groupJid, userJid, client) => {
  if (!msg || isAdmin) return false;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  const containsVulgar = CONFIG.VULGAR_WORDS.some((word) =>
    text.toLowerCase().includes(word.toLowerCase())
  );

  if (!containsVulgar) return false;

  try {
    // Delete the vulgar message
    await client.sendMessage(groupJid, { delete: msg.key });

    // Warn the user
    await client.sendMessage(groupJid, {
      text: `❌ @${userJid.split('@')[0]} Vulgar language is not allowed in this group!`,
      mentions: [userJid],
    });

    logger.info(`Anti-Vulgar: Deleted message from ${userJid} in ${groupJid}`);

    // Optional: Add strike logic
    // const strikes = await addUserStrike(groupJid, userJid);
    // if (strikes >= 3) {
    //   await client.groupParticipantsUpdate(groupJid, [userJid], 'remove');
    //   await resetUserStrikes(groupJid, userJid);
    // }

    return true;
  } catch (error) {
    logger.error(`Error in checkAntiVulgar: ${error.message}`);
    return false;
  }
};
