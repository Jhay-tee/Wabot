import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { delay, isAdmin } from "./utils/helpers.js";

const app = express();

let currentQR = null;
let botStatus = "starting";
let botActive = true;
let isActionRunning = false;
let waVersion = null;

// ---------------- Bot Config ----------------
const BOT_PHONE_NUMBER = "2348105686810"; // <-- Replace with your bot account number
const SUPABASE_URL = "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const WA_TABLE = "wa_sessions";

// ---------------- Express UI for QR ----------------
app.get("/", async (req, res) => {
  let qrImageTag = "";
  if (currentQR) {
    try {
      const dataUrl = await QRCode.toDataURL(currentQR);
      qrImageTag = `<img src="${dataUrl}" style="width:80%; max-width:300px; height:auto; border-radius:12px; border:8px solid white"/>`;
    } catch (e) {
      qrImageTag = `<p style="color:red">Failed to generate QR image</p>`;
    }
  }

  const statusText = {
    starting: "Starting up...",
    waiting_qr: "Waiting for QR scan",
    connected: "Connected to WhatsApp",
    disconnected: "Disconnected — reconnecting..."
  }[botStatus] || botStatus;

  res.send(`
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WhatsApp Bot</title>
<style>
body {background:#0f172a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card {background:#1e293b;padding:40px;border-radius:20px;text-align:center;width:90%;max-width:420px}
</style>
</head>
<body>
<div class="card">
<h2>WhatsApp Bot</h2>
${botStatus === "connected"
  ? "<h1>✅ Connected</h1>"
  : currentQR
  ? qrImageTag
  : "<p>Starting...</p>"
}
</div>
</body>
</html>
  `);
});

app.listen(5000, "0.0.0.0", () => {
  console.log("Web UI running at http://0.0.0.0:5000");
});

// ---------------- Supabase Session Helpers ----------------
async function loadSession() {
  const { data, error } = await supabase
    .from(WA_TABLE)
    .select("auth_data")
    .limit(1)
    .single();

  if (error || !data?.auth_data) return null;

  try {
    const raw = typeof data.auth_data === "string" ? data.auth_data : JSON.stringify(data.auth_data);
    const parsed = JSON.parse(raw, BufferJSON.reviver);
    const creds = parsed?.creds ?? parsed;
    if (!creds || !creds.noiseKey) return null;
    return creds;
  } catch {
    return null;
  }
}

async function saveSession(creds) {
  const { error } = await supabase
    .from(WA_TABLE)
    .upsert({ id: 1, auth_data: JSON.stringify(creds, BufferJSON.replacer), updated_at: new Date().toISOString() });
  if (error) console.error("Error saving session:", error.message);
}

async function clearSession() {
  const { error } = await supabase
    .from(WA_TABLE)
    .upsert({ id: 1, auth_data: "{}", updated_at: new Date().toISOString() });
  if (error) console.error("Error clearing session:", error.message);
}

// ---------------- WhatsApp Bot Logic ----------------
async function startBot() {
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log(`Using WA v${version.join('.')}`);
  }

  let savedCreds = await loadSession();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  if (savedCreds) {
    state.creds = savedCreds;
    console.log("✅ Session loaded from Supabase!");
  }

  const sock = makeWASocket({
    version: waVersion,
    auth: state
  });

  let isConnected = false;
  sock.ev.on("creds.update", async () => {
    saveCreds();
    if (isConnected) await saveSession(state.creds);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "waiting_qr";
      console.log("📱 QR code updated — scan at the web preview");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      isConnected = true;
      botStatus = "connected";
      currentQR = null;
      console.log("✅ Bot connected!");
      await saveSession(state.creds);
    }
    if (connection === "close") {
      currentQR = null;
      botStatus = "disconnected";
      const err = lastDisconnect?.error;
      const statusCode = err?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isBadSession = err instanceof TypeError || (err && !statusCode);

      console.log(`❌ Connection closed. Code: ${statusCode}`);

      if (isLoggedOut || isBadSession) {
        console.log("🔒 Clearing session and restarting...");
        await clearSession();
        setTimeout(startBot, 3000);
      } else {
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const groupId = msg.key.remoteJid;
    if (!groupId.endsWith("@g.us")) return; // ignore DMs

    try {
      const sender = msg.key.participant || msg.key.remoteJid;
      const ext = msg.message?.extendedTextMessage || {};
      const mentionedJid = ext.contextInfo?.mentionedJid || [];

      // ---------------- Check if bot phone number is mentioned ----------------
      const isBotMentioned = mentionedJid.some(jid => jid.split("@")[0] === BOT_PHONE_NUMBER);
      if (!isBotMentioned) return;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      const command = text.trim().toLowerCase();
      const metadata = await sock.groupMetadata(groupId);
      if (!isAdmin(sender, metadata.participants)) return;
      if (!botActive && command !== ".activate") return;

      const validCommands = [
        ".kick",
        ".warn",
        ".tagall",
        ".delete",
        ".activate",
        ".deactivate"
      ];

      if (!validCommands.includes(command)) return;

      if (isActionRunning) {
        await sock.sendMessage(groupId, { text: "⚠️ Another command is running" });
        return;
      }

      isActionRunning = true;

      switch (command) {
        case ".tagall": {
          const users = metadata.participants;
          const batchSize = 20;
          for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);
            const mentions = batch.map(p => p.id);
            const tagText = batch.map(p => "@" + p.id.split("@")[0]).join(" ");
            await sock.sendMessage(groupId, { text: tagText, mentions });
            await delay(4000);
          }
          break;
        }

        case ".kick": {
          const targets = mentionedJid.filter(j => j.split("@")[0] !== BOT_PHONE_NUMBER);
          if (!targets.length) {
            await sock.sendMessage(groupId, { text: "Tag a user" });
            break;
          }
          for (const user of targets) {
            const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
            if (isTargetAdmin) {
              await sock.sendMessage(groupId, { text: "❌ Cannot remove admin" });
              continue;
            }
            await sock.groupParticipantsUpdate(groupId, [user], "remove");
            await delay(4000);
          }
          break;
        }

        case ".warn": {
          const targets = mentionedJid.filter(j => j.split("@")[0] !== BOT_PHONE_NUMBER);
          if (!targets.length) {
            await sock.sendMessage(groupId, { text: "Tag user to warn" });
            break;
          }
          await sock.sendMessage(groupId, { text: "⚠️ Warning issued", mentions: targets });
          break;
        }

        case ".delete": {
          const quoted = msg.message?.extendedTextMessage?.contextInfo;
          if (!quoted) {
            await sock.sendMessage(groupId, { text: "Reply to message to delete" });
            break;
          }
          await sock.sendMessage(groupId, {
            delete: {
              remoteJid: groupId,
              fromMe: false,
              id: quoted.stanzaId,
              participant: quoted.participant
            }
          });
          break;
        }

        case ".deactivate":
          botActive = false;
          await sock.sendMessage(groupId, { text: "Bot deactivated" });
          break;

        case ".activate":
          botActive = true;
          await sock.sendMessage(groupId, { text: "Bot activated" });
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(err);
    } finally {
      isActionRunning = false;
    }
  });
}

startBot();
