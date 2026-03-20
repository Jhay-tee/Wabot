// ======================= IMPORTS =======================
import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } = pkg;

import qrcode from "qrcode-terminal";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// ======================= CONFIG =======================
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const BAILEYS_VERSION = [2, 3000, 1035194821];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

let sock = null;
let creds = null;
let keys = {};
let botStatus = "starting";
let currentQR = null;

// ======================= SESSION PERSISTENCE =======================
let _keySaveTimer = null;
function scheduleKeySave() {
  if (_keySaveTimer) clearTimeout(_keySaveTimer);
  _keySaveTimer = setTimeout(() => {
    _keySaveTimer = null;
    saveSession().catch(() => {});
  }, 800);
}

async function loadSession() {
  const { data } = await supabase.from(WA_TABLE).select("auth_data").eq("id", SESSION_ID).maybeSingle();
  if (!data?.auth_data) {
    creds = null;
    keys = {};
    return false;
  }
  const session = JSON.parse(data.auth_data, BufferJSON.reviver);
  creds = session.creds || initAuthCreds();
  keys = session.keys || {};
  return true;
}

async function saveSession() {
  if (!creds) return false;
  const serialized = JSON.stringify({ creds, keys }, BufferJSON.replacer);
  await supabase.from(WA_TABLE).upsert({ id: SESSION_ID, auth_data: serialized });
  console.log("✅ Session saved");
  return true;
}

// ======================= EXPRESS ENDPOINTS =======================
const app = express();
app.get("/", (req, res) => {
  res.send(`<h1>Bot Status: ${botStatus}</h1>${currentQR ? "<p>QR ready in console</p>" : ""}`);
});
app.get("/health", (req, res) => res.json({ status: "ok", botStatus, uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Express running on port ${PORT}`));

// ======================= BOT STARTUP =======================
async function startBot() {
  await loadSession();
  const logger = pino({ level: "silent" });

  const rawKeyStore = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids || []) {
        if (keys[type]?.[id] !== undefined) data[id] = keys[type][id];
      }
      return data;
    },
    set: async (data) => {
      for (const cat in data) {
        keys[cat] = keys[cat] || {};
        for (const id in data[cat]) {
          if (data[cat][id] == null) delete keys[cat][id];
          else keys[cat][id] = data[cat][id];
        }
      }
      scheduleKeySave();
    }
  };

  const keysHandler = makeCacheableSignalKeyStore(rawKeyStore, logger);

  sock = makeWASocket({
    version: BAILEYS_VERSION,
    auth: { creds: creds || initAuthCreds(), keys: keysHandler },
    logger,
    printQRInTerminal: true
  });

  sock.ev.on("connection.update", async ({ connection, qr }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "qr_ready";
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      botStatus = "connected";
      await saveSession();
      console.log("✅ CONNECTED");
      // give Baileys time to sync sessions
      setTimeout(() => console.log("🔑 Sessions ready for sending"), 15000);
    }
    if (connection === "close") {
      botStatus = "disconnected";
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on("creds.update", async () => {
    creds = sock.authState.creds;
    await saveSession();
  });

  // ======================= MESSAGE HANDLER =======================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith("@g.us")) return;

      const metadata = await sock.groupMetadata(jid).catch(() => null);
      if (!metadata) return;

      let text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ""
      ).trim();

      if (!text.startsWith(".")) return;
      const command = text.toLowerCase();

      if (command === ".lock") {
        await sock.groupSettingUpdate(jid, { announce: true });
        await sock.sendMessage(jid, { text: "🔒 Group locked successfully" });
      } else if (command === ".unlock") {
        await sock.groupSettingUpdate(jid, { announce: false });
        await sock.sendMessage(jid, { text: "🔓 Group unlocked successfully" });
      } else if (command === ".tagall") {
        const mentions = metadata.participants.map(p => p.id);
        const mentionText = mentions.map(u => `@${u.split("@")[0]}`).join(" ");
        await sock.sendMessage(jid, {
          text: `📢 Tagging all members:\n${mentionText}`,
          mentions
        });
      } else if (command.startsWith(".kick")) {
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        if (mentioned.length > 0) {
          await sock.groupParticipantsUpdate(jid, mentioned, "remove");
          await sock.sendMessage(jid, { 
            text: `👢 Removed ${mentioned.map(u => `@${u.split("@")[0]}`).join(", ")}`, 
            mentions: mentioned 
          });
        } else {
          await sock.sendMessage(jid, { text: "❌ No user mentioned to kick." });
        }
      }
    } catch (err) {
      console.error("❌ Message handler error:", err.message);
    }
  });
}

startBot(); 
