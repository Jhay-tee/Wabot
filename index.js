// index.js
import P from 'pino';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';
import pkg from '@whiskeysockets/baileys';
const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = pkg;

import { getSession, saveSession, getScheduledLocks } from './db.js';
import { handleCommand } from './commands.js';

config();

async function startBot() {
  try {
    const { version: waVersion } = await fetchLatestBaileysVersion();
    console.log('Using WhatsApp Web version:', waVersion);

    const session = await getSession();
    const authState = session?.auth_data || { creds: {}, keys: {} };

    const sock = makeWASocket({
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      auth: authState,
      version: waVersion
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        console.log('Scan QR code:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log('Connection closed:', reason);
        if (reason !== DisconnectReason.loggedOut) await saveSession(null);
        setTimeout(startBot, 5000);
      }

      if (connection === 'open') {
        console.log('✅ Bot connected!');
      }
    });

    sock.ev.on('creds.update', async (creds) => {
      await saveSession({ creds, keys: authState.keys || {} });
      console.log('🔑 Session updated in DB.');
    });

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      try {
        await handleCommand(sock, msg);
      } catch (err) {
        console.error('Error handling command:', err);
      }
    });

    // Scheduled locks/unlocks (stub, extend as needed)
    setInterval(async () => {
      const locks = await getScheduledLocks();
      const now = new Date();
      locks.forEach(lock => {
        // TODO: Implement auto lock/unlock logic
      });
    }, 30_000);

  } catch (err) {
    console.error('Failed to start bot:', err);
  }
}

startBot();
