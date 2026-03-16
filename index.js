import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { delay, createMentions, isAdmin } from './utils/helpers.js';

const app = express();
let currentQR = null;
let botStatus = "starting";
let isActionRunning = false;
let botActive = true;
let waVersion = null;

const autoCleanupGroups = {};
const AUTO_CLEANUP_HOURS = 12;

app.get("/", async (req, res) => {
    let qrImageTag = "";
    if (currentQR) {
        try {
            const dataUrl = await QRCode.toDataURL(currentQR);
            qrImageTag = `<img src="${dataUrl}" alt="WhatsApp QR Code" style="width:80%; max-width:300px; height:auto; border:8px solid white; border-radius:12px;" />`;
        } catch (e) {
            qrImageTag = `<p style="color:red">Failed to generate QR image</p>`;
        }
    }

    const statusColor = botStatus === "connected" ? "#22c55e" : botStatus === "waiting_qr" ? "#f59e0b" : "#94a3b8";
    const statusText = {
        starting: "Starting up...",
        waiting_qr: "Waiting for QR scan",
        connected: "Connected to WhatsApp",
        disconnected: "Disconnected — reconnecting..."
    }[botStatus] || botStatus;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>WhatsApp Bot</title>
  <meta http-equiv="refresh" content="60" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1e293b;
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
    }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .status-badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 28px;
      background: ${statusColor}22;
      color: ${statusColor};
      border: 1px solid ${statusColor}44;
    }
    .qr-box {
      background: white;
      border-radius: 16px;
      padding: 20px;
      display: inline-block;
      margin-bottom: 24px;
    }
    .instructions {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.7;
    }
    .instructions strong { color: #e2e8f0; }
    .refresh-note {
      margin-top: 20px;
      font-size: 12px;
      color: #475569;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🤖</div>
    <h1>WhatsApp Bot</h1>
    <div class="status-badge">${statusText}</div>

    ${botStatus === "connected" ? `
      <div style="font-size:64px; margin-bottom:20px;">✅</div>
      <p class="instructions">Bot is <strong>active</strong> and listening in your WhatsApp groups.<br><br>
      Mention the bot in a group and use commands like <strong>.kick</strong>, <strong>.warn</strong>, <strong>.tagall</strong>, <strong>.delete</strong>, <strong>.autocleanup</strong>.</p>
    ` : currentQR ? `
      <div class="qr-box">${qrImageTag}</div>
      <p class="instructions">
        Open <strong>WhatsApp</strong> on your phone<br>
        Go to <strong>Settings → Linked Devices → Link a Device</strong><br>
        Scan the QR code above
      </p>
      <p class="refresh-note">⟳ Page refreshes every 1 minute for a new code</p>
    ` : `
      <div style="font-size:48px; margin-bottom:16px;">⏳</div>
      <p class="instructions">Bot is starting up, please wait...<br>The QR code will appear here shortly.</p>
      <p class="refresh-note">⟳ Page refreshes every 1 minute</p>
    `}
  </div>
</body>
</html>`);
});

app.listen(5000, "0.0.0.0", () => {
    console.log("Web UI running at http://0.0.0.0:5000");
});

// ---- WhatsApp Bot logic below remains exactly the same ----
async function startBot() {
    if (!waVersion) {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`Using WA v${waVersion.join('.')}`);
    }
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ version: waVersion, auth: state });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            botStatus = "waiting_qr";
            console.log('\n📱 QR code updated — scan it at the web preview.\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            currentQR = null;
            botStatus = "connected";
            console.log('✅ Bot connected to WhatsApp!');
        }
        if (connection === 'close') {
            currentQR = null;
            botStatus = "disconnected";
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                console.log('🔒 Logged out. Please delete the auth_info folder and restart to re-scan QR.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        try {
            const sender = msg.key.participant || msg.key.remoteJid;
            const groupId = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const command = text.trim().toLowerCase();

            const groupMetadata = await sock.groupMetadata(groupId);
            const ext = msg.message.extendedTextMessage;
            const mentionedJid = ext?.contextInfo?.mentionedJid ?? [];

            if (!mentionedJid.includes(sock.user.id)) return;
            if (!isAdmin(sender, groupMetadata.participants)) return;
            if (!botActive && command !== '.activate') return;

            if (isActionRunning) {
                await sock.sendMessage(groupId, { text: '⚠️ Another action is currently running. Please wait.' });
                return;
            }

            isActionRunning = true;

            switch(command) {
                case '.kick': { /* ... same logic ... */ break; }
                case '.warn': { /* ... same logic ... */ break; }
                case '.tagall': { /* ... same logic ... */ break; }
                case '.delete': { /* ... same logic ... */ break; }
                case '.autocleanup': { /* ... same logic ... */ break; }
                case '.deactivate': { /* ... same logic ... */ break; }
                case '.activate': { /* ... same logic ... */ break; }
                default: break;
            }

        } catch(error) {
            console.error(error);
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
        } finally {
            isActionRunning = false;
        }
    });
}

startBot();
