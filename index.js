// index.js
import express from 'express';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';

import { initSession, getSocket } from './session.js';
import { startScheduler } from './scheduler.js';

const app = express();

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
      <!-- Load QRCode library -->
      <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
      <script>
        async function updateQR() {
          try {
            const r = await fetch('/qr'); // same origin, correct port
            if (!r.ok) return;
            const { qr } = await r.json();
            if (!qr) return;

            const container = document.getElementById('qrcode');
            container.innerHTML = '';

            const canvas = document.createElement('canvas');
            QRCode.toCanvas(canvas, qr, { width: 300 }, function (error) {
              if (error) {
                console.error('QR render error:', error);
              } else {
                container.appendChild(canvas);
              }
            });
          } catch (err) {
            console.error('updateQR failed:', err);
          }
        }
        updateQR();
        setInterval(updateQR, 10000);
      </script>
    `);
  }
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

    sock.ev.on('connection.update', (update) => {
      const { connection, qr } = update;

      if (qr && !isConnected) {
        sock.qrString = qr; // save QR string for /qr
        console.log('📷 New QR generated');
        qrcode.generate(qr, { small: true }); // terminal display
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

  console.log(`Reconnecting in ${Math.round(delay / 1000)} s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(startBot, delay);
}

// ────────────────────────────────────────────────
// Shutdown & error handling
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
  console.error('UNCAUGHT EXCEPTION:', err);
  isConnected = false;
  handleReconnect();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

startBot();
