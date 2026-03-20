// commands.js
import { CONFIG } from './config.js';
import {
  addUserStrike,
  resetUserStrikes,
  getGroupSettings,
  setGroupSettings,
  setScheduledLocks
} from './db.js';
import { formatTime } from './utils.js';

// Helper: check if user is admin in group
async function isAdminUser(sock, groupJid, userJid) {
  const metadata = await sock.groupMetadata(groupJid).catch(() => null);
  if (!metadata) return false;
  const participant = metadata.participants.find(p => p.id === userJid);
  return participant?.admin !== null && participant?.admin !== undefined;
}

export async function handleCommand(sock, msg) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid.endsWith('@g.us')) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    '';
  if (!text.startsWith(CONFIG.BOT_PREFIX)) return;

  const groupSettings = (await getGroupSettings(groupJid)) || {};
  const isAdmin = await isAdminUser(sock, groupJid, senderJid);

  const [cmd, ...args] = text.slice(CONFIG.BOT_PREFIX.length).trim().split(/\s+/);
  console.log('Executing command:', cmd, 'Args:', args);

  switch (cmd.toLowerCase()) {
    case 'kick': {
      if (!isAdmin) return;
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      if (mentioned.length > 0) {
        await sock.groupParticipantsUpdate(groupJid, mentioned, 'remove');
        await sock.sendMessage(groupJid, {
          text: `👢 Removed ${mentioned.map(u => `@${u.split('@')[0]}`).join(', ')}`,
          mentions: mentioned
        });
      } else {
        await sock.sendMessage(groupJid, { text: '❌ No user mentioned to kick.' });
      }
      break;
    }

    case 'delete':
      if (!isAdmin) return;
      if (!msg.message?.contextInfo?.quotedMessage) return;
      await sock.sendMessage(groupJid, { delete: msg.message.contextInfo.stanzaId });
      break;

    case 'bot': {
      if (!isAdmin) return;
      const active = args[0] === 'on';
      await setGroupSettings(groupJid, { bot_active: active });
      await sock.sendMessage(groupJid, {
        text: `🤖 Bot is now ${active ? 'active' : 'inactive'}`
      });
      break;
    }

    case 'link': {
      if (!isAdmin) return;
      const linkActive = args[0] === 'on';
      await setGroupSettings(groupJid, { anti_link: linkActive });
      await sock.sendMessage(groupJid, {
        text: `🔗 Anti-link is now ${linkActive ? 'enabled' : 'disabled'}`
      });
      break;
    }

    case 'lock':
      if (!isAdmin) return;
      await sock.groupSettingUpdate(groupJid, { announce: true });
      await sock.sendMessage(groupJid, { text: '🔒 Group locked successfully' });
      break;

    case 'unlock':
      if (!isAdmin) return;
      await sock.groupSettingUpdate(groupJid, { announce: false });
      await sock.sendMessage(groupJid, { text: '🔓 Group unlocked successfully' });
      break;

    case 'locktime': {
      if (!isAdmin) return;
      const timeArg = args[0];
      if (!timeArg) {
        await sock.sendMessage(groupJid, { text: '❌ Please provide a lock time (YYYY-MM-DD HH:mm).' });
        return;
      }
      const lockTime = new Date(timeArg);
      await setScheduledLocks(groupJid, lockTime.toISOString(), null);
      await sock.sendMessage(groupJid, { text: `⏰ Group will auto-lock at ${formatTime(lockTime)}` });
      break;
    }

    case 'unlocktime': {
      if (!isAdmin) return;
      const timeArg = args[0];
      if (!timeArg) {
        await sock.sendMessage(groupJid, { text: '❌ Please provide an unlock time (YYYY-MM-DD HH:mm).' });
        return;
      }
      const unlockTime = new Date(timeArg);
      await setScheduledLocks(groupJid, null, unlockTime.toISOString());
      await sock.sendMessage(groupJid, { text: `⏰ Group will auto-unlock at ${formatTime(unlockTime)}` });
      break;
    }

    case 'tagall': {
      const metadata = await sock.groupMetadata(groupJid).catch(() => null);
      if (!metadata) return;
      const mentions = metadata.participants.map(p => p.id);
      const mentionText = mentions.map(u => `@${u.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, {
        text: `📢 Tagging all members:\n${mentionText}`,
        mentions
      });
      break;
    }

    case 'strike': {
      if (!isAdmin) return;
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      if (mentioned.length > 0) {
        for (const user of mentioned) {
          const strikes = await addUserStrike(groupJid, user);
          await sock.sendMessage(groupJid, {
            text: `⚠️ @${user.split('@')[0]} now has ${strikes} strike(s).`,
            mentions: [user]
          });
        }
      } else {
        await sock.sendMessage(groupJid, { text: '❌ No user mentioned to strike.' });
      }
      break;
    }

    case 'resetstrikes': {
      if (!isAdmin) return;
      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      if (mentioned.length > 0) {
        for (const user of mentioned) {
          await resetUserStrikes(groupJid, user);
          await sock.sendMessage(groupJid, {
            text: `✅ Strikes reset for @${user.split('@')[0]}.`,
            mentions: [user]
          });
        }
      } else {
        await sock.sendMessage(groupJid, { text: '❌ No user mentioned to reset strikes.' });
      }
      break;
    }

    case 'help': {
      const helpText = `
📖 *Bot Commands* (prefix: ${CONFIG.BOT_PREFIX})

👮 Admin only:
- .kick @user → remove user
- .delete (reply) → delete message
- .bot on/off → toggle bot
- .link on/off → toggle anti-link
- .lock / .unlock → lock/unlock group
- .locktime YYYY-MM-DD HH:mm → schedule auto-lock
- .unlocktime YYYY-MM-DD HH:mm → schedule auto-unlock
- .strike @user → add strike
- .resetstrikes @user → reset strikes

👥 Everyone:
- .tagall → mention all members
      `;
      await sock.sendMessage(groupJid, { text: helpText });
      break;
    }

    default:
      break;
  }
}
