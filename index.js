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
let reconnectAttempts = 0;
let sock = null; // Store socket globally

// -------- SPAM TRACKER --------
const spamTracker = {};
const commandCooldown = {};

// Clean up old tracker entries
setInterval(() => {
  const now = Date.now();
  Object.keys(spamTracker).forEach(key => {
    if (now - spamTracker[key].time > 3600000) delete spamTracker[key];
  });
  Object.keys(commandCooldown).forEach(key => {
    if (now - commandCooldown[key] > 60000) delete commandCooldown[key];
  });
}, 3600000);

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function testSupabase() {
  try {
    const { error } = await supabase.from(WA_TABLE).select("id").limit(1);
    if (error) throw error;
    console.log("✅ Supabase connected");
    return true;
  } catch (err) {
    console.log("❌ Supabase connection failed:", err.message);
    return false;
  }
}

// -------- SESSION VALIDATION --------
function isValidSession(session) {
  if (!session || !session.creds) return false;
  return !!(
    session.creds.me &&
    session.creds.noiseKey &&
    session.creds.signedIdentityKey &&
    session.creds.signedPreKey &&
    session.creds.advSecretKey
  );
}

// -------- LOAD SESSION --------
async function loadSession() {
  try {
    const { data } = await supabase
      .from(WA_TABLE)
      .select("*")
      .eq("id", SESSION_ID)
      .maybeSingle();

    if (!data?.auth_data) {
      console.log("📱 No session - QR will generate");
      return null;
    }
    
    if (isValidSession(data.auth_data)) {
      console.log("✅ Valid session loaded");
      return data.auth_data;
    }
    
    console.log("⚠️ Corrupted session - new QR");
    return null;
  } catch (err) {
    console.log("Load error:", err.message);
    return null;
  }
}

// -------- SAVE SESSION --------
let saveTimer;
let isSaving = false;

async function scheduleSave(state) {
  if (!state?.creds || !state?.keys || isSaving) return;
  
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    isSaving = true;
    try {
      await supabase.from(WA_TABLE).upsert({
        id: SESSION_ID,
        auth_data: { creds: state.creds, keys: state.keys },
        updated_at: new Date().toISOString()
      });
      console.log("💾 Session saved");
    } catch (err) {
      console.log("Save error:", err.message);
    } finally {
      isSaving = false;
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
    currentQR = null;
    botStatus = "starting";
  } catch (err) {
    console.log("Clear error:", err.message);
  }
}

// -------- WEB SERVER --------
app.get("/", async (req, res) => {
  const sessionData = await loadSession();
  const hasValidSession = sessionData && isValidSession(sessionData);
  
  let content = "";
  
  if (botStatus === "connected") {
    content = `<h1 style="color:#4ade80">✅ Connected</h1>`;
  } 
  else if (currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    content = `
      <div>
        <h1 style="color:#fbbf24">📱 Scan QR Code</h1>
        <img src="${dataUrl}" style="width:300px; border:4px solid #334155; border-radius:8px"/>
      </div>
    `;
  } 
  else {
    content = `<h1 style="color:#60a5fa">🔄 Generating QR...</h1>
               <p>Please wait 5-10 seconds</p>`;
  }

  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="3">
        <style>
          body { background: #0f172a; color: white; text-align: center; font-family: system-ui; padding: 2rem; }
          .container { max-width: 600px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 1rem; }
          .info { background: #334155; padding: 0.5rem; border-radius: 0.5rem; margin-top: 1rem; }
          .btn { background: #3b82f6; color: white; padding: 0.5rem 1rem; border-radius: 0.5rem; text-decoration: none; display: inline-block; margin: 0.5rem; }
          .btn.red { background: #dc2626; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>🤖 WhatsApp Bot</h2>
          ${content}
          <div class="info">
            Status: ${botStatus}<br>
            Session: ${hasValidSession ? '✅' : '❌'}<br>
            Attempts: ${reconnectAttempts}
          </div>
          <a href="/force-qr" class="btn red">Force New QR</a>
          <a href="/debug" class="btn">Debug</a>
        </div>
      </body>
    </html>
  `);
});

app.get("/force-qr", async (req, res) => {
  console.log("🔄 Force new QR");
  await clearSession();
  if (sock) {
    try { sock.end(); } catch {}
    sock = null;
  }
  currentQR = null;
  botStatus = "starting";
  reconnectAttempts = 0;
  setTimeout(() => startBot(), 1000);
  res.redirect("/");
});

app.get("/debug", async (req, res) => {
  const sessionData = await loadSession();
  res.json({
    botStatus,
    hasQR: !!currentQR,
    sessionInSupabase: !!sessionData,
    sessionValid: sessionData ? isValidSession(sessionData) : false,
    reconnectAttempts,
    uptime: process.uptime()
  });
});

app.get("/health", (req, res) => res.send("OK"));

// -------- START BOT --------
async function startBot() {
  // Don't start multiple instances
  if (sock) {
    console.log("Bot already running");
    return;
  }

  // Check Supabase
  const supabaseOk = await testSupabase();
  if (!supabaseOk) {
    setTimeout(startBot, 5000);
    return;
  }

  // Get version
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
  }

  // Load session
  const loadedSession = await loadSession();
  const state = loadedSession || { creds: {}, keys: {} };
  
  console.log("🚀 Starting bot...");
  botStatus = "starting";

  try {
    sock = makeWASocket({
      version: waVersion,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false
    });

    // Session save
    sock.ev.on("creds.update", () => scheduleSave(state));

    // Connection updates
    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      console.log("Update:", { connection, hasQR: !!qr });
      
      if (qr) {
        console.log("📱 QR READY - SCAN NOW");
        currentQR = qr;
        botStatus = "qr_ready";
        reconnectAttempts = 0;
        qrcode.generate(qr, { small: true });
        return;
      }

      if (connection === "open") {
        console.log("✅ CONNECTED!");
        currentQR = null;
        botStatus = "connected";
        reconnectAttempts = 0;
        sock.sendPresenceUpdate("available");
        return;
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("❌ Closed:", code);
        
        sock = null;
        
        if (code === DisconnectReason.loggedOut) {
          await clearSession();
          setTimeout(startBot, 2000);
          return;
        }
        
        reconnectAttempts++;
        const delayMs = Math.min(1000 * reconnectAttempts, 15000);
        console.log(`🔄 Reconnect in ${delayMs/1000}s`);
        setTimeout(startBot, delayMs);
      }
    });

    // Welcome messages
    sock.ev.on("group-participants.update", async (update) => {
      if (update.action === "add" && update.participants?.length > 0) {
        try {
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
        } catch (err) {
          console.log("Welcome error:", err.message);
        }
      }
    });

    // Message handler
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

        // Anti-link
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

        // Anti-spam
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

        // Commands
        const command = text.toLowerCase();
        if (!command.startsWith(".") || !isUserAdmin) return;

        if (commandCooldown[sender] && Date.now() - commandCooldown[sender] < 3000) return;
        commandCooldown[sender] = Date.now();

        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;

        if (command === ".lock") {
          await sock.groupSettingUpdate(jid, "announcement");
          await sock.sendMessage(jid, { text: "🔒 Locked" });
        } else if (command === ".unlock") {
          await sock.groupSettingUpdate(jid, "not_announcement");
          await sock.sendMessage(jid, { text: "🔓 Unlocked" });
        } else if (command === ".kick") {
          let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
          if (!targets.length) {
            await sock.sendMessage(jid, { text: "❌ Tag or reply" });
            return;
          }
          for (const user of targets) {
            const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
            if (isTargetAdmin) {
              await sock.sendMessage(jid, { text: "❌ Can't kick admin" });
              continue;
            }
            await delay(500);
            await sock.groupParticipantsUpdate(jid, [user], "remove");
          }
        } else if (command === ".tagall") {
          const allMembers = metadata.participants.map(p => p.id);
          await sock.sendMessage(jid, { text: "@everyone", mentions: allMembers });
        } else if (command === ".delete") {
          if (!ctx?.stanzaId) return;
          await sock.sendMessage(jid, { 
            delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant } 
          });
        } else if (command === ".help") {
          await sock.sendMessage(jid, { 
            text: `.lock\n.unlock\n.kick\n.tagall\n.delete\n.help`
          });
        }

      } catch (err) {
        console.log("Msg error:", err.message);
      }
    });

  } catch (err) {
    console.log("Start error:", err.message);
    sock = null;
    setTimeout(startBot, 5000);
  }
}

// -------- START --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server on port ${PORT}`);
  startBot();
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down");
  if (sock) sock.end();
  process.exit();
});
