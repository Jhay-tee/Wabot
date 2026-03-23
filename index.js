// index.js

import express from 'express';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';

import { initSession, getSocket } from './session.js';
import { startScheduler } from './scheduler.js';
import { handleCommand } from './commands.js';
import { checkAntiLink, checkAntiVulgar } from './anti.js';
import { normalizeJid, extractText } from './utils.js';
import { isAdmin, isBotAdmin } from './auth.js';
import { Boom } from '@hapi/boom';
import { clearSession } from './db.js';

const app = express();
let isConnected = false;
let reconnectAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 12;
const BASE_RECONNECT_DELAY_MS = 10000;

// ────────────────────────────────────────────────
// Web routes
// ────────────────────────────────────────────────

app.get('/', (req, res) => {
  const sock = getSocket();
  if (isConnected) {
    res.send('<h1>✅ WhatsApp Bot is Connected</h1>');
  } else if (sock?.qrString) {
    res.send(`
      <h1>Scan QR to Link WhatsApp</h1>
      <div id="qrcode"></div>
      <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
      <script>
        const qr = "${sock.qrString}";
        const container = document.getElementById('qrcode');
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, qr, { width: 300 }, (err) => {
          if (!err) container.appendChild(canvas);
        });
      </script>
    `);
  } else {
    res.send('<h1>No QR code active</h1>');
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: isConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.floor(process.uptime()),
    reconnectAttempts,
    qrActive: !!getSocket()?.qrString && !isConnected,
    timestamp: new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────
// Bot lifecycle
// ────────────────────────────────────────────────

async function startBot() {
  try {
    console.log('🔄 Starting WhatsApp connection attempt...');
    const sock = await initSession();

    // 🔑 Listen for incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      console.log('RAW MESSAGE:', JSON.stringify(msg.message, null, 2));
      if (!msg.message) return;
      console.log('RAW MESSAGE:', JSON.stringify(msg.message, null, 2));

      const groupJid = msg.key.remoteJid;
      const senderJid = normalizeJid(msg.key.participant || msg.key.remoteJid);
      const text = extractText(msg).trim();
      const cmd = text.startsWith('.') ? text.slice(1).split(/\s+/)[0].toLowerCase() : null;

      // ✅ Check if bot is admin
      const botIsAdmin = await isBotAdmin(sock, groupJid);

      // ✅ Allow public commands even if bot isn’t admin
      const publicCommands = ['help', 'menu', 'ping'];
      if (!botIsAdmin && cmd && !publicCommands.includes(cmd)) return;

      // ✅ Check if sender is admin
      const isAdminFlag = await isAdmin(sock, groupJid, senderJid);

      // Debug logs
      console.log('Parsed text:', text);
      console.log('Command:', cmd);
      console.log('Sender admin?', isAdminFlag, 'Bot admin?', botIsAdmin);

      // Moderation checks (only if bot is admin)
      if (botIsAdmin) {
        await checkAntiLink(text, isAdminFlag, groupJid, senderJid, sock);
        await checkAntiVulgar(msg, isAdminFlag, groupJid, senderJid, sock);
      }

      // ✅ Handle commands safely
      let groupMetadata = { id: groupJid, participants: [] };
      if (groupJid.endsWith('@g.us')) {
        try {
          groupMetadata = await sock.groupMetadata(groupJid);
        } catch (err) {
          console.error('Failed to fetch group metadata:', err.message);
        }
      }

      await handleCommand(sock, msg, groupMetadata);
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sock.qrString = qr;
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        console.log('🎉 Connected to WhatsApp');
        isConnected = true;
        reconnectAttempts = 0;
        startScheduler();
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.statusCode ?? 'unknown';

        console.warn(`Connection closed (code: ${statusCode})`);

        if (statusCode === 401) {
          console.error('⚠️ Logged out from WhatsApp. Clearing session...');
          try {
            await clearSession();
          } catch (e) {
            console.error('Failed to clear session:', e.message);
          }
        } else {
          console.log('🔄 Transient error, will attempt reconnect.');
        }

        handleReconnect();
      }
    });

  } catch (err) {
    console.error('Failed to start bot:', err.message || err);
    handleReconnect();
  }
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnect attempts reached. Giving up.');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY_MS * (1.6 ** (reconnectAttempts - 1)), 600000);
  console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  setTimeout(startBot, delay);
}

// ────────────────────────────────────────────────
// Shutdown & error handling
// ────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('SIGINT received – shutting down');
  const sock = getSocket();
  if (sock) {
    try { await sock.logout(); } catch (e) { console.error('Logout failed:', e.message); }
  }
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  isConnected = false;
  handleReconnect();
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
startBot();
