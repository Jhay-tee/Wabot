import { isAdmin } from './utils.js';
import { getGroupSettings, updateGroupSetting, upsertScheduledLock } from './db.js';
import { logger } from './logger.js';

export const handleCommand = async (message, client, groupJid, senderJid) => {
  if (!message.startsWith('.')) return;

  const [cmd, ...args] = message.slice(1).split(' ');
  if (!isAdmin(senderJid)) return; // only admin commands execute

  logger.info(`Executing command: ${cmd} by ${senderJid}`);

  switch (cmd.toLowerCase()) {
    case 'bot':
      const state = args[0]?.toLowerCase() === 'on';
      await updateGroupSetting(groupJid, { bot_active: state });
      client.sendMessage(groupJid, { text: `Bot is now ${state ? 'active' : 'inactive'}.` });
      break;

    case 'lock':
      if (args[0]) await upsertScheduledLock(groupJid, args[0], null);
      await client.groupSettingUpdate(groupJid, 'locked');
      client.sendMessage(groupJid, { text: `Group locked.` });
      break;

    case 'unlock':
      if (args[0]) await upsertScheduledLock(groupJid, null, args[0]);
      await client.groupSettingUpdate(groupJid, 'unlocked');
      client.sendMessage(groupJid, { text: `Group unlocked.` });
      break;

    case 'help':
      client.sendMessage(groupJid, { text: `.bot on/off\n.lock [time]\n.unlock [time]\n.kick\n.delete\n.help` });
      break;

    // .kick, .delete will be handled in main event
    default:
      client.sendMessage(groupJid, { text: `Unknown command: ${cmd}` });
  }
};
