// session.js
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import pino from 'pino';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getSession, saveSession, clearSession } from './db.js';

let socketInstance = null;
let saveTimeout = null;
let isConnecting = false;

async function makeSupabaseAuthState() {
  const tempDir = join(process.cwd(), 'auth_info_temp');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const saved = await getSession();
  let state;

  if (saved) {
    console.log('✅ Restored auth state from Supabase');
    state = saved;
  } else {
    console.warn('⚠️ No saved auth found. Creating new.');
    const { state: newState } = await useMultiFileAuthState(tempDir);
    state = newState;
  }

  const saveState = async () => {
    try {
      await saveSession(state);
      console.log('💾 Auth state saved to Supabase');
    } catch (err) {
      console.error('❌ Failed to save auth state:', err);
    }
  };

  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 4000);
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
      version: [2, 3000, 1029030078],
    }));
    console.log('📡 Using WA version:', version.join('.'));

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
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
    });

    socketInstance.ev.on('creds.update', saveCreds);

    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        socketInstance.qrString = qr; // expose QR string
        console.log('📷 New QR Code received');
      }

      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        isConnecting = false;
        saveCreds();
      }

      if (connection === 'close') {
        isConnecting = false;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.statusCode ?? 'unknown';

        console.log(`Connection closed (code: ${statusCode})`, lastDisconnect?.error);
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
