// session.js
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState, // ← recommended helper in v7
  Browsers,              // ← better browser constants
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import pino from 'pino';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getSession, saveSession, clearSession } from './db.js';

let socketInstance = null;
let saveTimeout = null;
let isConnecting = false;

// Custom Supabase-backed auth state (v7 style)
async function makeSupabaseAuthState() {
  const tempDir = join(process.cwd(), 'auth_info_temp'); // fallback temp dir
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  // Load from Supabase on start
  const saved = await getSession();
  let state;

  if (saved) {
    console.log('✅ Restored auth state from Supabase');
    // In v7, state is more complex — we assume your saveSession stores the full JSON
    state = saved; // adjust if structure changed
  } else {
    console.warn('⚠️ No saved auth found. Creating new.');
    // Use multi-file style, but we'll override save/load
    const { state: newState, saveCreds } = await useMultiFileAuthState(tempDir);
    state = newState;
    // We'll handle saveCreds ourselves
  }

  const saveState = async () => {
    try {
      await saveSession(state); // your Supabase function — must serialize full state
      console.log('💾 Auth state saved to Supabase');
    } catch (err) {
      console.error('❌ Failed to save auth state:', err);
    }
  };

  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 4000); // debounce
  };

  return {
    state,
    saveCreds: debouncedSave,
    clear: async () => {
      await clearSession();
      console.log('🗑️ Auth state cleared');
    },
  };
}

export const initSession = async () => {
  if (isConnecting) return socketInstance;
  isConnecting = true;

  try {
    const { state, saveCreds } = await makeSupabaseAuthState();

    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1029030078], // fallback
    }));
    console.log('📡 Using WA version:', version.join('.'));

    socketInstance = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      browser: Browsers.ubuntu('Chrome'), // ← better in v7
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
    });

    // Save on creds update (v7 style)
    socketInstance.ev.on('creds.update', saveCreds);

    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // handle QR in index.js instead
        return;
      }

      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        isConnecting = false;
        saveCreds(); // final save
      }

      if (connection === 'close') {
        isConnecting = false;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.statusCode ?? 'unknown';

        console.log(`Connection closed (code: ${statusCode})`, lastDisconnect?.error);

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.badSession &&
          statusCode !== 405; // common logout variants

        if (!shouldReconnect) {
          console.log('🚪 Logged out or bad session → clearing auth');
          await clearSession();
        }

        // index.js handles reconnect
      }
    });

    return socketInstance;
  } catch (err) {
    console.error('❌ initSession failed:', err);
    isConnecting = false;
    throw err;
  }
};

export const getSocket = () => socketInstance;