// antiSpam.js  (or moderation.js)
import { CONFIG } from './config.js';
import {
  addUserStrike,
  resetUserStrikes,
} from './db.js';
import { logger } from './logger.js';

/**
 * Checks for links and applies anti-link rules
 * @returns {Promise<boolean>} - Returns true if action was taken
 */
export const checkAntiLink = async (message, isAdmin, groupJid, userJid, client) => {
  if (!message || isAdmin) return false;

  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  if (!urlRegex.test(message)) return false;

  try {
    const strikes = await addUserStrike(groupJid, userJid);
    logger.info(`Anti-Link: Strike ${strikes} added for ${userJid} in ${groupJid}`);

    // Send warning message
    await client.sendMessage(groupJid, {
      text: `⚠️ @${userJid.split('@')[0]} Links are not allowed in this group!\nYou now have ${strikes} strike(s).`,
      mentions: [userJid],
    });

    // Kick after 3 strikes
    if (strikes >= 3) {
      await client.groupParticipantsUpdate(groupJid, [userJid], 'remove');
      logger.warn(`🔨 Removed ${userJid} after reaching 3 strikes (Anti-Link) in ${groupJid}`);

      await resetUserStrikes(groupJid, userJid);
      await client.sendMessage(groupJid, {
        text: `🚫 ${userJid.split('@')[0]} has been removed for repeated link violations.`,
        mentions: [userJid],
      });
    }

    return true; // Action was taken
  } catch (error) {
    logger.error(`Error in checkAntiLink: ${error.message}`);
    return false;
  }
};

/**
 * Checks for vulgar/abusive words
 * @returns {Promise<boolean>} - Returns true if action was taken
 */
export const checkAntiVulgar = async (message, isAdmin, groupJid, userJid, client) => {
  if (!message || isAdmin) return false;

  const containsVulgar = CONFIG.VULGAR_WORDS.some((word) =>
    message.toLowerCase().includes(word.toLowerCase())
  );

  if (!containsVulgar) return false;

  try {
    // Delete the vulgar message
    await client.sendMessage(groupJid, { delete: message.key });

    // Warn the user
    await client.sendMessage(
      groupJid,
      {
        text: `❌ @${userJid.split('@')[0]} Vulgar language is not allowed in this group!`,
        mentions: [userJid],
      },
      { quoted: null }
    );

    logger.info(`Anti-Vulgar: Deleted message from ${userJid} in ${groupJid}`);

    // Optional: Add a strike for vulgar language too
    // const strikes = await addUserStrike(groupJid, userJid);
    // if (strikes >= 3) { ... kick logic }

    return true; // Action was taken
  } catch (error) {
    logger.error(`Error in checkAntiVulgar: ${error.message}`);
    return false;
  }
};