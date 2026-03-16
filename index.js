import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON
} from "@whiskeysockets/baileys";

import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { delay } from "./utils/helpers.js"; // your helper functions

// --------- CONFIG ---------
const SUPABASE_URL = "https://utuncywcoapsqudpovdt.supabase.co"; // your actual Supabase URL
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0dW5jeXdjb2Fwc3F1ZHBvdmR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjM2NzMsImV4cCI6MjA4OTIzOTY3M30._wk8kY0hlLlAot66LraBaamz4N7b7juVV1T_mJwYyAU"; // your actual anon key
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WA_TABLE = "wa_sessions";
const BOT_PHONE_NUMBER = "YOUR_BOT_PHONE_NUMBER"; // put your bot-linked number here

// --------- STATE ---------
let currentQR = null;
let botStatus = "starting";
let botActive = true;
let isActionRunning = false;
let waVersion = null;

// --------- EXPRESS SERVER ---------
const app = express();
app.get("/", async (req, res) => {
  let qrHtml = "";
  if (currentQR) {
    try {
      const dataUrl = await QRCode.toDataURL(currentQR);
      qrHtml = `<img src="${dataUrl}" style="width:80%; max-width:300px; height:auto; border-radius:12px; border:8px solid white"/>`;
    } catch {
      qrHtml = "<p style='color:red'>Failed to generate QR code</p>";
    }
  }

  const statusMap = {
    starting: "Starting up...",
    waiting_qr: "Waiting for QR scan",
    connected: "✅ Connected",
    disconnected: "Disconnected — reconnecting..."
  };
  const statusText = statusMap[botStatus] || botStatus;

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
${botStatus === "connected" ? "<h1>✅ Connected</h1>" : currentQR ? qrHtml : "<p>Starting...</p>"}
<p>Status: ${statusText}</p>
</div>
</body>
</html>
  `);
});

app.listen(5000, "0.0.0.0", () => {
  console.log("Web UI running at http://0.0.0.0:5000");
});

// --------- SUPABASE SESSION HELPERS ---------
async function loadSession() {
  const { data, error } = await supabase.from(WA_TABLE).select("auth_data").limit(1).single();
  if (error || !data?.auth_data) return null;

  try {
    const parsed = JSON.parse(data.auth_data, BufferJSON.reviver);
    return parsed?.creds ?? parsed;
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
  if (!error) console.log("🗑️ Cleared invalid session in Supabase.");
}

// --------- BOT LOGIC ---------
async function startBot() {
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log(`Using WA v${version.join(".")}`);
  }

  let savedCreds = await loadSession();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  if (savedCreds) {
    state.creds = savedCreds;
    console.log("✅ Loaded session from Supabase");
  }

  const sock = makeWASocket({ version: waVersion, auth: state });
  let isConnected = false;

  sock.ev.on("creds.update", async () => {
    saveCreds();
    if (isConnected) await saveSession(state.creds);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "waiting_qr";
      qrcodeTerminal.generate(qr, { small: true });
      console.log("📱 QR code updated, scan from web");
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
      const code = err?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      const isBadSession = err instanceof TypeError || (err && !code);

      console.log(`❌ Connection closed. Code: ${code}`);

      if (isLoggedOut || isBadSession) {
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
    if (!groupId.endsWith("@g.us")) return; // only group messages

    try {
      const sender = msg.key.participant || msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      const command = text.trim().toLowerCase();

      // Check if sender is admin
      const metadata = await sock.groupMetadata(groupId);
      const adminIds = metadata.participants.filter(p => p.admin).map(p => p.id);
      if (!adminIds.includes(sender)) return; // ignore non-admins

      if (!botActive && command !== ".activate") return;
      if (isActionRunning) {
        await sock.sendMessage(groupId, { text: "⚠️ Another command is running" });
        return;
      }

      isActionRunning = true;

      switch (command) {
        case ".activate":
          botActive = true;
          await sock.sendMessage(groupId, { text: "✅ Bot is now active, automation ON for admin users." });
          break;
        case ".deactivate":
          botActive = false;
          await sock.sendMessage(groupId, { text: "❌ Bot has been turned off." });
          break;
        case ".kick":
          const reply = msg.message?.extendedTextMessage?.contextInfo;
          if (!reply) {
            await sock.sendMessage(groupId, { text: "Reply to a message to kick the user." });
            break;
          }
          const target = reply.participant;
          if (!target) break;
          const isTargetAdmin = metadata.participants.find(p => p.id === target)?.admin;
          if (isTargetAdmin) {
            await sock.sendMessage(groupId, { text: "❌ Cannot remove admin" });
            break;
          }
          await sock.groupParticipantsUpdate(groupId, [target], "remove");
          await sock.sendMessage(groupId, { text: "User has been removed from the group." });
          break;
        case ".delete":
          const quoted = msg.message?.extendedTextMessage?.contextInfo;
          if (!quoted) break;
          await sock.sendMessage(groupId, {
            delete: {
              remoteJid: groupId,
              fromMe: false,
              id: quoted.stanzaId,
              participant: quoted.participant
            }
          });
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
