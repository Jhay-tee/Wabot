import { getScheduledLocks, clearUsedLockTime, clearUsedUnlockTime } from './db.js';
import { logger } from './logger.js';
import { getSocket } from './session.js';

export const startScheduler = () => {
  console.log('⏰ Auto Scheduler Started - Checking scheduled locks every minute');

  setInterval(async () => {
    const sock = getSocket();
    if (!sock) {
      logger.warn('Scheduler: Socket not ready yet');
      return;
    }

    try {
      const scheduledLocks = await getScheduledLocks();

      if (!scheduledLocks || scheduledLocks.length === 0) {
        return;
      }

      const now = new Date();

      for (const lock of scheduledLocks) {
        const groupJid = lock.group_jid;

        if (lock.lock_time) {
          const lockTime = new Date(lock.lock_time);
          if (lockTime <= now) {
            try {
              await sock.groupSettingUpdate(groupJid, 'announcement');
              logger.success(`🔒 Auto-locked group: ${groupJid}`);
              await clearUsedLockTime(groupJid);
            } catch (err) {
              logger.error(`Failed to auto-lock group ${groupJid}:`, err.message);
            }
          }
        }

        if (lock.unlock_time) {
          const unlockTime = new Date(lock.unlock_time);
          if (unlockTime <= now) {
            try {
              await sock.groupSettingUpdate(groupJid, 'not_announcement');
              logger.success(`🔓 Auto-unlocked group: ${groupJid}`);
              await clearUsedUnlockTime(groupJid);
            } catch (err) {
              logger.error(`Failed to auto-unlock group ${groupJid}:`, err.message);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Scheduler Error:', error.message);
    }
  }, 60 * 1000);
};
