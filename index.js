import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// -------- HELPERS --------
const delay = ms => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  const user = participants.find(p => p.id === jid);
  return user && (user.admin === "admin" || user.admin === "superadmin");
};

const normalize = str => str.replace(/\s+/g, "").toLowerCase();

// -------- APP --------
const app = express();

let currentQR = null;       // Holds QR if no valid session
let botStatus = "starting"; // "connected"
let waVersion = null;

// -------- SPAM TRACKER --------
const spamTracker = {};
const commandCooldown = {};

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const WA_TABLE = "wa_sessions";

// -------- SESSION VALIDATION --------
function isValidSession(session) {
  return (
    session &&
    session.creds &&
    session.creds.me &&
    session.creds.noiseKey &&
    session.creds.signedIdentityKey &&
    session.creds.signedPreKey &&
    session.creds.advSecretKey &&
    session.keys
  );
}

// -------- LOAD SESSION --------
async function loadSession() {
  const { data } = await supabase
    .from(WA_TABLE)
    .select("*")
    .eq("id", "main")
    .maybeSingle();

  if (!data?.auth_data) return null;
  if (isValidSession(data.auth_data)) {
    console.log("✅ Session loaded from Supabase");
    return data.auth_data;
  }

  console.log("⚠️ Session empty or corrupted, need new QR");
  return null;
}

// -------- SAVE SESSION --------
let saveTimer;
let isSaving = false;

function scheduleSave(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (isSaving) return;
    if (!isValidSession(state)) return;

    isSaving = true;
    try {
      await supabase.from(WA_TABLE).upsert({
        id: "main",
        auth_data: JSON.parse(JSON.stringify({ creds: state.creds, keys: state.keys })),
        updated_at: new Date().toISOString()
      });
      console.log("💾 Session saved to Supabase");
    } catch (err) {
      console.log("❌ Save error:", err.message);
    } finally {
      isSaving = false;
    }
  }, 1000);
}

// -------- CLEAR SESSION --------
async function clearSession() {
  await supabase.from(WA_TABLE).upsert({
    id: "main",
    auth_data: {},
    updated_at: new Date().toISOString()
  });
}

// -------- WEB QR & STATUS --------
app.get("/", async (req, res) => {
  let content = "";

  if (botStatus === "connected") {
    content = `<h1>✅ Connected</h1><p>Session exists in Supabase</p>`;
  } else if (currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    content = `<img src="${dataUrl}" style="width:250px"/>`;
  } else {
    content = "<p>Generating QR…</p>";
  }

  res.send(`
    <html>
      <body style="background:#0f172a;color:white;text-align:center">
        <h2>WhatsApp Bot</h2>
        ${content}
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Server running on port ${PORT}`));

// -------- BOT --------
async function startBot() {
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
  }

  const state = (await loadSession()) || { creds: {}, keys: {} };

  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", () => scheduleSave(state));

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      currentQR = qr;
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      currentQR = null;
      botStatus = "connected";
      console.log("✅ Connected to WhatsApp");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("🚫 Logged out, clearing session");
        await clearSession();
      }
      setTimeout(() => startBot().catch(console.error), 5000);
    }
  });

  // -------- WELCOME MESSAGES --------
  sock.ev.on("group-participants.update", async (update) => {
    try {
      if (update.action === "add" && update.participants?.length > 0) {
        const groupJid = update.id;
        const mentions = update.participants;

        let groupName = "";
        try { 
          const meta = await sock.groupMetadata(groupJid); 
          groupName = meta.subject || "";
        } catch {}

        await sock.sendMessage(groupJid, {
          text: `👋 Hi ${mentions.map(u => `@${u.split("@")[0]}`).join(", ")}, welcome to ${groupName}!\n\nPlease do not spam the group, do not send links or use vulgar words. Thank you, we are happy to have you.`,
          mentions
        });
      }
    } catch (err) {
      console.log("Welcome message error:", err.message);
    }
  });

  // -------- MESSAGES & COMMANDS --------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

      const sender = msg.key.participant;
      const metadata = await sock.groupMetadata(jid);
      const isUserAdmin = isAdmin(sender, metadata.participants);

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      if (!text) return;

      // -------- ANTI-LINK --------
      const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
      if (!isUserAdmin && linkRegex.test(text)) {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } });
        await sock.sendMessage(jid, { text: "🚫 No links allowed" });
        return;
      }

      // -------- ANTI-SPAM --------
      if (!isUserAdmin) {
        const now = Date.now();
        if (!spamTracker[sender]) spamTracker[sender] = { lastMsg: text, count: 1, time: now };
        else {
          const user = spamTracker[sender];
          if (normalize(user.lastMsg) === normalize(text) && now - user.time < 5000) user.count++;
          else user.count = 1;
          user.lastMsg = text; user.time = now;
          if (user.count >= 4) {
            await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } });
            await sock.sendMessage(jid, { text: "🚫 No spamming allowed" });
            user.count = 0; return;
          }
        }
      }

      // -------- VULGAR WORD FILTER --------
      const vulgarWords = ["fuck", "nigga", "bitch", "asshole", "shit"];
      const msgLower = text.toLowerCase();
      if (!isUserAdmin && vulgarWords.some(w => msgLower.includes(w))) {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } });
        await sock.sendMessage(jid, { text: "🚫 Vulgar words are not allowed" });
        return;
      }

      // -------- COMMANDS --------
      const command = text.trim().toLowerCase();
      if (!command.startsWith(".")) return;
      if (!isUserAdmin) return;

      // Cooldown
      if (commandCooldown[sender] && Date.now() - commandCooldown[sender] < 3000) return;
      commandCooldown[sender] = Date.now();

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // ---- LOCK ----
      if (command === ".lock") {
        await sock.groupSettingUpdate(jid, "announcement");
        await sock.sendMessage(jid, { text: "🔒 Group locked" });
      }

      // ---- UNLOCK ----
      else if (command === ".unlock") {
        await sock.groupSettingUpdate(jid, "not_announcement");
        await sock.sendMessage(jid, { text: "🔓 Group unlocked" });
      }

      // ---- KICK ----
      else if (command === ".kick") {
        let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
        if (!targets.length) return sock.sendMessage(jid, { text: "Tag or reply to user" });

        for (const user of targets) {
          const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
          if (isTargetAdmin) {
            await sock.sendMessage(jid, { text: "❌ Cannot remove admin" });
            continue;
          }
          await delay(500);
          await sock.groupParticipantsUpdate(jid, [user], "remove");
          await sock.sendMessage(jid, { text: `✅ Removed ${user.split("@")[0]}` });
        }
      }

      // ---- TAGALL ----
      else if (command === ".tagall") {
        const allMembers = metadata.participants.map(p => p.id);
        await sock.sendMessage(jid, { text: "@everyone", mentions: allMembers });
      }

      // ---- DELETE ----
      else if (command === ".delete") {
        if (!ctx?.stanzaId) return;
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant } });
      }

    } catch (err) {
      console.log("Handler error:", err.message);
    }
  });
}

startBot();
