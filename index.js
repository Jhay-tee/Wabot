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

// -------- CONFIG --------
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";

// -------- HELPERS --------
const delay = ms => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  const user = participants.find(p => p.id === jid);
  return user && (user.admin === "admin" || user.admin === "superadmin");
};

const normalize = str => str.replace(/\s+/g, "").toLowerCase();

// -------- APP --------
const app = express();
let currentQR = null;
let botStatus = "starting";
let waVersion = null;
let sock = null;

// -------- SPAM TRACKER --------
const spamTracker = {};
const commandCooldown = {};

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// -------- LOAD SESSION --------
async function loadSession() {
  try {
    const { data } = await supabase
      .from(WA_TABLE)
      .select("auth_data")
      .eq("id", SESSION_ID)
      .maybeSingle();

    return data?.auth_data || null;
  } catch (err) {
    console.log("Load error:", err.message);
    return null;
  }
}

// -------- SAVE SESSION --------
let saveTimer;
async function scheduleSave(state) {
  if (!state?.creds || !state?.keys) return;
  
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await supabase.from(WA_TABLE).upsert({
        id: SESSION_ID,
        auth_data: { creds: state.creds, keys: state.keys },
        updated_at: new Date().toISOString()
      });
      console.log("💾 Session saved");
    } catch (err) {
      console.log("Save error:", err.message);
    }
  }, 1000);
}

// -------- CLEAR SESSION --------
async function clearSession() {
  try {
    await supabase.from(WA_TABLE).upsert({
      id: SESSION_ID,
      auth_data: null,
      updated_at: new Date().toISOString()
    });
    console.log("🗑️ Session cleared");
  } catch (err) {
    console.log("Clear error:", err.message);
  }
}

// -------- WEB SERVER - ALWAYS SHOW QR --------
app.get("/", async (req, res) => {
  // Always show QR code if available, regardless of session
  let content = "";
  
  if (currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    content = `
      <div>
        <h1 style="color:#fbbf24">📱 Scan QR Code</h1>
        <img src="${dataUrl}" style="width:300px; border:4px solid #334155; border-radius:8px"/>
        <p style="color:#94a3b8">Scan with WhatsApp to connect</p>
      </div>
    `;
  } else if (botStatus === "connected") {
    content = `<h1 style="color:#4ade80">✅ Bot Connected</h1>`;
  } else {
    content = `<h1 style="color:#60a5fa">🔄 Generating QR Code...</h1>
               <p>Please wait a few seconds</p>`;
  }

  res.send(`
    <html>
      <head>
        <style>
          body { 
            background: #0f172a; 
            color: white; 
            text-align: center; 
            font-family: system-ui; 
            padding: 2rem;
            margin: 0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          .container {
            max-width: 600px;
            background: #1e293b;
            padding: 2rem;
            border-radius: 1rem;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
          }
          h2 { color: #a78bfa; margin-top: 0; }
          .info { 
            background: #334155; 
            padding: 0.5rem; 
            border-radius: 0.5rem; 
            font-size: 0.875rem;
            color: #94a3b8;
            margin-top: 1rem;
          }
          .btn {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>🤖 WhatsApp Bot</h2>
          ${content}
          <div class="info">
            Status: ${botStatus}<br>
            QR Code: ${currentQR ? '✅ Available' : '⏳ Generating...'}<br>
            <small>Refresh page to check for QR</small>
          </div>
          <a href="/" class="btn">Refresh Page</a>
        </div>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => res.send("OK"));

// -------- START BOT --------
async function startBot() {
  // Get version
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
  }

  // Load session from Supabase (if exists)
  const loadedSession = await loadSession();
  const state = loadedSession || { creds: {}, keys: {} };
  
  console.log("🚀 Starting bot...");

  sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  // Save session when credentials update
  sock.ev.on("creds.update", () => scheduleSave(state));

  // Handle connection updates
  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    console.log("Update:", { connection, hasQR: !!qr });
    
    if (qr) {
      console.log("📱 QR Code generated - scan with WhatsApp");
      currentQR = qr;
      botStatus = "awaiting_scan";
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp");
      currentQR = null;
      botStatus = "connected";
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", code);
      
      if (code === DisconnectReason.loggedOut) {
        console.log("🚫 Logged out, clearing session");
        await clearSession();
      }
      
      botStatus = "disconnected";
      // Restart bot after 5 seconds
      setTimeout(() => startBot(), 5000);
    }
  });

  // -------- GROUP PARTICIPANTS UPDATE (WELCOME MESSAGES) --------
  sock.ev.on("group-participants.update", async (update) => {
    try {
      if (update.action === "add" && update.participants?.length > 0) {
        const groupJid = update.id;
        const mentions = update.participants;
        let groupName = "the group";
        try {
          const metadata = await sock.groupMetadata(groupJid);
          groupName = metadata.subject || "the group";
        } catch {}
        
        await sock.sendMessage(groupJid, {
          text: `👋 Hi ${mentions.map(u => `@${u.split("@")[0]}`).join(", ")}, welcome to ${groupName}!`,
          mentions
        });
      }
    } catch (err) { 
      console.log("Welcome error:", err.message);
    }
  });

  // -------- MESSAGES & COMMANDS --------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      
      let metadata;
      try {
        metadata = await sock.groupMetadata(jid);
      } catch {
        return;
      }
      
      const isUserAdmin = isAdmin(sender, metadata.participants);

      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ""
      ).trim();

      if (!text) return;

      // -------- ANTI-LINK --------
      const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
      if (!isUserAdmin && linkRegex.test(text)) {
        try {
          await sock.sendMessage(jid, { 
            delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } 
          });
          await sock.sendMessage(jid, { text: "🚫 No links allowed" });
        } catch {}
        return;
      }

      // -------- ANTI-SPAM --------
      if (!isUserAdmin) {
        const now = Date.now();
        if (!spamTracker[sender]) {
          spamTracker[sender] = { lastMsg: text, count: 1, time: now };
        } else {
          const user = spamTracker[sender];
          if (normalize(user.lastMsg) === normalize(text) && now - user.time < 5000) {
            user.count++;
          } else {
            user.count = 1;
          }
          user.lastMsg = text;
          user.time = now;
          
          if (user.count >= 4) {
            try {
              await sock.sendMessage(jid, { 
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } 
              });
              await sock.sendMessage(jid, { text: "🚫 No spamming" });
            } catch {}
            return;
          }
        }
      }

      // -------- COMMANDS (ADMIN ONLY) --------
      const command = text.toLowerCase();
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
        if (!targets.length) {
          await sock.sendMessage(jid, { text: "❌ Tag or reply to user" });
          return;
        }
        for (const user of targets) {
          const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
          if (isTargetAdmin) {
            await sock.sendMessage(jid, { text: "❌ Cannot remove admin" });
            continue;
          }
          await delay(500);
          await sock.groupParticipantsUpdate(jid, [user], "remove");
        }
      } else if (command === ".tagall") {
        const allMembers = metadata.participants.map(p => p.id);
        await sock.sendMessage(jid, { text: "📢 @everyone", mentions: allMembers });
      } else if (command === ".delete") {
        if (!ctx?.stanzaId) return;
        await sock.sendMessage(jid, { 
          delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant } 
        });
      } else if (command === ".help") {
        await sock.sendMessage(jid, { 
          text: `.lock - Lock group\n.unlock - Unlock group\n.kick - Remove user\n.tagall - Mention all\n.delete - Delete message\n.help - Show commands`
        });
      }

    } catch (err) {
      console.log("Msg error:", err.message);
    }
  });
}

// -------- START SERVER & BOT --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  console.log(`📱 Visit webpage to see QR code`);
  startBot();
});
