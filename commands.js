import { CONFIG } from './config.js';
import {
  addUserStrike,
  resetUserStrikes,
  getGroupSettings,
  setGroupSettings,
  setScheduledLocks,
} from './db.js';
import { formatTime, extractText } from './utils.js';

// Helper: Check if user is admin in group
async function isAdminUser(sock, groupJid, userJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => p.id === userJid);
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (err) {
    console.error('Failed to fetch group metadata for admin check:', err);
    return false;
  }
}

export async function handleCommand(sock, msg) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid?.endsWith('@g.us')) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const text = extractText(msg);

  if (!text.startsWith(CONFIG.BOT_PREFIX)) return;

  const groupSettings = (await getGroupSettings(groupJid)) || {};
  const isAdmin = await isAdminUser(sock, groupJid, senderJid);

  const args = text.slice(CONFIG.BOT_PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;

  console.log(`Executing command: ${cmd} | Args:`, args);

  try {
    switch (cmd) {
      // … all your existing cases unchanged …
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
        break;
    }
  } catch (error) {
    console.error(`Error executing command "${cmd}":`, error);
    await sock.sendMessage(groupJid, { text: '❌ An error occurred while executing the command.' }).catch(() => {});
  }
      }
