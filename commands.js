import {
  setGroupSettings,
  addUserStrike,
  resetUserStrikes,
  setScheduledLocks,
  clearUsedLockTime,
  clearUsedUnlockTime,
} from './db.js';
import {
  extractText,
  formatTime,
  parseTimeString,
} from './utils.js';
import { isAdmin } from './auth.js';

/**
 * Handle incoming group commands
 */
export const handleCommand = async (sock, msg, groupMetadata) => {
  const text = extractText(msg).trim();
  if (!text.startsWith('.')) return;

  const [cmd, ...args] = text.slice(1).split(/\s+/);
  const arg = args.join(' ');
  const groupJid = groupMetadata.id;
  const senderJid = msg.key.participant || msg.key.remoteJid;

  // Dynamic group admin check
  const isAdminFlag = await isAdmin(sock, groupJid, senderJid);

  // ✅ Allow .help for everyone, enforce admin for others
  if (!isAdminFlag && cmd.toLowerCase() !== 'help') return;

  switch (cmd.toLowerCase()) {
    // ──────────────── BOT ON/OFF ────────────────
    case 'bot':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { bot_active: true });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been activated' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { bot_active: false });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been deactivated' });
      }
      break;

    // ──────────────── ANTI-LINK ────────────────
    case 'link':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { anti_link: true });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { anti_link: false });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link disabled' });
      }
      break;

    // ──────────────── VULGAR FILTER ────────────────
    case 'vulgar':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { vulgar_filter: true });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { vulgar_filter: false });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter disabled' });
      }
      break;

    // ──────────────── LOCK GROUP ────────────────
    case 'lock':
      if (!arg) {
        await sock.groupSettingUpdate(groupJid, { announce: true });
        await sock.sendMessage(groupJid, { text: '🔒 Group locked immediately' });
      } else {
        const parsed = parseTimeString(arg);
        if (!parsed) {
          await sock.sendMessage(groupJid, { text: '⚠️ Please specify a valid time (e.g. 6:30pm)' });
        } else {
          await setScheduledLocks(groupJid, parsed.toISOString(), null);
          await sock.sendMessage(groupJid, { text: `⏰ Auto lock has been set to ${formatTime(parsed)}` });
        }
      }
      break;

    // ──────────────── UNLOCK GROUP ────────────────
    case 'unlock':
      if (!arg) {
        await sock.groupSettingUpdate(groupJid, { announce: false });
        await sock.sendMessage(groupJid, { text: '🔓 Group unlocked immediately' });
      } else {
        const parsed = parseTimeString(arg);
        if (!parsed) {
          await sock.sendMessage(groupJid, { text: '⚠️ Please specify a valid time (e.g. 6:30am)' });
        } else {
          await setScheduledLocks(groupJid, null, parsed.toISOString());
          await sock.sendMessage(groupJid, { text: `⏰ Auto unlock has been set to ${formatTime(parsed)}` });
        }
      }
      break;

    // ──────────────── CLEAR LOCK ────────────────
    case 'lockclear':
      await clearUsedLockTime(groupJid);
      await sock.sendMessage(groupJid, { text: '🗑️ Scheduled lock time cleared' });
      break;

    // ──────────────── CLEAR UNLOCK ────────────────
    case 'unlockclear':
      await clearUsedUnlockTime(groupJid);
      await sock.sendMessage(groupJid, { text: '🗑️ Scheduled unlock time cleared' });
      break;

    // ──────────────── KICK USER ────────────────
    case 'kick':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to kick them' });
        return;
      }
      const kickTarget = msg.message.extendedTextMessage.contextInfo.participant;
      await sock.groupParticipantsUpdate(groupJid, [kickTarget], 'remove');
      await sock.sendMessage(groupJid, { text: `👢 User ${kickTarget} has been removed` });
      break;

    // ──────────────── DELETE MESSAGE ────────────────
    case 'delete':
      try {
        const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (stanzaId && participant) {
          await sock.sendMessage(groupJid, {
            delete: { remoteJid: groupJid, fromMe: false, id: stanzaId, participant },
          });
        } else {
          await sock.sendMessage(groupJid, { text: '⚠️ Reply to a message to delete it' });
        }
      } catch (err) {
        console.error('Delete failed:', err.message);
      }
      break;

    // ──────────────── STRIKE USER ────────────────
    case 'strike':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to strike them' });
        return;
      }
      const target = msg.message.extendedTextMessage.contextInfo.participant;
      const strikes = await addUserStrike(groupJid, target);
      await sock.sendMessage(groupJid, { text: `⚠️ Strike added to ${target}. Total strikes: ${strikes}` });
      break;

    // ──────────────── RESET STRIKES ────────────────
    case 'resetstrikes':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to reset their strikes' });
        return;
      }
      const resetTarget = msg.message.extendedTextMessage.contextInfo.participant;
      await resetUserStrikes(groupJid, resetTarget);
      await sock.sendMessage(groupJid, { text: `✅ Strikes reset for ${resetTarget}` });
      break;

    // ──────────────── TAG ALL ────────────────
    case 'tagall':
      const mentions = groupMetadata.participants.map(p => p.id);
      const mentionText = mentions.map(m => `@${m.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, { text: mentionText, mentions });
      break;

    // ──────────────── HELP ────────────────
    case 'help':
      await sock.sendMessage(groupJid, {
        text: `📖 Available Commands:
- .bot on/off
- .link on/off
- .vulgar on/off
- .lock [time] (or immediate)
- .unlock [time] (or immediate)
- .lockclear (cancel scheduled lock)
- .unlockclear (cancel scheduled unlock)
- .kick (reply to user)
- .delete (reply to message)
- .strike (reply to user)
- .resetstrikes (reply to user)
- .tagall
- .help`
      });
      break;

    default:
      break;
  }
};
