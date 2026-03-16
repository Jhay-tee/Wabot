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

// --------- Supabase Setup ----------
const SUPABASE_URL = "https://utuncywcoapsqudpovdt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0dW5jeXdjb2Fwc3F1ZHBvdmR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjM2NzMsImV4cCI6MjA4OTIzOTY3M30._wk8kY0hlLlAot66LraBaamz4N7b7juVV1T_mJwYyAU";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const WA_TABLE = "wa_sessions";

// --------- Express UI for QR ----------
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
    connected: "✅ Connected to WhatsApp",
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
${statusText === "✅ Connected to WhatsApp" ? "<h1>✅ Connected</h1>" : currentQR ? qrImageTag : "<p>Starting...</p>"}
</div>
</body>
</html>
  `);
});

app.listen(5000, "0.0.0.0", () => {
  console.log("Web UI running at http://0.0.0.0:5000");
});

// --------- Helper: Load Session from Supabase ----------
async function loadSession() {
  const { data, error } = await supabase
    .from(WA_TABLE)
    .select("auth_data")
    .limit(1)
    .single();

  if (error || !data?.auth_data) {
    console.log("No existing session found in Supabase.");
    return null;
  }

  try {
    const parsed = JSON.parse(data.auth_data, BufferJSON.reviver);
    return parsed?.creds ?? parsed;
  } catch (e) {
    console.error("Failed to parse session from Supabase:", e.message);
    return null;
  }
}

// --------- Helper: Save Session to Supabase ----------
async function saveSession(creds) {
  const { error } = await supabase
    .from(WA_TABLE)
    .upsert({ id: 1, auth_data: JSON.stringify(creds, BufferJSON.replacer), updated_at: new Date().toISOString() });
  if (error) console.error("Error saving session:", error.message);
}

// --------- Helper: Clear Session from Supabase ----------
async function clearSession() {
  const { error } = await supabase
    .from(WA_TABLE)
    .upsert({ id: 1, auth_data: "{}", updated_at: new Date().toISOString() });
  if (error) console.error("Error clearing session:", error.message);
  else console.log("🗑️ Corrupted session cleared from Supabase.");
}

// --------- WhatsApp Bot Logic ----------
async function startBot() {
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log(`Using WA v${version.join('.')}`);
  }

  let savedCreds = await loadSession();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  if (savedCreds) state.creds = savedCreds;

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

      if (isLoggedOut || isBadSession) {
        console.log("🔒 Logged out or corrupted session. Clearing session.");
        await clearSession();
        setTimeout(startBot, 3000);
      } else {
        console.log("❌ Connection closed. Reconnecting...");
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const groupId = msg.key.remoteJid;
    if (!groupId.endsWith("@g.us")) return;

    try {
      const sender = msg.key.participant || msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      const command = text.trim().toLowerCase();
      const ext = msg.message?.extendedTextMessage || {};
      const mentionedJid = ext.contextInfo?.mentionedJid || [];

      const metadata = await sock.groupMetadata(groupId);
      if (!isAdmin(sender, metadata.participants)) return; // Only admin triggers commands
      if (!botActive && command !== ".activate") return;

      const validCommands = [".kick", ".warn", ".tagall", ".delete", ".activate", ".deactivate"];
      if (!validCommands.includes(command)) return;
      if (isActionRunning) return;

      isActionRunning = true;

      switch (command) {
        case ".tagall": {
          const users = metadata.participants;
          for (let i = 0; i < users.length; i += 20) {
            const batch = users.slice(i, i + 20);
            const mentions = batch.map(p => p.id);
            const tagText = batch.map(p => "@" + p.id.split("@")[0]).join(" ");
            await sock.sendMessage(groupId, { text: tagText, mentions });
            await delay(4000);
          }
          break;
        }

        case ".kick": {
          const targets = mentionedJid.filter(j => j !== sock.user.id);
          if (!targets.length) {
            await sock.sendMessage(groupId, { text: "Tag a user to kick" });
            break;
          }
          for (const user of targets) {
            const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
            if (isTargetAdmin) {
              await sock.sendMessage(groupId, { text: "❌ Cannot remove admin" });
              continue;
            }
            await sock.groupParticipantsUpdate(groupId, [user], "remove");
            await sock.sendMessage(groupId, { text: "You have been removed from the group" });
            await delay(4000);
          }
          break;
        }

        case ".warn": {
          const targets = mentionedJid.filter(j => j !== sock.user.id);
          if (!targets.length) {
            await sock.sendMessage(groupId, { text: "Tag a user to warn" });
            break;
          }
          await sock.sendMessage(groupId, { text: "⚠️ Warning issued", mentions: targets });
          break;
        }

        case ".delete": {
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
        }

        case ".deactivate":
          botActive = false;
          await sock.sendMessage(groupId, { text: "Bot has been turned off" });
          break;

        case ".activate":
          botActive = true;
          await sock.sendMessage(groupId, { text: "Bot is now active and automation is on" });
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
