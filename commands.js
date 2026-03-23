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

  // ✅ Use remoteJid directly instead of groupMetadata.id
  const groupJid = msg.key.remoteJid;
  const senderJid = msg.key.participant || msg.key.remoteJid;

  // ✅ Only run in groups
  if (!groupJid.endsWith('@g.us')) return;

  // Dynamic group admin check
  const isAdminFlag = await isAdmin(sock, groupJid, senderJid);

  // ✅ Allow safe commands for everyone, enforce admin for sensitive ones
  const publicCommands = ['help', 'menu', 'ping'];
  if (!isAdminFlag && !publicCommands.includes(cmd.toLowerCase())) {
    return;
  }

  switch (cmd.toLowerCase()) {
    case 'bot':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { bot_active: true });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been activated' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { bot_active: false });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been deactivated' });
      }
      break;

    case 'link':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { anti_link: true });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { anti_link: false });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link disabled' });
      }
      break;

    case 'vulgar':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { vulgar_filter: true });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { vulgar_filter: false });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter disabled' });
      }
      break;

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

    case 'lockclear':
      await clearUsedLockTime(groupJid);
      await sock.sendMessage(groupJid, { text: '🗑️ Scheduled lock time cleared' });
      break;

    case 'unlockclear':
      await clearUsedUnlockTime(groupJid);
      await sock.sendMessage(groupJid, { text: '🗑️ Scheduled unlock time cleared' });
      break;

    case 'kick':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to kick them' });
        return;
      }
      const kickTarget = msg.message.extendedTextMessage.contextInfo.participant;
      await sock.groupParticipantsUpdate(groupJid, [kickTarget], 'remove');
      await sock.sendMessage(groupJid, { text: `👢 User ${kickTarget} has been removed` });
      break;

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

    case 'strike':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to strike them' });
        return;
      }
      const target = msg.message.extendedTextMessage.contextInfo.participant;
      const strikes = await addUserStrike(groupJid, target);
      await sock.sendMessage(groupJid, { text: `⚠️ Strike added to ${target}. Total strikes: ${strikes}` });
      break;

    case 'resetstrikes':
      if (!msg.message?.extendedTextMessage?.contextInfo?.participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user to reset their strikes' });
        return;
      }
      const resetTarget = msg.message.extendedTextMessage.contextInfo.participant;
      await resetUserStrikes(groupJid, resetTarget);
      await sock.sendMessage(groupJid, { text: `✅ Strikes reset for ${resetTarget}` });
      break;

    case 'tagall':
      const mentions = groupMetadata.participants.map(p => p.id);
      const mentionText = mentions.map(m => `@${m.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, { text: mentionText, mentions });
      break;

    case 'help':
      await sock.sendMessage(groupJid, {
        text: `📖 Available Commands:
- .help (everyone)
- .menu (everyone)
- .ping (everyone)
- .bot on/off (admin)
- .link on/off (admin)
- .vulgar on/off (admin)
- .lock [time] (admin)
- .unlock [time] (admin)
- .lockclear (admin)
- .unlockclear (admin)
- .kick (admin, reply to user)
- .delete (admin, reply to message)
- .strike (admin, reply to user)
- .resetstrikes (admin, reply to user)
- .tagall (admin)`
      });
      break;

    case 'ping':
      await sock.sendMessage(groupJid, { text: 'pong!' });
      break;

    case 'menu':
      await sock.sendMessage(groupJid, { text: '📋 Menu: .help, .ping, .lock, .unlock, .kick, etc.' });
      break;

    default:
      break;
  }
};
