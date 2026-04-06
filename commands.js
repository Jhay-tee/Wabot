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
  normalizeJid,
} from './utils.js';
import { isAdmin, getGroupMetadata } from './auth.js';

export const handleCommand = async (sock, msg, groupMetadata) => {
  const text = extractText(msg).trim();
  if (!text.startsWith('.')) return;

  const groupJid = msg.key.remoteJid;

  if (!groupJid?.endsWith('@g.us')) return;

  const senderJid = normalizeJid(msg.key.participant || msg.key.remoteJid);
  const [rawCmd, ...args] = text.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = args.join(' ');

  const publicCommands = ['help', 'menu', 'ping'];

  const isAdminFlag = await isAdmin(sock, groupJid, senderJid);

  if (!isAdminFlag && !publicCommands.includes(cmd)) {
    return;
  }

  const meta = groupMetadata || await getGroupMetadata(sock, groupJid);

  switch (cmd) {
    case 'bot':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { bot_active: true });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been activated' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { bot_active: false });
        await sock.sendMessage(groupJid, { text: '🤖 Bot has been deactivated' });
      } else {
        await sock.sendMessage(groupJid, { text: '⚠️ Usage: .bot on / .bot off' });
      }
      break;

    case 'link':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { anti_link: true });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { anti_link: false });
        await sock.sendMessage(groupJid, { text: '🔗 Anti-link disabled' });
      } else {
        await sock.sendMessage(groupJid, { text: '⚠️ Usage: .link on / .link off' });
      }
      break;

    case 'vulgar':
      if (arg === 'on') {
        await setGroupSettings(groupJid, { vulgar_filter: true });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter enabled' });
      } else if (arg === 'off') {
        await setGroupSettings(groupJid, { vulgar_filter: false });
        await sock.sendMessage(groupJid, { text: '🛑 Vulgar filter disabled' });
      } else {
        await sock.sendMessage(groupJid, { text: '⚠️ Usage: .vulgar on / .vulgar off' });
      }
      break;

    case 'lock':
      if (!arg) {
        try {
          await sock.groupSettingUpdate(groupJid, 'announcement');
          await sock.sendMessage(groupJid, { text: '🔒 Group locked — only admins can send messages' });
        } catch (err) {
          await sock.sendMessage(groupJid, { text: '⚠️ Failed to lock group (make sure I am an admin)' });
        }
      } else {
        const parsed = parseTimeString(arg);
        if (!parsed) {
          await sock.sendMessage(groupJid, { text: '⚠️ Please specify a valid time e.g. .lock 6:30pm' });
        } else {
          await setScheduledLocks(groupJid, parsed.toISOString(), null);
          await sock.sendMessage(groupJid, { text: `⏰ Auto lock scheduled for ${formatTime(parsed)}` });
        }
      }
      break;

    case 'unlock':
      if (!arg) {
        try {
          await sock.groupSettingUpdate(groupJid, 'not_announcement');
          await sock.sendMessage(groupJid, { text: '🔓 Group unlocked — everyone can send messages' });
        } catch (err) {
          await sock.sendMessage(groupJid, { text: '⚠️ Failed to unlock group (make sure I am an admin)' });
        }
      } else {
        const parsed = parseTimeString(arg);
        if (!parsed) {
          await sock.sendMessage(groupJid, { text: '⚠️ Please specify a valid time e.g. .unlock 6:30am' });
        } else {
          await setScheduledLocks(groupJid, null, parsed.toISOString());
          await sock.sendMessage(groupJid, { text: `⏰ Auto unlock scheduled for ${formatTime(parsed)}` });
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

    case 'kick': {
      const kickTarget = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!kickTarget) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user\'s message to kick them' });
        break;
      }
      try {
        await sock.groupParticipantsUpdate(groupJid, [kickTarget], 'remove');
        await sock.sendMessage(groupJid, { text: `👢 Removed @${kickTarget.split('@')[0]}`, mentions: [kickTarget] });
      } catch (err) {
        await sock.sendMessage(groupJid, { text: '⚠️ Failed to kick user (make sure I am an admin)' });
      }
      break;
    }

    case 'delete': {
      const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
      const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!stanzaId || !participant) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a message to delete it' });
        break;
      }
      try {
        await sock.sendMessage(groupJid, {
          delete: { remoteJid: groupJid, fromMe: false, id: stanzaId, participant },
        });
      } catch (err) {
        await sock.sendMessage(groupJid, { text: '⚠️ Failed to delete message (make sure I am an admin)' });
      }
      break;
    }

    case 'strike': {
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!target) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user\'s message to strike them' });
        break;
      }
      const strikes = await addUserStrike(groupJid, target);
      await sock.sendMessage(groupJid, {
        text: `⚠️ Strike issued to @${target.split('@')[0]}. Total: ${strikes ?? '?'}`,
        mentions: [target],
      });
      break;
    }

    case 'resetstrikes': {
      const resetTarget = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!resetTarget) {
        await sock.sendMessage(groupJid, { text: '⚠️ Reply to a user\'s message to reset their strikes' });
        break;
      }
      await resetUserStrikes(groupJid, resetTarget);
      await sock.sendMessage(groupJid, {
        text: `✅ Strikes reset for @${resetTarget.split('@')[0]}`,
        mentions: [resetTarget],
      });
      break;
    }

    case 'tagall': {
      if (!meta) {
        await sock.sendMessage(groupJid, { text: '⚠️ Could not fetch group members' });
        break;
      }
      const mentions = meta.participants.map(p => p.id);
      const mentionText = mentions.map(m => `@${m.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, { text: mentionText, mentions });
      break;
    }

    case 'help':
    case 'menu':
      await sock.sendMessage(groupJid, {
        text: `📖 *Wabot Commands*\n\n*Everyone:*\n• .help / .menu\n• .ping\n\n*Admins only:*\n• .bot on/off\n• .link on/off\n• .vulgar on/off\n• .lock [6:30pm]\n• .unlock [6:30am]\n• .lockclear\n• .unlockclear\n• .kick (reply to user)\n• .delete (reply to message)\n• .strike (reply to user)\n• .resetstrikes (reply to user)\n• .tagall`,
      });
      break;

    case 'ping':
      await sock.sendMessage(groupJid, { text: '🏓 pong!' });
      break;

    default:
      break;
  }
};
