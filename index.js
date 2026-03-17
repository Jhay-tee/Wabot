
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
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

// -------- EXPRESS APP --------
const app = express();
let currentQR = null;
let botStatus = "starting";
let waVersion = null;

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

// -------- SUPABASE BACKUP --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const WA_TABLE = "wa_sessions";

// Safe backup to Supabase
let saveTimer;
let isSaving = false;
function scheduleSave(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (isSaving) return;
    isSaving = true;
    try {
      await supabase.from(WA_TABLE).upsert({
        id: "main",
        auth_data: JSON.parse(JSON.stringify(state)),
        updated_at: new Date().toISOString()
      });
      console.log("💾 Session saved to Supabase");
    } catch (err) {
      console.log("❌ Supabase save error:", err.message);
    } finally {
      isSaving = false;
    }
  }, 1000);
}

async function clearSession() {
  await supabase.from(WA_TABLE).upsert({
    id: "main",
    auth_data: {},
    updated_at: new Date().toISOString()
  });
}

// -------- WEB ROUTES --------
app.get("/", async (req, res) => {
  let qrHtml = "";
  if (currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    qrHtml = `<img src="${dataUrl}" style="width:250px"/>`;
  }
  res.send(`
    <html>
      <body style="background:#0f172a;color:white;text-align:center">
        <h2>WhatsApp Bot</h2>
        ${botStatus === "connected" ? "<h1>✅ Connected</h1>" : qrHtml}
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => res.send("OK"));

// -------- BOT --------
async function startBot() {
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
  }

  // ----------------
  // Use multi-file auth state
  // ----------------
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  // Try to restore from Supabase if available
  try {
    const { data } = await supabase.from(WA_TABLE).select("*").eq("id", "main").maybeSingle();
    if (data?.auth_data) {
      Object.assign(state, data.auth_data);
      console.log("✅ Session restored from Supabase");
    }
  } catch (err) {
    console.log("⚠️ Supabase restore failed:", err.message);
  }

  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: "silent" })
  });

  // ----------------
  // Save session on update
  // ----------------
  sock.ev.on("creds.update", async () => {
    await saveCreds(); // local file
    scheduleSave(state); // Supabase backup
  });

  // ----------------
  // Connection events
  // ----------------
  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "waiting_qr";
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      currentQR = null;
      botStatus = "connected";
      console.log("✅ Connected");
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

  // ----------------
  // Welcome new group participants
  // ----------------
  sock.ev.on("group-participants.update", async (update) => {
    if (update.action === "add") {
      for (const user of update.participants) {
        await sock.sendMessage(update.id, {
          text: `👋 Hi @${user.split("@")[0]}, welcome!\n\n🚫 No links\n🚫 No spam`,
          mentions: [user]
        });
      }
    }
  });

  // ----------------
  // Messages / Commands / Anti-spam / Anti-link
  // ----------------
  const spamTracker = {};
  const commandCooldown = {};

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

      // Anti-link
      const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
      if (!isUserAdmin && linkRegex.test(text)) {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } });
        await sock.sendMessage(jid, { text: "🚫 No links allowed" });
        return;
      }

      // Anti-spam
      const now = Date.now();
      if (!isUserAdmin) {
        if (!spamTracker[sender]) spamTracker[sender] = { lastMsg: text, count: 1, time: now };
        else {
          const user = spamTracker[sender];
          if (normalize(user.lastMsg) === normalize(text) && now - user.time < 5000) user.count++;
          else user.count = 1;
          user.lastMsg = text;
          user.time = now;
          if (user.count >= 4) {
            await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } });
            await sock.sendMessage(jid, { text: "🚫 No spamming allowed" });
            user.count = 0;
            return;
          }
        }
      }

      // Commands
      const command = text.trim().toLowerCase();
      if (!command.startsWith(".") || !isUserAdmin) return;

      if (commandCooldown[sender] && Date.now() - commandCooldown[sender] < 3000) return;
      commandCooldown[sender] = Date.now();

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      if (command === ".lock") {
        await sock.groupSettingUpdate(jid, "announcement");
        await sock.sendMessage(jid, { text: "🔒 Group locked" });
      } else if (command === ".unlock") {
        await sock.groupSettingUpdate(jid, "not_announcement");
        await sock.sendMessage(jid, { text: "🔓 Group unlocked" });
      } else if (command === ".kick") {
        let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
        if (!targets.length) return sock.sendMessage(jid, { text: "Tag or reply to user" });
        for (const user of targets) {
          const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
          if (isTargetAdmin) {
            await sock.sendMessage(jid, { text: "❌ Cannot remove admin" });
            continue;
          }
          await sock.groupParticipantsUpdate(jid, [user], "remove");
          await sock.sendMessage(jid, { text: "✅ Removed user" });
          await delay(2000);
        }
      } else if (command === ".delete") {
        if (!ctx?.stanzaId) return;
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant } });
      }

    } catch (err) {
      console.log("Handler error:", err.message);
    }
  });
}

startBot();
