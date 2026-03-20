import pkg from '@whiskeysockets/baileys';
const { makeWASocket, initAuthCreds, makeCacheableSignalKeyStore, DisconnectReason } = pkg;
import P from 'pino';
import { getSession, saveSession, clearSession } from './db.js';

let socketInstance = null;
let creds = null;
let keys = {};
let connected = false;

export const initSession = async () => {
  let savedSession = null;
  try {
    savedSession = await getSession();
  } catch {
    console.error('❌ Error reading session from Supabase');
  }

  // Detect corrupt or missing data
  if (!savedSession || !savedSession.creds || !savedSession.keys) {
    console.warn('⚠️ No valid session found or data corrupt. Clearing and starting fresh.');
    await clearSession();
    creds = initAuthCreds();
    keys = {};
  } else {
    creds = savedSession.creds;
    keys = savedSession.keys;
    console.log('✅ Restored session from Supabase');
  }

  const keyStore = makeCacheableSignalKeyStore({
    get: async (type, ids) => {
      const data = {};
      for (const id of ids || []) {
        if (keys[type]?.[id] !== undefined) data[id] = keys[type][id];
      }
      return data;
    },
    set: async (data) => {
      for (const cat in data) {
        keys[cat] = keys[cat] || {};
        for (const id in data[cat]) {
          if (data[cat][id] == null) delete keys[cat][id];
          else keys[cat][id] = data[cat][id];
        }
      }
      // Save keys immediately during pairing
      await saveSession({ creds, keys });
      console.log('🔑 Keys updated and saved to Supabase');
    }
  });

  const silentLogger = P({ level: 'silent' });

  socketInstance = makeWASocket({
    auth: { creds, keys: keyStore },
    logger: silentLogger,
    printQRInTerminal: false // handled in index.js
  });

  // Connection lifecycle
  socketInstance.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true;
      console.log('✅ Device connected successfully!');
      await saveSession({ creds, keys });
    }

    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (reason: ${code || 'unknown'})`);

      if (code === DisconnectReason.restartRequired) {
        console.log('⚠️ Pairing restart detected, waiting for new QR...');
        return; // don’t clear session here
      }

      if (code === DisconnectReason.loggedOut) {
        console.log('🚪 Logged out, clearing session and forcing new QR');
        await clearSession();
        creds = initAuthCreds();
        keys = {};
      } else {
        console.warn('⚠️ Unexpected disconnect, keeping session for retry');
        // Do NOT clear here — let index.js restart and request new QR
      }
    }
  });

  // Save creds immediately
  socketInstance.ev.on('creds.update', async (updatedCreds) => {
    creds = updatedCreds;
    await saveSession({ creds, keys });
    console.log('🔑 Credentials updated and saved to Supabase');
  });

  // Save keys immediately
  socketInstance.ev.on('keys.update', async (updatedKeys) => {
    for (const cat in updatedKeys) {
      keys[cat] = keys[cat] || {};
      for (const id in updatedKeys[cat]) {
        if (updatedKeys[cat][id] == null) delete keys[cat][id];
        else keys[cat][id] = updatedKeys[cat][id];
      }
    }
    await saveSession({ creds, keys });
    console.log('🔑 Keys updated and saved to Supabase');
  });

  return socketInstance;
};

export const getSocket = () => socketInstance;
