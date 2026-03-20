// index.js
import express from 'express';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';

import { initSession } from './session.js';
import { startScheduler } from './scheduler.js';

config();

const app = express();
let latestQR = null;
let connected = false;

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

app.get('/', (req, res) => {
  if (connected) {
    res.send(`
      <h1 style="color:green; text-align:center; margin-top:50px;">
        ✅ WhatsApp Bot is Connected and Running
      </h1>
    `);
  } else {
    res.send(`
      <h1 style="text-align:center; margin-top:50px;">Scan QR Code to Connect WhatsApp</h1>
      <div id="qrcode" style="margin:30px auto; width:320px;"></div>
      
      <style>
        body { 
          font-family: Arial, sans-serif; 
          background:#f0f0f0; 
          text-align:center; 
          padding: 20px;
        }
        #qrcode canvas { 
          border: 4px solid #333; 
          padding:20px; 
          background:white; 
          border-radius: 10px;
        }
      </style>
      <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
      <script>
        async function renderQR() {
          try {
            const res = await fetch('/qr');
            if (res.ok) {
              const { qr } = await res.json();
              document.getElementById('qrcode').innerHTML = '';
              QRCode.toCanvas(document.createElement('canvas'), qr, (err, canvas) => {
                if (!err) document.getElementById('qrcode').appendChild(canvas);
              });
            }
          } catch (e) {}
        }
        renderQR();
        setInterval(renderQR, 15000);
      </script>
    `);
  }
});

app.get('/qr', (req, res) => {
  if (latestQR && !connected) {
    res.json({ qr: latestQR });
  } else {
    res.status(404).json({ error: 'No QR available' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: connected ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});

// ======================= BOT START =======================

async function startBot() {
  try {
    console.log('🔄 Initializing WhatsApp Socket...');

    const sock = await initSession();

    sock.ev.on('connection.update', ({ connection, qr }) => {
      if (qr && !connected) {
        latestQR = qr;
        console.log('📷 New QR Code generated - Scan it now!');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        connected = true;
        latestQR = null;
        reconnectAttempts = 0;
        console.log('🎉✅ Bot is stable and fully connected!');

        // Start scheduler after successful connection
        startScheduler();
      }
    });

  } catch (err) {
    console.error('❌ Failed to start bot:', err.message);
    handleReconnect();
  }
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Maximum reconnect attempts reached. Please check logs or clear session.');
    return;
  }

  reconnectAttempts++;
  const delay = reconnectAttempts > 4 ? 25000 : 10000;

  console.log(`🔄 Reconnecting in ${delay / 1000} seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(startBot, delay);
}

// Global error handler
process.on('uncaughtException', (err) => {
  if (err.message?.includes('Connection Closed') || 
      err.output?.statusCode === 428 || 
      err.output?.statusCode === 440) {
    
    console.log('⚠️ Caught WhatsApp connection error - triggering reconnect');
    connected = false;
    handleReconnect();
  } else {
    console.error('❌ Critical uncaught exception:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Promise Rejection:', reason);
});

// Start the bot
startBot();