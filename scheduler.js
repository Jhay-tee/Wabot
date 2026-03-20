import { getScheduledLock } from './db.js';
import { logger } from './logger.js';
import { getSocket } from './session.js';

export const startScheduler = () => {
  setInterval(async () => {
    const client = getSocket();
    if (!client) return;

    // For demonstration, fetch all scheduled locks (you may want to optimize)
    const { data } = await client.supabase.from('group_scheduled_locks').select('*');
    if (!data) return;

    const now = new Date();
    for (const lock of data) {
      if (lock.lock_time && new Date(lock.lock_time) <= now) {
        await client.groupSettingUpdate(lock.group_jid, 'locked');
        logger.info(`Auto-locked group ${lock.group_jid}`);
      }
      if (lock.unlock_time && new Date(lock.unlock_time) <= now) {
        await client.groupSettingUpdate(lock.group_jid, 'unlocked');
        logger.info(`Auto-unlocked group ${lock.group_jid}`);
      }
    }
  }, 60 * 1000); // every minute
};
