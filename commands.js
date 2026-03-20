// commands.js
import { CONFIG } from './config.js';
import {
  addUserStrike,
  resetUserStrikes,
  getGroupSettings,
  setGroupSettings,
  setScheduledLocks,
} from './db.js';
import { formatTime } from './utils.js';

// Helper: Check if user is admin in group
async function isAdminUser(sock, groupJid, userJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => p.id === userJid);
    return participant?.admin !== null && participant?.admin !== undefined;
  } catch (err) {
    console.error('Failed to fetch group metadata for admin check:', err);
    return false;
  }
}

export async function handleCommand(sock, msg) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid?.endsWith('@g.us')) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  if (!text.startsWith(CONFIG.BOT_PREFIX)) return;

  const groupSettings = (await getGroupSettings(groupJid)) || {};
  const isAdmin = await isAdminUser(sock, groupJid, senderJid);

  // Parse command and arguments
  const args = text.slice(CONFIG.BOT_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (!cmd) return;

  console.log(`Executing command: ${cmd} | Args:`, args);

  try {
    switch (cmd) {
      case 'kick': {
        if (!isAdmin) return;
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        
        if (mentioned.length === 0) {
          await sock.sendMessage(groupJid, { text: '❌ Please mention user(s) to kick.' });
          return;
        }

        await sock.groupParticipantsUpdate(groupJid, mentioned, 'remove');
        await sock.sendMessage(groupJid, {
          text: `👢 Removed ${mentioned.map(u => `@${u.split('@')[0]}`).join(', ')}`,
          mentions: mentioned,
        });
        break;
      }

      case 'delete':
        if (!isAdmin) return;
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) {
          await sock.sendMessage(groupJid, { text: '❌ Reply to a message to delete it.' });
          return;
        }
        const messageId = msg.message.extendedTextMessage.contextInfo.stanzaId;
        await sock.sendMessage(groupJid, { delete: messageId });
        break;

      case 'bot': {
        if (!isAdmin) return;
        const active = args[0] === 'on';
        await setGroupSettings(groupJid, { bot_active: active });
        await sock.sendMessage(groupJid, {
          text: `🤖 Bot is now ${active ? '✅ Active' : '❌ Inactive'}`,
        });
        break;
      }

      case 'link': {
        if (!isAdmin) return;
        const linkActive = args[0] === 'on';
        await setGroupSettings(groupJid, { anti_link: linkActive });
        await sock.sendMessage(groupJid, {
          text: `🔗 Anti-link is now ${linkActive ? '✅ Enabled' : '❌ Disabled'}`,
        });
        break;
      }

      case 'lock':
        if (!isAdmin) return;
        await sock.groupSettingUpdate(groupJid, 'announce', true);
        await sock.sendMessage(groupJid, { text: '🔒 Group locked successfully' });
        break;

      case 'unlock':
        if (!isAdmin) return;
        await sock.groupSettingUpdate(groupJid, 'announce', false);
        await sock.sendMessage(groupJid, { text: '🔓 Group unlocked successfully' });
        break;

      case 'locktime': {
        if (!isAdmin) return;
        const timeArg = args.join(' ');
        if (!timeArg) {
          await sock.sendMessage(groupJid, { text: '❌ Please provide lock time in format: `YYYY-MM-DD HH:mm`' });
          return;
        }
        const lockTime = new Date(timeArg);
        if (isNaN(lockTime.getTime())) {
          await sock.sendMessage(groupJid, { text: '❌ Invalid date format. Use: `YYYY-MM-DD HH:mm`' });
          return;
        }
        await setScheduledLocks(groupJid, lockTime.toISOString(), null);
        await sock.sendMessage(groupJid, {
          text: `⏰ Group will auto-lock at ${formatTime(lockTime)}`,
        });
        break;
      }

      case 'unlocktime': {
        if (!isAdmin) return;
        const timeArg = args.join(' ');
        if (!timeArg) {
          await sock.sendMessage(groupJid, { text: '❌ Please provide unlock time in format: `YYYY-MM-DD HH:mm`' });
          return;
        }
        const unlockTime = new Date(timeArg);
        if (isNaN(unlockTime.getTime())) {
          await sock.sendMessage(groupJid, { text: '❌ Invalid date format. Use: `YYYY-MM-DD HH:mm`' });
          return;
        }
        await setScheduledLocks(groupJid, null, unlockTime.toISOString());
        await sock.sendMessage(groupJid, {
          text: `⏰ Group will auto-unlock at ${formatTime(unlockTime)}`,
        });
        break;
      }

      case 'tagall': {
        const metadata = await sock.groupMetadata(groupJid).catch(() => null);
        if (!metadata) {
          await sock.sendMessage(groupJid, { text: '❌ Failed to fetch group members.' });
          return;
        }
        const mentions = metadata.participants.map(p => p.id);
        const mentionText = mentions.map(u => `@${u.split('@')[0]}`).join(' ');

        await sock.sendMessage(groupJid, {
          text: `📢 Tagging all members:\n${mentionText}`,
          mentions,
        });
        break;
      }

      case 'strike': {
        if (!isAdmin) return;
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        
        if (mentioned.length === 0) {
          await sock.sendMessage(groupJid, { text: '❌ Please mention user(s) to strike.' });
          return;
        }

        for (const user of mentioned) {
          const strikes = await addUserStrike(groupJid, user);
          await sock.sendMessage(groupJid, {
            text: `⚠️ @${user.split('@')[0]} now has ${strikes} strike(s).`,
            mentions: [user],
          });
        }
        break;
      }

      case 'resetstrikes': {
        if (!isAdmin) return;
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        
        if (mentioned.length === 0) {
          await sock.sendMessage(groupJid, { text: '❌ Please mention user(s) to reset strikes.' });
          return;
        }

        for (const user of mentioned) {
          await resetUserStrikes(groupJid, user);
          await sock.sendMessage(groupJid, {
            text: `✅ Strikes reset for @${user.split('@')[0]}.`,
            mentions: [user],
          });
        }
        break;
      }

      case 'help': {
        const helpText = `
📖 *Bot Commands* (Prefix: ${CONFIG.BOT_PREFIX})

👮 *Admin Commands:*
• \`.kick @user\` → Remove user
• \`.delete\` (reply to message) → Delete message
• \`.bot on/off\` → Toggle bot
• \`.link on/off\` → Toggle anti-link
• \`.lock\` / \`.unlock\` → Lock/Unlock group
• \`.locktime YYYY-MM-DD HH:mm\` → Schedule auto-lock
• \`.unlocktime YYYY-MM-DD HH:mm\` → Schedule auto-unlock
• \`.strike @user\` → Add strike
• \`.resetstrikes @user\` → Reset strikes

👥 *Everyone:*
• \`.tagall\` → Mention all members
        `.trim();

        await sock.sendMessage(groupJid, { text: helpText });
        break;
      }

      default:
        // Optional: send unknown command message
        // await sock.sendMessage(groupJid, { text: `❓ Unknown command: ${cmd}` });
        break;
    }
  } catch (error) {
    console.error(`Error executing command "${cmd}":`, error);
    await sock.sendMessage(groupJid, { 
      text: '❌ An error occurred while executing the command.' 
    }).catch(() => {});
  }
}