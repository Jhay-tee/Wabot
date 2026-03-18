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

// -------- SESSION VALIDATION --------
function isValidSession(session) {
  if (!session || !session.creds) {
    console.log("❌ Session invalid: missing creds");
    return false;
  }
  
  const hasRequired = !!(
    session.creds.me &&
    session.creds.noiseKey &&
    session.creds.signedIdentityKey &&
    session.creds.signedPreKey &&
    session.creds.advSecretKey
  );
  
  if (hasRequired) {
    console.log("✅ Session is valid");
    console.log("📱 Connected as:", session.creds.me?.name || session.creds.me?.jid || "Unknown");
  } else {
    console.log("❌ Session invalid: missing required fields");
  }
  
  return hasRequired;
}

// -------- LOAD SESSION --------
async function loadSession() {
  try {
    console.log("🔍 Checking Supabase for existing session...");
    
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select("auth_data")
      .eq("id", SESSION_ID)
      .maybeSingle();

    if (error) {
      console.log("❌ Supabase query error:", error.message);
      return null;
    }

    if (!data || !data.auth_data) {
      console.log("📱 No session found in Supabase - will generate new QR");
      return null;
    }
    
    console.log("📦 Session data found in Supabase, validating...");
    
    if (isValidSession(data.auth_data)) {
      console.log("✅ Valid session loaded from Supabase");
      return data.auth_data;
    } else {
      console.log("⚠️ Session in Supabase is corrupted - will generate new QR");
      return null;
    }
    
  } catch (err) {
    console.log("❌ Load session error:", err.message);
    return null;
  }
}

// -------- SAVE SESSION --------
let saveTimer;
async function scheduleSave(state) {
  if (!state?.creds || !state?.keys) {
    console.log("⚠️ Cannot save: invalid state");
    return;
  }
  
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      console.log("💾 Saving session to Supabase...");
      
      const { error } = await supabase.from(WA_TABLE).upsert({
        id: SESSION_ID,
        auth_data: { creds: state.creds, keys: state.keys },
        updated_at: new Date().toISOString()
      });
      
      if (error) throw error;
      
      console.log("✅ Session saved successfully to Supabase");
      console.log("📱 Connected as:", state.creds.me?.name || state.creds.me?.jid || "Unknown");
      
    } catch (err) {
      console.log("❌ Save error:", err.message);
    }
  }, 1000);
}

// -------- CLEAR SESSION --------
async function clearSession() {
  try {
    console.log("🗑️ Clearing session from Supabase...");
    
    const { error } = await supabase.from(WA_TABLE).upsert({
      id: SESSION_ID,
      auth_data: null,
      updated_at: new Date().toISOString()
    });
    
    if (error) throw error;
    
    console.log("✅ Session cleared successfully");
  } catch (err) {
    console.log("❌ Clear session error:", err.message);
  }
}

// -------- WEB SERVER --------
app.get("/", async (req, res) => {
  let qrImage = "";
  
  if (currentQR && currentQR !== "Loading...") {
    try {
      qrImage = await QRCode.toDataURL(currentQR);
    } catch {
      qrImage = "";
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot</title>
      <meta http-equiv="refresh" content="3">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 20px;
        }
        .card {
          background: white;
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
          text-align: center;
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 28px;
        }
        .subtitle {
          color: #666;
          margin-bottom: 30px;
          font-size: 16px;
        }
        .qr-container {
          background: #f5f5f5;
          border-radius: 15px;
          padding: 30px;
          margin-bottom: 20px;
          min-height: 350px;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .qr-image {
          max-width: 300px;
          width: 100%;
          height: auto;
          border-radius: 10px;
        }
        .loading {
          color: #666;
          font-size: 18px;
        }
        .steps {
          text-align: left;
          background: #f8f9fa;
          border-radius: 10px;
          padding: 20px;
          margin-top: 20px;
        }
        .steps h3 {
          color: #333;
          margin-bottom: 10px;
        }
        .steps ol {
          color: #555;
          padding-left: 20px;
        }
        .steps li {
          margin: 8px 0;
        }
        .status {
          margin-top: 15px;
          color: #28a745;
          font-weight: 500;
        }
        .force-btn {
          display: inline-block;
          background: #dc2626;
          color: white;
          text-decoration: none;
          padding: 10px 20px;
          border-radius: 5px;
          margin-top: 15px;
          font-size: 14px;
          border: none;
          cursor: pointer;
        }
        .force-btn:hover {
          background: #b91c1c;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🤖 WhatsApp Bot</h1>
        <p class="subtitle">Scan QR code to connect your WhatsApp</p>
        
        <div class="qr-container">
          ${qrImage ? `<img src="${qrImage}" class="qr-image" alt="QR Code">` : '<div class="loading">⏳ Generating QR Code...</div>'}
        </div>

        <div class="steps">
          <h3>📱 How to connect:</h3>
          <ol>
            <li>Open WhatsApp on your phone</li>
            <li>Tap Menu (3 dots) or Settings</li>
            <li>Select "Linked Devices"</li>
            <li>Tap "Link a Device"</li>
            <li>Scan this QR code</li>
          </ol>
        </div>

        <div class="status">
          ${botStatus === "connected" ? "✅ Bot is active and connected" : "⏳ Waiting for scan..."}
        </div>

        <a href="/force-qr" class="force-btn">🔄 Force New QR Code</a>
      </div>
    </body>
    </html>
  `);
});

app.get("/force-qr", async (req, res) => {
  console.log("\n🔄🔄🔄 FORCING NEW QR CODE 🔄🔄🔄\n");
  
  await clearSession();
  currentQR = null;
  botStatus = "starting";
  
  if (sock) {
    try {
      sock.end();
      sock = null;
    } catch (err) {
      console.log("Error closing socket:", err.message);
    }
  }
  
  setTimeout(() => startBot(), 1000);
  res.redirect("/");
});

app.get("/health", (req, res) => res.send("OK"));

app.get("/status", async (req, res) => {
  const session = await loadSession();
  res.json({
    botStatus,
    hasQR: !!currentQR,
    hasValidSession: session ? isValidSession(session) : false,
    uptime: process.uptime()
  });
});

// -------- START BOT --------
async function startBot() {
  try {
    console.log("\n🚀🚀🚀 STARTING BOT 🚀🚀🚀\n");
    
    if (!waVersion) {
      console.log("📱 Fetching latest Baileys version...");
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version;
      console.log("✅ Using version:", waVersion);
    }

    const loadedSession = await loadSession();
    const state = loadedSession || { creds: {}, keys: {} };
    
    if (loadedSession) {
      console.log("✅ Using existing session from Supabase");
    } else {
      console.log("🆕 Starting with fresh session - QR will generate");
    }
    
    currentQR = "Loading...";

    if (sock) {
      try {
        sock.end();
        sock = null;
      } catch (err) {
        console.log("Error closing socket:", err.message);
      }
    }

    sock = makeWASocket({
      version: waVersion,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on("creds.update", () => scheduleSave(state));

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      console.log("📡 Connection update:", { connection, hasQR: !!qr });
      
      if (qr) {
        console.log("\n✅✅✅ QR CODE GENERATED ✅✅✅");
        console.log("📱 Scan this QR code with WhatsApp\n");
        currentQR = qr;
        botStatus = "awaiting_scan";
        qrcode.generate(qr, { small: true });
        return;
      }

      if (connection === "open") {
        console.log("\n✅✅✅ CONNECTED TO WHATSAPP ✅✅✅\n");
        console.log("📱 Bot is now active and monitoring groups");
        currentQR = null;
        botStatus = "connected";
        try {
          await sock.sendPresenceUpdate("available");
        } catch {}
        return;
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("🔌 Connection closed with code:", code);
        
        if (botStatus === "connected" || currentQR) {
          console.log("ℹ️ Ignoring close - already connected or have QR");
          return;
        }
        
        if (code === DisconnectReason.loggedOut) {
          console.log("🚫 Logged out - clearing session");
          await clearSession();
          currentQR = null;
          setTimeout(() => startBot(), 2000);
          return;
        }
        
        console.log("🔄 Network issue - reconnecting in 5 seconds...");
        setTimeout(() => startBot(), 5000);
      }
    });

    // -------- GROUP PARTICIPANTS UPDATE --------
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
          console.log("👋 Welcome sent to", mentions.length, "new members");
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

  } catch (err) {
    console.log("❌ Start error:", err.message);
    setTimeout(startBot, 5000);
  }
}

// -------- START SERVER --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  console.log(`📱 Visit the URL to see QR code\n`);
  startBot();
});

// -------- GRACEFUL SHUTDOWN --------
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  if (sock) {
    try {
      sock.end();
    } catch {}
  }
  process.exit();
});
