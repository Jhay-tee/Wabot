import { makeWASocket, useSingleFileAuthState } from '@whiskeysockets/baileys';
import { getSession, saveSession } from './db.js';
import { logger } from './logger.js';

let socketInstance = null;
let authDataDebounce = null;

export const initSession = async () => {
  const savedSession = await getSession();

  const { state, saveState } = useSingleFileAuthState('auth.json'); // fallback local file

  socketInstance = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  // Save session on every update, debounced
  socketInstance.ev.on('creds.update', (creds) => {
    clearTimeout(authDataDebounce);
    authDataDebounce = setTimeout(async () => {
      saveState();
      await saveSession(state); // save full auth_data to Supabase
      logger.info('Session saved to DB');
    }, 5000); // wait 5s for multiple updates
  });

  return socketInstance;
};

export const getSocket = () => socketInstance;
