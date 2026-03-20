// session.js
import {
  makeWASocket,
  DisconnectReason
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import pino from 'pino';
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
      console.warn('⚠️ No saved session found. Starting fresh (QR/pairing needed).');
      // Do NOT call initAuthCreds() manually unless you know it's required
      // Baileys will generate fresh creds automatically when auth is {} or partial
      authState = {
        creds: {},      // let Baileys init
        keys: {}
      };
    } else {
      console.log('✅ Restored session from Supabase');
      authState = {
        creds: saved.creds || {},
        keys: saved.keys || {}
      };
    }

    // Debounced save to avoid DB spam
    const debouncedSave = () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        try {
          await saveSession(authState);
          console.log('💾 Session saved to Supabase (debounced)');
        } catch (err) {
          console.error('❌ Failed to save session:', err.message || err);
        }
      }, 5000);
    };

    socketInstance = makeWASocket({
      auth: authState,
      logger: pino({ level: 'silent' }), // change to 'debug' temporarily if troubleshooting
      printQRInTerminal: false,          // set true for console QR during testing
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      // Stability tweaks (safe in v6.7+)
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false
    });

    // Save on creds update
    socketInstance.ev.on('creds.update', () => {
      // Safe merge - avoid overwriting if authState.creds is undefined
      if (socketInstance?.authState?.creds) {
        authState.creds = { ...authState.creds, ...socketInstance.authState.creds };
      }
      debouncedSave();
    });

    // Connection updates - improved logout detection
    socketInstance.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR generated (not printing - handle manually if needed)');
        return;
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully!');
        isConnecting = false;
        debouncedSave();
        return;
      }

      if (connection === 'close') {
        isConnecting = false;

        const errorObj = lastDisconnect?.error;
        const statusCode = errorObj?.output?.statusCode ?? 
                          (errorObj instanceof Boom ? errorObj.output?.statusCode : null) ??
                          errorObj?.statusCode ?? null;

        console.log(
          `Connection closed (code: ${statusCode ?? 'unknown'})`,
          errorObj ? JSON.stringify(errorObj, null, 2) : '(no details)'
        );

        const errorMsg = (errorObj?.message || '').toLowerCase();
        const isLoggedOut = 
          statusCode === DisconnectReason.loggedOut ||      // 401
          statusCode === 405 ||                             // rare variant
          errorMsg.includes('logged out') ||
          errorMsg.includes('user not found') ||
          errorMsg.includes('401') ||
          errorMsg.includes('device removed');

        if (isLoggedOut) {
          console.log('🚪 Logout detected → clearing Supabase session');
          await clearSession().catch(err => 
            console.error('Clear session failed:', err.message)
          );
        } else if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
          console.log('⚠️ Connection replaced (440) - will retry');
        } else if (
          statusCode === DisconnectReason.connectionClosed ||    // 428
          statusCode === DisconnectReason.connectionLost ||      // 408
          statusCode === DisconnectReason.timedOut
        ) {
          console.log('⚠️ Recoverable close - retry logic should handle');
        } else {
          console.warn('⚠️ Unexpected disconnect - check logs');
        }
      }
    });

    return socketInstance;
  } catch (err) {
    console.error('❌ initSession failed:', err.message || err);
    isConnecting = false;
    throw err;
  }
};

export const getSocket = () => socketInstance;