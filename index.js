// index.js
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';

import { getSession, saveSession, getGroupSettings, getScheduledLocks } from './db.js';
import { handleCommand } from './commands.js';

config(); // Load .env variables

// Supabase URL & Key must be in .env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Supabase URL or Key is missing. Set SUPABASE_URL and SUPABASE_KEY in your .env.');
  process.exit(1);
}

// Main bot function
async function startBot() {
  try {
    // Get latest WhatsApp Web version
    const { version: waVersion } = await fetchLatestBaileysVersion();
    console.log('Using WhatsApp Web version:', waVersion);

    // Load session from Supabase
    let session = await getSession();
    let authState = session?.auth_data || {};

    // Create socket
    const sock = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      auth: authState,
      version: waVersion
    });

    // QR code handling
    sock.ev.on('connection.update', (update) => {
      const { connection, qr } = update;
      if (qr) {
        console.log('QR Code received, scan it with WhatsApp:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const reason = update.lastDisconnect?.error?.output?.statusCode;
        console.log('Connection closed, reason:', reason);
        // Clear session if disconnected unexpectedly
        if (reason !== DisconnectReason.loggedOut) {
          saveSession(null);
        }
        startBot(); // Reconnect
      }
      if (connection === 'open') {
        console.log('✅ Bot connected successfully!');
      }
    });

    // Listen to credential updates and save session
    sock.ev.on('creds.update', async (newCreds) => {
      await saveSession({ creds: newCreds });
      console.log('🔑 Session updated and saved to DB.');
    });

    // Listen to messages
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      try {
        await handleCommand(sock, msg); // Handle commands & strikes
      } catch (err) {
        console.error('Error handling command:', err);
      }
    });

    // Optional: Periodic checks (locks/unlocks)
    setInterval(async () => {
      const scheduledLocks = await getScheduledLocks();
      // You can iterate over scheduledLocks and apply lock/unlock logic
      // based on current time
    }, 30_000); // every 30 seconds

  } catch (err) {
    console.error('Failed to start bot:', err);
  }
}

// Start the bot
startBot(); 
