// index.js
import express from 'express';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';  // loads .env automatically in v7-era projects

import { initSession, getSocket } from './session.js';
import { startScheduler } from './scheduler.js';

const app = express();

let latestQR = null;
let isConnected = false;
let reconnectAttempts = 0;

const MAX_RECONNECT_ATTEMPTS = 12;
const BASE_RECONNECT_DELAY_MS = 10000;

// ────────────────────────────────────────────────
// Web routes
// ────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (isConnected) {
    res.send(`
      <h1 style="color: #2ecc71; text-align: center; margin-top: 60px; font-family: system-ui;">
        ✅ WhatsApp Bot is Connected
      </h1>
      <p style="text-align: center; color: #555;">
        Uptime: ${Math.floor(process.uptime() / 3600)} h 
        ${Math.floor((process.uptime() % 3600) / 60)} min
      </p>
    `);
  } else {
    res.send(`
      <h1 style="text-align:center; margin-top:60px; font-family:system-ui;">
        Scan QR to Link WhatsApp
      </h1>
      <div id="qrcontainer" style="margin:40px auto; width:340px; padding:20px; background:white; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.1);">
        <div id="qrcode"></div>
      </div>

      <style>
        body { font-family:system-ui; background:#f8f9fa; text-align:center; padding:20px; }
      </style>
      <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
      <script>
        async function updateQR() {
          try {
            const r = await fetch('/qr');
            if (!r.ok) return;
            const { qr } = await r.json();
            if (!qr) return;
            document.getElementById('qrcode').innerHTML = '';
            QRCode.toCanvas(qr, { 
              width: 300,
              errorCorrectionLevel: 'H',
              margin: 2
            }, (err, canvas) => {
              if (!err) document.getElementById('qrcode').appendChild(canvas);
            });
          } catch {}
        }
        updateQR();
        setInterval(updateQR, 14000);
      </script>
    `);
  }
});

app.get('/qr', (req, res) => {
  if (latestQR && !isConnected) {
    res.json({ qr: latestQR });
  } else {
    res.status(404).json({ error: 'No QR code active' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: isConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.floor(process.uptime()),
    reconnectAttempts,
    qrActive: !!latestQR && !isConnected,
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

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;

      // ── QR ───────────────────────────────────────
      if (qr && !isConnected) {
        latestQR = qr;
        console.log('New QR generated');
        qrcode.generate(qr, { small: true });
      }

      // ── Connected ────────────────────────────────
      if (connection === 'open') {
        console.log('🎉 Connected to WhatsApp');
        isConnected = true;
        latestQR = null;
        reconnectAttempts = 0;
        startScheduler();
      }

      // ── Disconnected ─────────────────────────────
      if (connection === 'close') {
        isConnected = false;
        latestQR = null;

        const status = lastDisconnect?.error?.output?.statusCode
                     ?? lastDisconnect?.error?.statusCode
                     ?? 'unknown';

        console.log(`Disconnected (reason: ${status})`);

        if (status === DisconnectReason.loggedOut ||
            status === DisconnectReason.badSession ||
            status === 405) {
          console.log('Logged out / bad session → clearing credentials');
          // clearSession() is called inside session.js close handler
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

  console.log(`Reconnecting in ${Math.round(delay / 1000)} s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(startBot, delay);
}

// ────────────────────────────────────────────────
// Graceful shutdown & global error handling
// ────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('SIGINT received – shutting down');
  const sock = getSocket();
  if (sock) {
    try {
      await sock.logout();
      console.log('Logged out cleanly');
    } catch (e) {
      console.error('Logout failed during shutdown:', e.message);
    }
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received – exiting');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  if (err.message?.includes('Connection') || 
      err?.output?.statusCode === 428 || 
      err?.output?.statusCode === 440) {
    console.log('Recoverable WA connection error – reconnecting');
    isConnected = false;
    handleReconnect();
  } else {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

startBot();