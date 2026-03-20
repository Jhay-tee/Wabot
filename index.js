// index.js
import P from 'pino';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';
import pkg from '@whiskeysockets/baileys';
const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = pkg;

import { getSession, saveSession, clearSession, getGroupSettings, getScheduledLocks } from './db.js';
import { handleCommand } from './commands.js';

config(); // Load .env

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Supabase URL or Key is missing. Set SUPABASE_URL and SUPABASE_KEY in your .env.');
  process.exit(1);
}

async function startBot() {
  try {
    const { version: waVersion } = await fetchLatestBaileysVersion();
    console.log('Using WhatsApp Web version:', waVersion);

    // Load session from Supabase
    let session = await getSession();
    let authState = session?.auth_data || { creds: {}, keys: {} };

    // Create socket
    const sock = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      auth: authState,
      version: waVersion
    });

    // QR code & connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        console.log('📷 QR Code received, scan it with WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log('Connection closed, reason:', reason);

        // Clear session if invalid or unexpected disconnect
        if (reason !== DisconnectReason.loggedOut) {
          console.log('Session invalid or broken. Clearing session in DB.');
          await clearSession();
        }

        setTimeout(startBot, 5000); // Reconnect after 5s
      }

      if (connection === 'open') {
        console.log('✅ Bot connected successfully!');
      }
    });

    // Save updated credentials to Supabase
    sock.ev.on('creds.update', async (creds) => {
      await saveSession({ creds, keys: authState.keys || {} });
      console.log('🔑 Session updated and saved to DB.');
    });

    // Messages & command handling
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      try {
        await handleCommand(sock, msg);
      } catch (err) {
        console.error('Error handling command:', err);
      }
    });

    // Periodic scheduled locks/unlocks (every 30s)
    setInterval(async () => {
      const scheduledLocks = await getScheduledLocks();
      const now = new Date();

      scheduledLocks.forEach(async (lock) => {
        const lockTime = lock.lock_time ? new Date(lock.lock_time) : null;
        const unlockTime = lock.unlock_time ? new Date(lock.unlock_time) : null;

        if (lockTime && now >= lockTime && (!unlockTime || now < unlockTime)) {
          // TODO: lock group logic
        }

        if (unlockTime && now >= unlockTime) {
          // TODO: unlock group logic
        }
      });
    }, 30_000);

  } catch (err) {
    console.error('Failed to start bot:', err);
  }
}

// Start bot
startBot();
