import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import pino from 'pino';
import { join } from 'path';
import { mkdirSync, existsSync, promises as fs } from 'fs';
import { getSession, saveSession, clearSession } from './db.js';

const AUTH_DIR = join(process.cwd(), 'auth_info_baileys');

let socketInstance = null;
let isConnecting = false;

// =========================
// ⏱️ BACKUP CONTROL
// =========================
let backupTimer = null;
let lastBackupHash = null;

// 🔒 prevent reconnect stacking
let reconnectTimeout = null;

// =========================
// 🧠 STABLE HASH
// =========================
function createHash(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// =========================
// ☁️ SMART BACKUP
// =========================
async function backupToSupabase() {
  try {
    if (!existsSync(AUTH_DIR)) return;

    const files = await fs.readdir(AUTH_DIR);
    if (files.length === 0) return;

    const backup = {};

    for (const file of files) {
      const raw = await fs.readFile(join(AUTH_DIR, file), 'utf-8');

      try {
        backup[file] = JSON.parse(raw);
      } catch {
        backup[file] = raw;
      }
    }

    const newHash = createHash(backup);

    if (newHash === lastBackupHash) return;

    lastBackupHash = newHash;

    await saveSession({ files: backup });

    console.log('☁️ Backup saved');
  } catch (err) {
    console.error('backup failed:', err.message);
  }
}

// =========================
// ⏳ DEBOUNCE
// =========================
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);

  backupTimer = setTimeout(() => {
    backupToSupabase();
  }, 10000);
}

// =========================
// 🔄 RESTORE
// =========================
async function restoreFromSupabase() {
  try {
    const saved = await getSession();

    if (!saved?.files || Object.keys(saved.files).length === 0) {
      console.warn('⚠️ No backup found');
      return false;
    }

    mkdirSync(AUTH_DIR, { recursive: true });

    for (const [filename, content] of Object.entries(saved.files)) {
      const data =
        typeof content === 'object'
          ? JSON.stringify(content, null, 2)
          : content;

      await fs.writeFile(join(AUTH_DIR, filename), data, 'utf-8');
    }

    console.log('✅ Restored session');
    return true;
  } catch (err) {
    console.error('restore failed:', err.message);
    return false;
  }
}

// =========================
// 📁 ENSURE AUTH
// =========================
async function ensureAuthDir() {
  mkdirSync(AUTH_DIR, { recursive: true });

  const credPath = join(AUTH_DIR, 'creds.json');

  if (!existsSync(credPath)) {
    console.log('🔍 No local auth → restoring...');
    await restoreFromSupabase();
  }
}

// =========================
// 🔁 RECONNECT LOGIC
// =========================
let reconnectAttempts = 0;

function shouldReconnect(statusCode) {
  if (statusCode === 401) return false; // logged out
  return true;
}

// =========================
// 🚀 INIT SESSION
// =========================
export const initSession = async () => {
  if (isConnecting) return socketInstance;
  isConnecting = true;

  try {
    await ensureAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1029030078],
    }));

    console.log('📡 WA version:', version.join('.'));

    // 🧹 CLEAN OLD SOCKET
    if (socketInstance) {
      try {
        socketInstance.end();
      } catch {}
    }

    socketInstance = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: true,
    });

    // =========================
    // 💾 SAVE CREDS
    // =========================
    socketInstance.ev.on('creds.update', async () => {
      await saveCreds();

      // only backup when stable
      if (!isConnecting) {
        scheduleBackup();
      }
    });

    // =========================
    // 🔌 CONNECTION EVENTS
    // =========================
    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // 🔳 QR for frontend
      if (qr) {
        socketInstance.qrString = qr;
        console.log('📷 QR updated');
      }

      // ✅ CONNECTED
      if (connection === 'open') {
        console.log('✅ Connected');
        isConnecting = false;
        reconnectAttempts = 0;

        await saveCreds();
        scheduleBackup();
      }

      // ❌ DISCONNECTED
      if (connection === 'close') {
        isConnecting = false;

        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : lastDisconnect?.error?.statusCode ?? 'unknown';

        console.log(`❌ Closed (code: ${statusCode})`);

        // 🔒 LOGGED OUT
        if (statusCode === 401) {
          console.log('🔒 Logged out → clearing session');

          try {
            await fs.rm(AUTH_DIR, { recursive: true, force: true });
          } catch {}

          await clearSession();
          return;
        }

        // 🔁 SAFE RECONNECT
        if (shouldReconnect(statusCode)) {
          reconnectAttempts++;

          const delayTime = Math.min(10000, reconnectAttempts * 2000);

          console.log(`🔁 Reconnecting in ${delayTime / 1000}s...`);

          if (reconnectTimeout) clearTimeout(reconnectTimeout);

          reconnectTimeout = setTimeout(() => {
            initSession();
          }, delayTime);
        }
      }
    });

    return socketInstance;

  } catch (err) {
    console.error('❌ init failed:', err);
    isConnecting = false;
    throw err;
  }
};

// =========================
// 📡 GET SOCKET
// =========================
export const getSocket = () => socketInstance;
