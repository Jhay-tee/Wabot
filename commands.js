// commands.js
import { addUserStrike, resetUserStrikes, getGroupSettings, setGroupSettings } from './db.js';

const vulgarWords = ['bitch', 'fuck', 'shit', 'asshole']; // extend as needed

export async function handleCommand(sock, msg) {
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const groupJid = msg.key.remoteJid;
  const isGroup = groupJid.endsWith('@g.us');

  const groupSettings = await getGroupSettings(groupJid) || {};

  // Only handle commands if bot is active
  if (groupSettings.bot_active === false && text.startsWith('.')) {
    await sock.sendMessage(groupJid, { text: 'Bot is inactive. Use .bot on to activate.' }, { quoted: msg });
    return;
  }

  // Anti-vulgar check (skip admin)
  const isAdmin = false; // TODO: fetch admin status if needed
  if (!isAdmin && groupSettings.anti_vulgar) {
    const lower = text.toLowerCase();
    if (vulgarWords.some(w => lower.includes(w))) {
      await sock.sendMessage(groupJid, { text: `@${senderJid.split('@')[0]} This message is not allowed in this group.`, mentions: [senderJid] }, { quoted: msg });
      await sock.sendMessage(groupJid, { delete: msg.key });
      return;
    }
  }

  // Admin commands
  if (!text.startsWith('.')) return; // ignore non-commands
  console.log('Executing command:', text, 'from', senderJid);

  const [cmd, arg] = text.slice(1).split(' ');

  switch (cmd) {
    case 'kick':
      if (!isAdmin) return;
      // TODO: Implement remove participant logic
      console.log('Kick command:', arg);
      break;
    case 'delete':
      if (!isAdmin) return;
      if (!msg.message?.contextInfo?.quotedMessage) return;
      await sock.sendMessage(groupJid, { delete: msg.message.contextInfo.stanzaId });
      console.log('Delete command executed');
      break;
    case 'bot':
      if (!isAdmin) return;
      const active = arg === 'on';
      await setGroupSettings(groupJid, { bot_active: active });
      await sock.sendMessage(groupJid, { text: `Bot is now ${active ? 'active' : 'inactive'}` });
      break;
    case 'link':
      if (!isAdmin) return;
      const linkActive = arg === 'on';
      await setGroupSettings(groupJid, { anti_link: linkActive });
      break;
    case 'lock':
      if (!isAdmin) return;
      // TODO: implement group lock
      break;
    case 'unlock':
      if (!isAdmin) return;
      // TODO: implement group unlock
      break;
  }
                             }
