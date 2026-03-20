// session.js
import { 
  makeWASocket, 
  DisconnectReason, 
  // initAuthCreds,     ← remove or comment if unused (it's internal / rarely needed directly)
  // BufferJSON         ← same, usually not needed directly anymore
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import P from 'pino';
import { getSession, saveSession, clearSession } from './db.js';

let socketInstance = null;
let saveTimeout = null;
let isConnecting = false;

export const initSession = async () => {
  if (isConnecting) {
    console.log('⚠️ Connection already in progress, skipping...');
    return socketInstance;
  }

  isConnecting = true;

  try {
    const saved = await getSession();

    let authState;

    if (!saved) {
      console.warn('⚠️ No saved session found. Starting with fresh credentials.');
      authState = { creds: initAuthCreds(), keys: {} };
    } else {
      console.log('✅ Restored session from Supabase');
      authState = {
        creds: saved.creds,
        keys: saved.keys || {}
      };
    }

    // Debounced save to prevent DB spam
    const debouncedSave = () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        try {
          await saveSession(authState);
        } catch (err) {
          console.error('❌ Failed to save session to Supabase:', err);
        }
      }, 5000);
    };

    socketInstance = makeWASocket({
      auth: authState,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    // Save on creds update
    socketInstance.ev.on('creds.update', () => {
      authState.creds = socketInstance.authState.creds;
      debouncedSave();
    });

    // Connection updates
    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) return;

      if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully!');
        isConnecting = false;
        debouncedSave();
      }

      if (connection === 'close') {
        isConnecting = false;
        const boomError = lastDisconnect?.error;
        const statusCode = boomError?.output?.statusCode 
                        ?? (boomError instanceof Boom ? boomError.output.statusCode : null);

        console.log(`Connection closed (reason: ${statusCode || 'unknown'})`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚪 Logged out - clearing session');
          await clearSession();
        } 
        else if (statusCode === 440 || statusCode === DisconnectReason.connectionReplaced) {
          console.log('⚠️ 440 Connection Replaced - Waiting longer...');
        } 
        else if (statusCode === 428 || statusCode === DisconnectReason.connectionClosed) {
          console.log('⚠️ Connection closed - will retry');
        } 
        else {
          console.warn('⚠️ Unexpected disconnect');
        }
      }
    });

    return socketInstance;

  } catch (err) {
    console.error('❌ Error during initSession:', err);
    isConnecting = false;
    throw err;
  }
};

export const getSocket = () => socketInstance;