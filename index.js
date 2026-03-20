import express from 'express';
import { config } from 'dotenv';
import qrcode from 'qrcode-terminal';
import pkg from '@whiskeysockets/baileys';
const { fetchLatestBaileysVersion, DisconnectReason } = pkg;

import { initSession } from './session.js';

config();

const app = express();
let latestQR = null;

app.get('/qr', (req, res) => {
  if (latestQR) {
    res.json({ qr: latestQR });
  } else {
    res.status(404).json({ error: 'No QR available' });
  }
});

app.listen(3000, () => console.log('Web server running on http://localhost:3000'));

async function startBot() {
  const { version: waVersion } = await fetchLatestBaileysVersion();
  console.log('Using WhatsApp Web version:', waVersion);

  const sock = await initSession();

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      latestQR = qr; // store for webpage
      console.log('📷 QR Code received, scan it with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Bot connected successfully!');
      latestQR = null; // clear once connected
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.warn('Connection closed, reason:', reason);
      setTimeout(startBot, 5000);
    }
  });
}

startBot();
