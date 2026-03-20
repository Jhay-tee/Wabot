// ======================= IMPORTS =======================
import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON, 
  makeCacheableSignalKeyStore 
} = pkg;

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// ======================= CONFIG =======================
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const BAILEYS_VERSION = [2, 3000, 1035194821]; // stable Baileys 6.7.2

// ======================= SUPABASE CLIENT =======================
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

// ======================= HELPERS =======================
const normalizeJid = (jid) => jid?.split("@")[0]?.split(":")[0] || "";

// ======================= WELCOME BATCHING =======================
const welcomeBuffers = new Map();
function scheduleWelcome(sock, groupJid, participants, groupName) {
  const valid = participants.map(p => typeof p === "string" ? p : p?.id).filter(Boolean);
  if (!valid.length) return;
  if (!welcomeBuffers.has(groupJid)) welcomeBuffers.set(groupJid, { participants: [] });
  const buffer = welcomeBuffers.get(groupJid);
  buffer.participants.push(...valid);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(async () => {
    const members = welcomeBuffers.get(groupJid)?.participants || [];
    welcomeBuffers.delete(groupJid);
    if (members.length && sock) {
      const mentionText = members.map(u => `@${u.split("@")[0]}`).join(", ");
      await sock.sendMessage(groupJid, {
        text: `👋 Welcome ${mentionText} to *${groupName}*!`,
        mentions: members
      });
    }
  }, 5000);
}

// ======================= SCHEDULED LOCK/UNLOCK =======================
const firedThisMinute = new Set();
function startScheduledLockChecker(sock) {
  return setInterval(async () => {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const nowStr = `${hh}:${mm.toString().padStart(2, "0")}`;
    const { data } = await supabase.from("group_scheduled_locks").select("group_jid, lock_time, unlock_time");
    if (!data) return;
    for (const row of data) {
      if (row.lock_time === nowStr) {
        const key = `lock_${row.group_jid}_${nowStr}`;
        if (!firedThisMinute.has(key)) {
          firedThisMinute.add(key);
          try {
            const meta = await sock.groupMetadata(row.group_jid);
            if (!meta.announce) {
              await sock.groupSettingUpdate(row.group_jid, { announce: true });
              await sock.sendMessage(row.group_jid, { text: `🔒 Auto-locked` });
            }
          } catch {}
          setTimeout(() => firedThisMinute.delete(key), 61000);
        }
      }
      if (row.unlock_time === nowStr) {
        const key = `unlock_${row.group_jid}_${nowStr}`;
        if (!firedThisMinute.has(key)) {
          firedThisMinute.add(key);
          try {
            const meta = await sock.groupMetadata(row.group_jid);
            if (meta.announce) {
              await sock.groupSettingUpdate(row.group_jid, { announce: false });
              await sock.sendMessage(row.group_jid, { text: `🔓 Auto-unlocked` });
            }
          } catch {}
          setTimeout(() => firedThisMinute.delete(key), 61000);
        }
      }
    }
  }, 60000);
}

// ======================= EXPRESS ENDPOINTS =======================
const app = express();

app.get("/", async (req, res) => {
  let qrImage = null;
  if (botStatus === "qr_ready" && currentQR) {
    qrImage = await QRCode.toDataURL(currentQR).catch(() => null);
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>WhatsApp Bot</title></head>
    <body>
      <h1>Bot Status: ${botStatus}</h1>
      ${qrImage ? `<img src="${qrImage}" style="width:300px;">` : '<p>No QR</p>'}
      <br><a href="/force-qr">Force New QR</a>
      <br><a href="/health">Health</a>
    </body>
    </html>
  `);
});

app.get("/force-qr", async (req, res) => {
  console.log("⚠️ /force-qr endpoint called");
  await supabase.from(WA_TABLE).update({ auth_data: null }).eq("id", SESSION_ID);
  creds = null;
  keys = {};
  currentQR = null;
  botStatus = "starting";
  if (sock) sock.end();
  res.redirect("/");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", botStatus, uptime: process.uptime() });
});

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
    console.log("📡", { connection, hasQR: !!qr });
    if (qr) {
      currentQR = qr;
      botStatus = "qr_ready";
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅✅✅ CONNECTED");
      botStatus = "connected";
      await saveSession();
      startScheduledLockChecker(sock);
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

  // ======================= GROUP PARTICIPANTS =======================
  sock.ev.on("group-participants.update", async ({ action, participants, id }) => {
    const botPhone = normalizeJid(sock.user?.id);
    if (["add", "invite", "linked_group_join"].includes(action)) {
      const nonBotParticipants = participants.filter(p => normalizeJid(p) !== botPhone);
      if (nonBotParticipants.length > 0) {
        const meta = await sock.groupMetadata(id);
        const groupName = meta.subject || "the group";
        scheduleWelcome(sock, id, nonBotParticipants, groupName);
      }
    }

    // Reset strikes when members leave
    if (action === "remove" || action === "leave") {
      for (const user of participants) {
        const normalizedUser = `${normalizeJid(user)}@s.whatsapp.net`;
        await supabase.from("group_strikes").delete()
          .eq("group_jid", id)
          .eq("user_jid", normalizedUser)
          .catch(() => {});
      }
    }
  });

  // ======================= MESSAGE HANDLER =======================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

      const rawSender = msg.key.participant || msg.key.remoteJid;
      if (!rawSender) return;
      const senderPhone = normalizeJid(rawSender);
      const sender = `${senderPhone}@s.whatsapp.net`;

      const metadata = await sock.groupMetadata(jid).catch(() => null);
      if (!metadata) return;

      let text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ""
      ).trim();

      if (!text) return;

      const command = text.toLowerCase().trim();
      const isCommand = command.startsWith(".");

      // ======================= COMMANDS =======================
      if (isCommand) {
        // Bot control
        if (command === ".bot on") {
          await sock.sendMessage(jid, { text: "✅ Bot active" });
        } else if (command === ".bot off") {
          await sock.sendMessage(jid, { text: "⏸️ Bot inactive" });
        }

        // Lock/unlock
        else if (command === ".lock") {
          const meta = await sock.groupMetadata(jid);
          if (!meta.announce) {
            await sock.groupSettingUpdate(jid, { announce: true });
            await sock.sendMessage(jid, { text: "🔒 Group locked" });
          } else {
            await sock.sendMessage(jid, { text: "🔒 Group is already locked" });
          }
        } else if (command === ".unlock") {
          const meta = await sock.groupMetadata(jid);
          if (meta.announce) {
            await sock.groupSettingUpdate(jid, { announce: false });
            await sock.sendMessage(jid, { text: "🔓 Group unlocked" });
          } else {
            await sock.sendMessage(jid, { text: "🔓 Group is already unlocked" });
          }
        }

        // Tagall
        else if (command === ".tagall") {
          const mentions = metadata.participants.map(p => p.id);
          const mentionText = mentions.map(u => `@${normalizeJid(u)}`).join(" ");
          await sock.sendMessage(jid, {
            text: `📢 Tagging all members:\n${mentionText}`,
            mentions
          });
        }

        // Kick
        else if (command.startsWith(".kick")) {
          const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
          const mentioned = ctx.mentionedJid || [];
          if (mentioned.length > 0) {
            await sock.groupParticipantsUpdate(jid, mentioned, "remove");
            await sock.sendMessage(jid, { text: `👢 Removed ${mentioned.map(u => `@${normalizeJid(u)}`).join(", ")}`, mentions: mentioned });
          } else {
            await sock.sendMessage(jid, { text: "❌ No user mentioned to kick." });
          }
        }

        // Status check
        else if (command === ".status") {
          await sock.sendMessage(jid, { text: `🤖 Bot status: ${botStatus}` });
        }
      }
    } catch (err) {
      console.error("❌ Message handler error:", err.message);
    }
  });
}

// ======================= START BOT =======================
startBot();
