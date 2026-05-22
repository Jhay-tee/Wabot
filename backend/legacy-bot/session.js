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
let isConnecting = false;

async function makeSupabaseAuthState() {
  const tempDir = join(process.cwd(), 'auth_info_temp');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const saved = await getSession();
  let state, saveCreds;

  if (saved && saved.creds?.registered) {
    // ✅ Valid session
    console.log('✅ Restored valid auth state from Supabase');
    state = saved;
    const { saveCreds: localSaveCreds } = await useMultiFileAuthState(tempDir);
    saveCreds = async () => {
      await saveSession(state);
      await localSaveCreds();
      console.log('💾 Auth state updated (Supabase + local)');
    };
  } else {
    if (saved) {
      console.warn('⚠️ Saved session is stale (registered=false). Clearing...');
      await clearSession();
    }
    console.warn('⚠️ No valid auth found. Creating new.');
    const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(tempDir);
    state = newState;
    saveCreds = async () => {
      await saveSession(state);
      await newSaveCreds();
      console.log('💾 Auth state saved to Supabase + local');
    };
  }

  return {
    state,
    saveCreds,
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

    // ✅ Persist creds on every update
    socketInstance.ev.on('creds.update', saveCreds);

    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        socketInstance.qrString = qr;
        console.log('📷 New QR Code received');
      }

      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        isConnecting = false;
        await saveCreds(); // save immediately on connect
      }

      if (connection === 'close') {
        isConnecting = false;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.statusCode ?? 'unknown';

        console.log(`Connection closed (code: ${statusCode})`, lastDisconnect?.error);

        // 🔑 Only clear session if WhatsApp explicitly logged us out
        if (statusCode === 401) {
          console.error('⚠️ Logged out from WhatsApp. Clearing session...');
          await clearSession();
        }
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
