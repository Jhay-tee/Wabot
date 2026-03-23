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
        return; // Nothing to process
      }

      const now = new Date();

      for (const lock of scheduledLocks) {
        const groupJid = lock.group_jid;

        // ==================== AUTO LOCK ====================
        if (lock.lock_time) {
          const lockTime = new Date(lock.lock_time); // ISO string → Date

          if (lockTime <= now) {
            try {
              await sock.groupSettingUpdate(groupJid, { announce: true }); // lock group
              logger.success(`🔒 Auto-locked group: ${groupJid}`);

              await clearUsedLockTime(groupJid); // clear so it doesn’t repeat
            } catch (err) {
              logger.error(`Failed to auto-lock group ${groupJid}:`, err.message);
            }
          }
        }

        // ==================== AUTO UNLOCK ====================
        if (lock.unlock_time) {
          const unlockTime = new Date(lock.unlock_time); // ISO string → Date

          if (unlockTime <= now) {
            try {
              await sock.groupSettingUpdate(groupJid, { announce: false }); // unlock group
              logger.success(`🔓 Auto-unlocked group: ${groupJid}`);

              await clearUsedUnlockTime(groupJid); // clear so it doesn’t repeat
            } catch (err) {
              logger.error(`Failed to auto-unlock group ${groupJid}:`, err.message);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Scheduler Error:', error.message);
    }
  }, 60 * 1000); // Every 1 minute
};
