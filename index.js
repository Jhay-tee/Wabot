import express from 'express';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';
import pkg from '@whiskeysockets/baileys';
const { fetchLatestBaileysVersion } = pkg;

import { initSession } from './session.js';

config();

const app = express();
let latestQR = null;
let connected = false;

// Root route: show QR or green tick
app.get('/', (req, res) => {
  if (connected) {
    res.send('<h1 style="color:green;">✅ Connected</h1>');
  } else {
    res.send(`
      <h1>Scan QR to connect WhatsApp</h1>
      <div id="qrcode"></div>
      <div id="timer"></div>
      <style>
        body { font-family: Arial; text-align: center; background: #f9f9f9; }
        #qrcode canvas { border: 2px solid #333; padding: 10px; margin-top: 20px; }
        #timer { font-size: 18px; color: red; margin-top: 10px; }
      </style>
      <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
      <script>
        let seconds = 20;
        function startTimer() {
          seconds = 20;
          const timerEl = document.getElementById('timer');
          timerEl.textContent = 'QR expires in ' + seconds + 's';
          const interval = setInterval(() => {
            if (seconds > 0) {
              timerEl.textContent = 'QR expires in ' + (--seconds) + 's';
            } else {
              clearInterval(interval);
              timerEl.textContent = 'QR expired, waiting for refresh...';
            }
          }, 1000);
        }
        async function renderQR() {
          const res = await fetch('/qr');
          if (res.ok) {
            const { qr } = await res.json();
            document.getElementById('qrcode').innerHTML = '';
            QRCode.toCanvas(document.createElement('canvas'), qr, (err, canvas) => {
              if (!err) document.getElementById('qrcode').appendChild(canvas);
            });
            startTimer();
          } else {
            document.getElementById('qrcode').innerHTML = '<h2>No QR available</h2>';
          }
        }
        renderQR();
        setInterval(renderQR, 20000); // auto-refresh every 20s
      </script>
    `);
  }
});

// QR endpoint for frontend polling
app.get('/qr', (req, res) => {
  if (latestQR && !connected) {
    res.json({ qr: latestQR });
  } else {
    res.status(404).json({ error: 'No QR available' });
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: connected ? 'connected' : 'disconnected' });
});

app.listen(3000, () => console.log('Web server running on http://localhost:3000'));

async function startBot() {
  try {
    const { version: waVersion } = await fetchLatestBaileysVersion();
    console.log('Using WhatsApp Web version:', waVersion);

    const sock = await initSession();

    sock.ev.on('connection.update', ({ connection, qr }) => {
      if (qr && !connected) {
        latestQR = qr;
        console.log('📷 New QR Code received, scan it quickly:');
        qrcode.generate(qr, { small: true });

        // Terminal countdown
        let seconds = 20;
        const interval = setInterval(() => {
          if (seconds > 0 && !connected) {
            console.log(`⏳ QR expires in ${seconds--}s`);
          } else {
            clearInterval(interval);
          }
        }, 1000);
      }

      if (connection === 'open') {
        connected = true;
        latestQR = null;
        console.log('✅ Bot connected successfully!');
      }

      if (connection === 'close' && !connected) {
        connected = false;
        console.warn('Connection closed, restarting for fresh QR...');
        setTimeout(startBot, 5000); // keep restarting until connected
      }
    });
  } catch (err) {
    console.error('Failed to start bot:', err);
    setTimeout(startBot, 5000);
  }
}

startBot();
