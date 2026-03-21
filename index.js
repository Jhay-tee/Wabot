// index.js
import express from 'express';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';

import { initSession, getSocket } from './session.js';
import { startScheduler } from './scheduler.js';
import { handleCommand } from './commands.js';
import { checkAntiLink, checkAntiVulgar } from './anti.js';
import { normalizeJid } from './utils.js';
import { isAdmin } from './auth.js';  // ✅ Combined admin check

const app = express();
let isConnected = false;
let reconnectAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 12;
const BASE_RECONNECT_DELAY_MS = 10000;

// ────────────────────────────────────────────────
// Web routes
// ────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(isConnected ? '<h1>✅ WhatsApp Bot is Connected</h1>' : '<h1>Scan QR to Link WhatsApp</h1>');
});

app.get('/qr', (req, res) => {
  const sock = getSocket();
  if (sock?.qrString && !isConnected) {
    res.json({ qr: sock.qrString });
  } else {
    res.status(404).json({ error: 'No QR code active' });
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
      if (!msg.message) return;

      const groupJid = msg.key.remoteJid;
      const senderJid = normalizeJid(msg.key.participant || msg.key.remoteJid);

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      // ✅ Production‑ready admin check
      const isAdminFlag = await isAdmin(sock, groupJid, senderJid);

      // Run moderation checks (apply to non‑admins)
      await checkAntiLink(text, isAdminFlag, groupJid, senderJid, sock);
      await checkAntiVulgar(msg, isAdminFlag, groupJid, senderJid, sock);

      // Run commands ONLY if admin
      if (isAdminFlag) {
        await handleCommand(sock, msg);
      }
      // Non‑admins: do nothing, commands ignored
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, qr } = update;
      if (qr && !isConnected) {
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
        console.warn('Connection closed, restarting...');
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
process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err); isConnected = false; handleReconnect(); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
startBot();
