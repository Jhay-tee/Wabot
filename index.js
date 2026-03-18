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
const SESSION_ID = 1; // main session id
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
const maxReconnectDelay = 30000;

// -------- SPAM TRACKER --------
const spamTracker = {};
const commandCooldown = {};

// Clean up old tracker entries every hour
setInterval(() => {
  const now = Date.now();
  Object.keys(spamTracker).forEach(key => {
    if (now - spamTracker[key].time > 3600000) {
      delete spamTracker[key];
    }
  });
  Object.keys(commandCooldown).forEach(key => {
    if (now - commandCooldown[key] > 60000) {
      delete commandCooldown[key];
    }
  });
}, 3600000);

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Test Supabase connection on startup
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
  
  // Check if session has required fields
  const hasRequired = (
    session.creds.me &&
    session.creds.noiseKey &&
    session.creds.signedIdentityKey &&
    session.creds.signedPreKey &&
    session.creds.advSecretKey
  );
  
  return !!hasRequired;
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
      console.log("📱 No session found - QR code will be generated");
      return null;
    }
    
    if (isValidSession(data.auth_data)) {
      console.log("✅ Valid session loaded from Supabase");
      return data.auth_data;
    }
    
    console.log("⚠️ Corrupted session found - will generate new QR");
    return null;
  } catch (err) {
    console.log("Supabase load error:", err.message);
    return null;
  }
}

// -------- SAVE SESSION --------
let saveTimer;
let isSaving = false;
let pendingSave = null;

async function scheduleSave(state) {
  if (!state || !isValidSession(state)) return;
  
  if (isSaving) {
    pendingSave = state;
    return;
  }
  
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    isSaving = true;
    try {
      await supabase.from(WA_TABLE).upsert({
        id: SESSION_ID,
        auth_data: JSON.parse(JSON.stringify({ 
          creds: state.creds, 
          keys: state.keys 
        })),
        updated_at: new Date().toISOString()
      });
      console.log("💾 Session saved to Supabase");
      
      if (pendingSave) {
        const saveState = pendingSave;
        pendingSave = null;
        await scheduleSave(saveState);
      }
    } catch (err) {
      console.log("❌ Save error:", err.message);
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
    console.log("🗑️ Session cleared from Supabase");
    currentQR = null;
    botStatus = "logged_out";
  } catch (err) {
    console.log("❌ Clear session error:", err.message);
  }
}

// -------- WEB SERVER --------
app.get("/", async (req, res) => {
  let content = "";
  const sessionData = await loadSession();
  const hasValidSession = sessionData && isValidSession(sessionData);
  
  if (botStatus === "connected") {
    content = `<h1 style="color:#4ade80">✅ Connected</h1>
               <p>Bot is active and connected to WhatsApp</p>`;
  } 
  else if (currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    content = `
      <div>
        <h1 style="color:#fbbf24">📱 Scan QR Code</h1>
        <img src="${dataUrl}" style="width:300px; border:4px solid #334155; border-radius:8px"/>
        <p>Scan with WhatsApp to connect</p>
      </div>
    `;
  } 
  else if (!hasValidSession && botStatus !== "connected") {
    content = `<h1 style="color:#f87171">⏳ Generating QR Code...</h1>
               <p>No valid session found. Please wait for QR code to appear.</p>`;
  }
  else {
    content = `<h1 style="color:#60a5fa">🔄 Initializing...</h1>
               <p>Bot is starting up. Please wait...</p>`;
  }

  res.send(`
    <html>
      <head>
        <meta http-equiv="refresh" content="5">
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
        </style>
      </head>
      <body>
        <div class="container">
          <h2>🤖 WhatsApp Bot</h2>
          ${content}
          <div class="info">
            Status: ${botStatus}<br>
            Session: ${hasValidSession ? '✅ Valid' : '❌ None/Invalid'}<br>
            Auto-refreshes every 5s
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => res.send("OK"));

app.get("/debug", async (req, res) => {
  const sessionData = await loadSession();
  res.json({
    botStatus,
    hasQR: !!currentQR,
    sessionInSupabase: !!sessionData,
    sessionValid: sessionData ? isValidSession(sessionData) : false,
    reconnectAttempts,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// -------- START BOT --------
async function startBot() {
  // Test Supabase first
  const supabaseOk = await testSupabase();
  if (!supabaseOk) {
    console.log("❌ Cannot start without Supabase");
    process.exit(1);
  }

  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log("📱 Using Baileys version:", waVersion);
  }

  // Load session or start fresh
  const state = (await loadSession()) || { creds: {}, keys: {} };
  
  console.log("🚀 Starting bot...");
  
  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false, // We handle QR manually
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  // Handle session updates
  sock.ev.on("creds.update", () => scheduleSave(state));

  // Handle connection updates
  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    console.log("Connection update:", { connection, hasQR: !!qr });
    
    if (qr) {
      console.log("📱 QR Code generated - scan with WhatsApp");
      currentQR = qr;
      botStatus = "awaiting_scan";
      
      // Show in terminal
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp");
      currentQR = null;
      botStatus = "connected";
      reconnectAttempts = 0;
      
      // Set presence online
      await sock.sendPresenceUpdate("available");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed with code:", code);
      
      if (code === DisconnectReason.loggedOut) {
        console.log("🚫 Logged out, clearing session");
        await clearSession();
      }
      
      // Exponential backoff for reconnection
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
      reconnectAttempts++;
      
      console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts})`);
      setTimeout(() => startBot(), delay);
    }
  });

  // -------- GROUP PARTICIPANTS UPDATE (WELCOME MESSAGES) --------
  sock.ev.on("group-participants.update", async (update) => {
    try {
      if (update.action === "add" && update.participants?.length > 0) {
        const groupJid = update.id;
        const mentions = update.participants;
        
        // Get group name safely
        let groupName = "the group";
        try {
          const metadata = await sock.groupMetadata(groupJid);
          groupName = metadata.subject || "the group";
        } catch {}
        
        // Send welcome message
        await sock.sendMessage(groupJid, {
          text: `👋 Hi ${mentions.map(u => `@${u.split("@")[0]}`).join(", ")}, welcome to ${groupName}!\n\n📌 Please follow the rules:\n• No spamming\n• No links\n• No vulgar words\n• Be respectful\n\nEnjoy your stay! 🎉`,
          mentions
        });
        
        console.log(`👋 Welcome message sent to ${mentions.length} new member(s)`);
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
      
      // Ignore status broadcasts and non-group messages
      if (jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      
      // Get group metadata
      let metadata;
      try {
        metadata = await sock.groupMetadata(jid);
      } catch {
        return; // Can't process without metadata
      }
      
      const isUserAdmin = isAdmin(sender, metadata.participants);

      // Extract message text
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ""
      ).trim();

      if (!text) return;

      // -------- ANTI-LINK --------
      const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
      if (!isUserAdmin && linkRegex.test(text)) {
        try {
          await sock.sendMessage(jid, { 
            delete: { 
              remoteJid: jid, 
              fromMe: false, 
              id: msg.key.id, 
              participant: sender 
            } 
          });
          await sock.sendMessage(jid, { text: "🚫 @" + sender.split("@")[0] + " links are not allowed", mentions: [sender] });
        } catch {}
        return;
      }

      // -------- ANTI-SPAM --------
      if (!isUserAdmin) {
        const now = Date.now();
        if (!spamTracker[sender]) {
          spamTracker[sender] = { 
            lastMsg: text, 
            count: 1, 
            time: now,
            lastWarning: 0
          };
        } else {
          const user = spamTracker[sender];
          
          // Reset if different message or too much time passed
          if (normalize(user.lastMsg) !== normalize(text) || now - user.time > 5000) {
            user.count = 1;
          } else {
            user.count++;
          }
          
          user.lastMsg = text;
          user.time = now;
          
          // Check for spam (4+ identical messages in 5 seconds)
          if (user.count >= 4 && now - user.lastWarning > 30000) {
            try {
              await sock.sendMessage(jid, { 
                delete: { 
                  remoteJid: jid, 
                  fromMe: false, 
                  id: msg.key.id, 
                  participant: sender 
                } 
              });
              await sock.sendMessage(jid, { 
                text: "🚫 @" + sender.split("@")[0] + " no spamming allowed", 
                mentions: [sender] 
              });
              user.lastWarning = now;
              user.count = 0;
            } catch {}
            return;
          }
          
          spamTracker[sender] = user;
        }
      }

      // -------- VULGAR WORD FILTER --------
      const vulgarWords = ["fuck", "nigga", "bitch", "asshole", "shit", "pussy", "dick"];
      const containsVulgar = vulgarWords.some(w => 
        text.toLowerCase().includes(w) || 
        text.toLowerCase().replace(/[^a-zA-Z]/g, "").includes(w)
      );
      
      if (!isUserAdmin && containsVulgar) {
        try {
          await sock.sendMessage(jid, { 
            delete: { 
              remoteJid: jid, 
              fromMe: false, 
              id: msg.key.id, 
              participant: sender 
            } 
          });
          await sock.sendMessage(jid, { 
            text: "🚫 @" + sender.split("@")[0] + " vulgar words are not allowed", 
            mentions: [sender] 
          });
        } catch {}
        return;
      }

      // -------- COMMANDS (ADMIN ONLY) --------
      const command = text.toLowerCase();
      if (!command.startsWith(".") || !isUserAdmin) return;
      
      // Cooldown for commands
      if (commandCooldown[sender] && Date.now() - commandCooldown[sender] < 3000) return;
      commandCooldown[sender] = Date.now();

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // .lock - Lock group
      if (command === ".lock") {
        await sock.groupSettingUpdate(jid, "announcement");
        await sock.sendMessage(jid, { text: "🔒 Group locked (only admins can message)" });
      }
      
      // .unlock - Unlock group
      else if (command === ".unlock") {
        await sock.groupSettingUpdate(jid, "not_announcement");
        await sock.sendMessage(jid, { text: "🔓 Group unlocked (everyone can message)" });
      }
      
      // .kick - Remove user(s)
      else if (command === ".kick") {
        let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
        
        if (!targets.length) {
          await sock.sendMessage(jid, { text: "❌ Tag or reply to user to kick" });
          return;
        }

        for (const user of targets) {
          // Check if target is admin
          const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
          if (isTargetAdmin) {
            await sock.sendMessage(jid, { text: "❌ Cannot remove admin" });
            continue;
          }
          
          await delay(500);
          await sock.groupParticipantsUpdate(jid, [user], "remove");
          await sock.sendMessage(jid, { text: `✅ Removed @${user.split("@")[0]}`, mentions: [user] });
        }
      }
      
      // .tagall - Mention all members
      else if (command === ".tagall") {
        const allMembers = metadata.participants.map(p => p.id);
        await sock.sendMessage(jid, { 
          text: "📢 @everyone", 
          mentions: allMembers 
        });
      }
      
      // .delete - Delete message
      else if (command === ".delete") {
        if (!ctx?.stanzaId) {
          await sock.sendMessage(jid, { text: "❌ Reply to a message to delete it" });
          return;
        }
        
        await sock.sendMessage(jid, { 
          delete: { 
            remoteJid: jid, 
            fromMe: false, 
            id: ctx.stanzaId, 
            participant: ctx.participant 
          } 
        });
      }
      
      // .help - Show commands
      else if (command === ".help") {
        await sock.sendMessage(jid, { 
          text: `📋 *Admin Commands*\n\n🔒 .lock - Lock group\n🔓 .unlock - Unlock group\n👢 .kick - Remove user (reply/tag)\n📢 .tagall - Mention everyone\n🗑️ .delete - Delete message\n❓ .help - Show this menu`
        });
      }

    } catch (err) {
      console.log("Message handler error:", err.message);
    }
  });
}

// -------- GRACEFUL SHUTDOWN --------
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function gracefulShutdown() {
  console.log("\n🛑 Shutting down gracefully...");
  process.exit(0);
}

// -------- START THE BOT --------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`📱 Visit http://localhost:${PORT} to see QR code`);
  startBot();
});
