import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// -------- ENVIRONMENT VALIDATION --------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

// -------- CONFIG --------
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const VULGAR_WORDS = ["fuck", "nigga", "nigger", "bitch", "asshole", "shit"];
const BOT_TIMEZONE = process.env.TIMEZONE || "Africa/Lagos";

// -------- TRACKERS --------
const spamTracker = {};
const commandCooldown = {};
const welcomeBuffers = {};
const firedThisMinute = new Set();

// Clean up old trackers every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of Object.entries(spamTracker)) {
    if (now - value.time > 3600000) delete spamTracker[key];
  }
  for (const [key, time] of Object.entries(commandCooldown)) {
    if (now - time > 3600000) delete commandCooldown[key];
  }
  // Clear old fired minutes (keep last hour only)
  for (const key of firedThisMinute) {
    const timestamp = parseInt(key.split('_').pop());
    if (now - timestamp > 3600000) firedThisMinute.delete(key);
  }
}, 3600000);

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// -------- HELPERS --------
const delay = ms => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  try {
    const user = participants.find(p => p.id === jid);
    return user && (user.admin === "admin" || user.admin === "superadmin");
  } catch {
    return false;
  }
};

const normalize = str => {
  try { return str.replace(/\s+/g, "").toLowerCase(); } catch { return ""; }
};

function getCurrentTimeInZone() {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: BOT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const timeStr = formatter.format(now);
    const [hh, mm] = timeStr.split(':').map(Number);
    return { hh, mm };
  } catch {
    const now = new Date();
    return { hh: now.getHours(), mm: now.getMinutes() };
  }
}

function parseTimeTo24h(timeStr) {
  try {
    const cleaned = String(timeStr).trim().toUpperCase();
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const period = match[3];
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

function formatTime24to12(hhmm) {
  try {
    const [hh, mm] = String(hhmm).split(":").map(Number);
    const period = hh >= 12 ? "PM" : "AM";
    const h = hh % 12 || 12;
    return `${h}:${String(mm).padStart(2, "0")} ${period}`;
  } catch {
    return hhmm;
  }
}

// -------- APP --------
const app = express();
let currentQR = null;
let botStatus = "starting";
let waVersion = null;
let sock = null;
let isStarting = false;
let reconnectTimer = null;

// -------- DATABASE FUNCTIONS --------

async function getGroupSettings(groupJid) {
  try {
    const { data, error } = await supabase
      .from("group_settings")
      .select("*")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    if (error) {
      console.log("getGroupSettings error:", error.message);
      return { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
    }
    
    return data || { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  } catch (e) {
    console.log("getGroupSettings exception:", e?.message);
    return { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    const { error } = await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, ...updates })
      .eq("group_jid", groupJid);
    
    if (error) console.log("updateGroupSettings error:", error.message);
  } catch (e) {
    console.log("updateGroupSettings exception:", e?.message);
  }
}

async function ensureGroupSettings(groupJid, botJid) {
  try {
    const { error } = await supabase
      .from("group_settings")
      .upsert({
        group_jid: groupJid,
        bot_jid: botJid,
        bot_active: true,
        anti_link: true,
        anti_vulgar: true
      }, { onConflict: 'group_jid' });
    
    if (error) console.log("ensureGroupSettings error:", error.message);
  } catch (e) {
    console.log("ensureGroupSettings exception:", e?.message);
  }
}

async function ensureGroupScheduledLocks(groupJid) {
  try {
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: null,
        unlock_time: null
      }, { onConflict: 'group_jid' });
    
    if (error) console.log("ensureGroupScheduledLocks error:", error.message);
  } catch (e) {
    console.log("ensureGroupScheduledLocks exception:", e?.message);
  }
}

async function getStrikes(groupJid, userJid) {
  try {
    const { data, error } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    
    if (error) {
      console.log("getStrikes error:", error.message);
      return 0;
    }
    
    return data?.strikes || 0;
  } catch (e) {
    console.log("getStrikes exception:", e?.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  try {
    const current = await getStrikes(groupJid, userJid);
    const newCount = current + 1;
    
    const { error } = await supabase
      .from("group_strikes")
      .upsert({
        group_jid: groupJid,
        user_jid: userJid,
        strikes: newCount,
        last_strike: new Date().toISOString()
      }, { onConflict: 'group_jid,user_jid' }); // FIXED: string, not array
    
    if (error) console.log("incrementStrike error:", error.message);
    return newCount;
  } catch (e) {
    console.log("incrementStrike exception:", e?.message);
    return 1;
  }
}

async function resetUserStrikes(groupJid, userJid) {
  try {
    await supabase
      .from("group_strikes")
      .delete()
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid);
  } catch (e) {
    console.log("resetUserStrikes error:", e?.message);
  }
}

async function getScheduledLock(groupJid) {
  try {
    const { data, error } = await supabase
      .from("group_scheduled_locks")
      .select("*")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    if (error) {
      console.log("getScheduledLock error:", error.message);
      return null;
    }
    
    return data;
  } catch (e) {
    console.log("getScheduledLock exception:", e?.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  try {
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: lockTime
      }, { onConflict: 'group_jid' });
    
    if (error) console.log("setScheduledLockTime error:", error.message);
  } catch (e) {
    console.log("setScheduledLockTime exception:", e?.message);
  }
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        unlock_time: unlockTime
      }, { onConflict: 'group_jid' });
    
    if (error) console.log("setScheduledUnlockTime error:", error.message);
  } catch (e) {
    console.log("setScheduledUnlockTime exception:", e?.message);
  }
}

async function clearLockTime(groupJid) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .update({ lock_time: null })
      .eq("group_jid", groupJid);
  } catch (e) {
    console.log("clearLockTime error:", e?.message);
  }
}

async function clearUnlockTime(groupJid) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .update({ unlock_time: null })
      .eq("group_jid", groupJid);
  } catch (e) {
    console.log("clearUnlockTime error:", e?.message);
  }
}

async function provisionAllGroups() {
  try {
    if (!sock) return;
    
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    if (!botJid) return;
    
    const botNumber = botJid.split(":")[0]?.split("@")[0];
    let count = 0;
    
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p => 
        p.id.split("@")[0] === botNumber || p.id === botJid
      );
      
      if (self && (self.admin === "admin" || self.admin === "superadmin")) {
        await ensureGroupSettings(groupJid, botJid);
        await ensureGroupScheduledLocks(groupJid);
        count++;
      }
    }
    
    console.log(`✅ Provisioned ${count} groups`);
  } catch (e) {
    console.log("provisionAllGroups error:", e?.message);
  }
}

// -------- STRIKE HANDLER --------
async function handleStrike(jid, sender, reason) {
  try {
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split("@")[0]}`;

    if (strikes >= 3) {
      try {
        await sock.sendMessage(jid, {
          text: `⛔ ${tag} has received *3/3 strikes* for ${reason} and has been removed.`,
          mentions: [sender]
        });
      } catch {}
      
      try {
        await sock.groupParticipantsUpdate(jid, [sender], "remove");
      } catch (e) {
        console.log("Auto-kick error:", e?.message);
      }
      
      await resetUserStrikes(jid, sender);
    } else {
      try {
        await sock.sendMessage(jid, {
          text: `⚠️ Warning ${tag}: ${reason}.\nStrike *${strikes}/3*`,
          mentions: [sender]
        });
      } catch {}
    }
  } catch (e) {
    console.log("handleStrike error:", e?.message);
  }
}

// -------- WELCOME BATCH --------
function scheduleWelcome(groupJid, participants, groupName) {
  try {
    const validParticipants = (participants || [])
      .map(p => typeof p === "string" ? p : p.id)
      .filter(Boolean);

    if (validParticipants.length === 0) return;

    if (!welcomeBuffers[groupJid]) {
      welcomeBuffers[groupJid] = { participants: [] };
    }
    
    welcomeBuffers[groupJid].participants.push(...validParticipants);

    clearTimeout(welcomeBuffers[groupJid].timer);
    welcomeBuffers[groupJid].timer = setTimeout(async () => {
      try {
        const members = welcomeBuffers[groupJid]?.participants || [];
        delete welcomeBuffers[groupJid];
        if (!members.length || !sock) return;

        const mentionText = members.map(u => `@${u.split("@")[0]}`).join(", ");
        await sock.sendMessage(groupJid, {
          text: `👋 Welcome ${mentionText} to *${groupName}!*`,
          mentions: members
        });
      } catch (e) {
        console.log("Welcome send error:", e?.message);
      }
    }, 5000);
  } catch (e) {
    console.log("scheduleWelcome error:", e?.message);
  }
}

// -------- SESSION FUNCTIONS --------
function isValidSession(session) {
  try {
    if (!session || !session.creds) return false;
    return !!(
      session.creds.me &&
      session.creds.noiseKey &&
      session.creds.signedIdentityKey &&
      session.creds.signedPreKey &&
      session.creds.advSecretKey
    );
  } catch {
    return false;
  }
}

async function loadSession() {
  try {
    console.log("🔍 Checking Supabase for existing session...");
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select("auth_data")
      .eq("id", SESSION_ID)
      .maybeSingle();

    if (error) {
      console.log("❌ Supabase error:", error.message);
      return { session: null, dbError: true };
    }
    
    if (!data?.auth_data) {
      console.log("📱 No session found — QR will generate");
      return { session: null, notFound: true };
    }

    let sessionData = data.auth_data;
    
    // Handle string corruption
    if (typeof sessionData === 'string') {
      try {
        sessionData = JSON.parse(sessionData);
      } catch {
        console.log("❌ Session corrupted - starting fresh");
        return { session: null, notFound: true };
      }
    }
    
    if (isValidSession(sessionData)) {
      console.log("✅ Session valid");
      return { session: sessionData };
    }
    
    console.log("⚠️ Session invalid — starting fresh");
    return { session: null, notFound: true };
    
  } catch (err) {
    console.log("❌ Load session error:", err?.message);
    return { session: null, dbError: true };
  }
}

let saveTimer;
async function scheduleSave(snapshot) {
  try {
    if (!snapshot?.creds) return;
    
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        // FIXED: Direct save, no double parsing
        const { error } = await supabase
          .from(WA_TABLE)
          .upsert({
            id: SESSION_ID,
            auth_data: snapshot,
            updated_at: new Date().toISOString()
          });
        
        if (error) throw error;
        console.log("💾 Session saved");
      } catch (err) {
        console.log("❌ Save error:", err?.message);
      }
    }, 2000);
  } catch (e) {
    console.log("scheduleSave error:", e?.message);
  }
}

async function clearSession() {
  try {
    await supabase
      .from(WA_TABLE)
      .update({ auth_data: null, updated_at: new Date().toISOString() })
      .eq("id", SESSION_ID);
    console.log("🗑️ Session cleared");
  } catch (err) {
    console.log("❌ Clear session error:", err?.message);
  }
}

// -------- SCHEDULED LOCK CHECKER --------
function startScheduledLockChecker() {
  console.log("⏰ Starting scheduled lock checker");
  
  setInterval(async () => {
    try {
      if (!sock || botStatus !== "connected") return;

      const { hh: currentHH, mm: currentMM } = getCurrentTimeInZone();
      
      const { data: rows } = await supabase
        .from("group_scheduled_locks")
        .select("group_jid, lock_time, unlock_time");

      if (!rows) return;

      for (const row of rows) {
        // Check lock
        if (row.lock_time) {
          const [lHH, lMM] = row.lock_time.split(":").map(Number);
          if (lHH === currentHH && lMM === currentMM) {
            const key = `lock_${row.group_jid}_${currentHH}_${currentMM}`;
            if (!firedThisMinute.has(key)) {
              firedThisMinute.add(key);
              
              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (!meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔒 Group locked at ${formatTime24to12(row.lock_time)}.`
                  });
                }
              } catch (e) {
                console.log("Lock execute error:", e?.message);
              }
              await clearLockTime(row.group_jid);
            }
          }
        }

        // Check unlock
        if (row.unlock_time) {
          const [uHH, uMM] = row.unlock_time.split(":").map(Number);
          if (uHH === currentHH && uMM === currentMM) {
            const key = `unlock_${row.group_jid}_${currentHH}_${currentMM}`;
            if (!firedThisMinute.has(key)) {
              firedThisMinute.add(key);
              
              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "not_announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔓 Group unlocked at ${formatTime24to12(row.unlock_time)}.`
                  });
                }
              } catch (e) {
                console.log("Unlock execute error:", e?.message);
              }
              await clearUnlockTime(row.group_jid);
            }
          }
        }
      }
    } catch (e) {
      console.log("Scheduler error:", e?.message);
    }
  }, 60000);
}

// -------- BUILD AUTH STATE --------
function buildAuthState(savedSession) {
  try {
    const creds = savedSession?.creds || initAuthCreds();
    
    // Simple key store
    const keyStore = savedSession?.keys || {};
    
    const keys = {
      get: (type, ids) => {
        const data = {};
        for (const id of ids) {
          if (keyStore[type]?.[id]) {
            data[id] = keyStore[type][id];
          }
        }
        return data;
      },
      set: (data) => {
        // Keys are updated - trigger save
        scheduleSave({ creds, keys: keyStore });
      }
    };

    return { creds, keys };
  } catch (e) {
    console.log("buildAuthState error:", e?.message);
    const creds = initAuthCreds();
    const keys = { get: () => ({}), set: () => {} };
    return { creds, keys };
  }
}

// -------- WEB SERVER --------
app.get("/", async (req, res) => {
  try {
    let qrImage = "";
    if (currentQR && currentQR !== "Loading...") {
      try { qrImage = await QRCode.toDataURL(currentQR); } catch {}
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh; display: flex; justify-content: center;
            align-items: center; padding: 20px;
          }
          .card {
            background: white; border-radius: 20px; padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; width: 100%; text-align: center;
          }
          h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
          .subtitle { color: #666; margin-bottom: 30px; font-size: 16px; }
          .qr-container {
            background: #f5f5f5; border-radius: 15px; padding: 30px; margin-bottom: 20px;
            min-height: 200px; display: flex; justify-content: center; align-items: center;
          }
          .qr-image { max-width: 300px; width: 100%; height: auto; border-radius: 10px; }
          .loading { color: #666; font-size: 18px; }
          .connected-icon { font-size: 64px; }
          .steps { text-align: left; background: #f8f9fa; border-radius: 10px; padding: 20px; margin-top: 20px; }
          .steps h3 { color: #333; margin-bottom: 10px; }
          .steps ol { color: #555; padding-left: 20px; }
          .steps li { margin: 8px 0; }
          .status { margin-top: 15px; font-weight: 500; }
          .status.ok { color: #28a745; }
          .status.waiting { color: #f59e0b; }
          .force-btn {
            display: inline-block; background: #dc2626; color: white;
            text-decoration: none; padding: 10px 20px; border-radius: 5px;
            margin-top: 15px; font-size: 14px; border: none; cursor: pointer;
          }
          .force-btn:hover { background: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 WhatsApp Bot</h1>
          <p class="subtitle">${botStatus === "connected" ? "Bot is live" : "Scan QR to connect"}</p>

          <div class="qr-container" id="qrContainer">
            ${botStatus === "connected"
              ? '<div class="connected-icon">✅</div>'
              : qrImage
                ? `<img src="${qrImage}" class="qr-image" alt="QR Code">`
                : '<div class="loading">⏳ Generating QR...</div>'
            }
          </div>

          <div class="status ${botStatus === "connected" ? "ok" : "waiting"}" id="statusText">
            ${botStatus === "connected" ? "✅ Connected" : "⏳ Waiting..."}
          </div>

          <a href="/force-qr" class="force-btn">🔄 New QR</a>
        </div>

        <script>
          async function checkStatus() {
            try {
              const res = await fetch('/qr-status');
              const data = await res.json();
              
              if (data.connected) {
                document.getElementById('qrContainer').innerHTML = '<div class="connected-icon">✅</div>';
                document.getElementById('statusText').textContent = '✅ Connected';
              } else if (data.qr) {
                document.getElementById('qrContainer').innerHTML = '<img src="' + data.qr + '" class="qr-image">';
                document.getElementById('statusText').textContent = '⏳ Scan QR';
              }
            } catch (e) {}
          }
          setInterval(checkStatus, 3000);
          checkStatus();
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    console.log("/ route error:", e?.message);
    res.status(500).send("Server error");
  }
});

app.get("/force-qr", async (req, res) => {
  console.log("\n🔄 FORCING NEW QR\n");
  
  await supabase
    .from(WA_TABLE)
    .update({ auth_data: null, updated_at: new Date().toISOString() })
    .eq("id", SESSION_ID);
  
  currentQR = null;
  botStatus = "starting";
  
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
    sock = null;
  }
  
  if (reconnectTimer) clearTimeout(reconnectTimer);
  setTimeout(() => startBot(), 1000);
  
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="2;url=/"></head>
      <body style="background:#0f172a;color:white;text-align:center;padding:50px">
        <h1>🔄 Generating QR...</h1>
      </body>
    </html>
  `);
});

app.get("/qr-status", async (req, res) => {
  try {
    if (botStatus === "connected") {
      res.json({ connected: true, qr: null });
    } else if (currentQR && currentQR !== "Loading...") {
      const qrImage = await QRCode.toDataURL(currentQR);
      res.json({ connected: false, qr: qrImage });
    } else {
      res.json({ connected: false, qr: null });
    }
  } catch {
    res.json({ connected: false, qr: null });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    botStatus,
    uptime: process.uptime()
  });
});

// -------- START BOT --------
async function startBot() {
  if (isStarting) {
    console.log("⏳ Already starting...");
    return;
  }
  isStarting = true;

  try {
    console.log("\n🚀 STARTING BOT\n");

    // Get latest version
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log("📱 Using version:", waVersion.join('.'));

    // Load session
    const result = await loadSession();
    if (result.dbError) {
      console.log("⚠️ DB error, retrying in 10s...");
      setTimeout(() => startBot(), 10000);
      return;
    }

    const loadedSession = result.session;
    console.log(loadedSession ? "✅ Using existing session" : "🆕 Fresh start");

    const authState = buildAuthState(loadedSession);
    currentQR = "Loading...";

    // Clean up old socket
    if (sock) {
      sock.ev.removeAllListeners();
      sock.end();
      sock = null;
    }

    // Create new socket
    sock = makeWASocket({
      version: waVersion,
      auth: authState,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    // Error handler
    sock.ev.on("error", (err) => {
      console.log("💥 Socket error:", err?.message);
    });

    // Creds update
    sock.ev.on("creds.update", () => {
      scheduleSave({ creds: authState.creds, keys: authState.keys });
    });

    // Connection updates
    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      console.log("📡 Update:", { connection, hasQR: !!qr });

      // QR CODE - MOST IMPORTANT
      if (qr) {
        console.log("\n✅✅✅ QR READY - SCAN NOW\n");
        currentQR = qr;
        botStatus = "qr_ready";
        qrcode.generate(qr, { small: true });
        return; // CRITICAL: STOP HERE
      }

      // CONNECTED
      if (connection === "open") {
        console.log("\n✅✅✅ CONNECTED\n");
        currentQR = null;
        botStatus = "connected";
        await sock.sendPresenceUpdate("available");
        setTimeout(provisionAllGroups, 3000);
        return;
      }

      // CLOSED
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("❌ Closed:", code);
        
        if (code === 401) {
          console.log("🔐 Auth failed - clearing session");
          await clearSession();
          setTimeout(startBot, 3000);
        } else {
          setTimeout(startBot, 5000);
        }
      }
    });

    // Group participants
    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { action, participants, id: groupJid } = update;
        
        if (action === "add" && participants?.length > 0) {
          const settings = await getGroupSettings(groupJid);
          if (settings.bot_active) {
            let groupName = "the group";
            try {
              const meta = await sock.groupMetadata(groupJid);
              groupName = meta.subject || "the group";
            } catch {}
            scheduleWelcome(groupJid, participants, groupName);
          }
        }

        if (action === "remove" || action === "leave") {
          for (const user of (participants || [])) {
            await resetUserStrikes(groupJid, user);
          }
        }
      } catch (e) {
        console.log("Group update error:", e?.message);
      }
    });

    // Messages
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        
        let metadata;
        try { metadata = await sock.groupMetadata(jid); } catch { return; }

        const isUserAdmin = isAdmin(sender, metadata.participants);

        let text = "";
        try {
          text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ""
          ).trim();
        } catch {
          text = "";
        }
        if (!text) return;

        const settings = await getGroupSettings(jid);
        const command = text.toLowerCase().trim();
        const isCommand = command.startsWith(".");

        // Bot on/off
        if (isCommand && isUserAdmin) {
          if (command === ".bot on") {
            await updateGroupSettings(jid, { bot_active: true });
            await sock.sendMessage(jid, { text: "✅ Bot active" });
            return;
          }
          if (command === ".bot off") {
            await updateGroupSettings(jid, { bot_active: false });
            await sock.sendMessage(jid, { text: "⏸️ Bot inactive" });
            return;
          }
        }

        if (!settings.bot_active) return;

        // Anti-vulgar
        if (!isUserAdmin && settings.anti_vulgar) {
          const hasVulgar = VULGAR_WORDS.some(w => text.toLowerCase().includes(w));
          if (hasVulgar) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
              await sock.sendMessage(jid, {
                text: `⚠️ @${sender.split("@")[0]}, no vulgar language`,
                mentions: [sender]
              });
            } catch {}
            return;
          }
        }

        // Anti-link
        if (!isUserAdmin && settings.anti_link) {
          const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
          if (linkRegex.test(text)) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
            } catch {}
            await handleStrike(jid, sender, "sending links");
            return;
          }
        }

        // Admin commands
        if (!isCommand || !isUserAdmin) return;

        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;

        // LOCK
        if (command === ".lock") {
          const meta = await sock.groupMetadata(jid);
          if (!meta.announce) {
            await sock.groupSettingUpdate(jid, "announcement");
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: "🔒 Locked" });
          }
        }
        else if (command === ".lock clear") {
          await clearLockTime(jid);
          await sock.sendMessage(jid, { text: "🔓 Lock schedule cleared" });
        }
        else if (command.startsWith(".lock ")) {
          const timeArg = text.slice(6).trim();
          const parsed = parseTimeTo24h(timeArg);
          if (parsed) {
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, { text: `🔒 Auto-lock at ${formatTime24to12(parsed)}` });
          } else {
            await sock.sendMessage(jid, { text: "❌ Invalid time. Use .lock 9:00PM" });
          }
        }
        // UNLOCK
        else if (command === ".unlock") {
          const meta = await sock.groupMetadata(jid);
          if (meta.announce) {
            await sock.groupSettingUpdate(jid, "not_announcement");
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: "🔓 Unlocked" });
          }
        }
        else if (command === ".unlock clear") {
          await clearUnlockTime(jid);
          await sock.sendMessage(jid, { text: "🔒 Unlock schedule cleared" });
        }
        else if (command.startsWith(".unlock ")) {
          const timeArg = text.slice(8).trim();
          const parsed = parseTimeTo24h(timeArg);
          if (parsed) {
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, { text: `🔓 Auto-unlock at ${formatTime24to12(parsed)}` });
          } else {
            await sock.sendMessage(jid, { text: "❌ Invalid time. Use .unlock 6:00AM" });
          }
        }
        // KICK
        else if (command.startsWith(".kick")) {
          const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
          if (!targets.length) {
            await sock.sendMessage(jid, { text: "❌ Tag user to kick" });
            return;
          }
          for (const user of targets) {
            const exists = metadata.participants.some(p => p.id === user);
            if (!exists) {
              await sock.sendMessage(jid, { text: `❌ User not in group` });
              continue;
            }
            const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
            if (isTargetAdmin) {
              await sock.sendMessage(jid, { text: "❌ Cannot kick admin" });
              continue;
            }
            await sock.groupParticipantsUpdate(jid, [user], "remove");
            await sock.sendMessage(jid, { text: `✅ Removed` });
            await delay(500);
          }
        }
        // STRIKE RESET
        else if (command.startsWith(".strike reset")) {
          const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
          if (!targets.length) {
            await sock.sendMessage(jid, { text: "❌ Tag user to reset strikes" });
            return;
          }
          for (const user of targets) {
            await resetUserStrikes(jid, user);
            await sock.sendMessage(jid, { text: `✅ Strikes reset` });
          }
        }
        // TAGALL
        else if (command === ".tagall") {
          const allMembers = metadata.participants.map(p => p.id);
          await sock.sendMessage(jid, { 
            text: `📢 @everyone`, 
            mentions: allMembers 
          });
        }
        // DELETE
        else if (command === ".delete") {
          if (!ctx?.stanzaId) {
            await sock.sendMessage(jid, { text: "❌ Reply to message to delete" });
            return;
          }
          await sock.sendMessage(jid, {
            delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }
          });
        }
        // ANTILINK
        else if (command === ".antilink on") {
          await updateGroupSettings(jid, { anti_link: true });
          await sock.sendMessage(jid, { text: "🔗 Anti-link on" });
        }
        else if (command === ".antilink off") {
          await updateGroupSettings(jid, { anti_link: false });
          await sock.sendMessage(jid, { text: "🔗 Anti-link off" });
        }
        // ANTIVULGAR
        else if (command === ".antivulgar on") {
          await updateGroupSettings(jid, { anti_vulgar: true });
          await sock.sendMessage(jid, { text: "🔞 Anti-vulgar on" });
        }
        else if (command === ".antivulgar off") {
          await updateGroupSettings(jid, { anti_vulgar: false });
          await sock.sendMessage(jid, { text: "🔞 Anti-vulgar off" });
        }
        // HELP
        else if (command === ".help") {
          const sched = await getScheduledLock(jid);
          const lockInfo = sched?.lock_time ? `\n🔒 Lock: ${formatTime24to12(sched.lock_time)}` : "";
          const unlockInfo = sched?.unlock_time ? `\n🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` : "";

          await sock.sendMessage(jid, {
            text:
              `📋 *Commands*\n\n` +
              `.lock / .lock 9PM\n` +
              `.unlock / .unlock 6AM\n` +
              `.kick @user\n` +
              `.tagall\n` +
              `.delete\n` +
              `.strike reset @user\n` +
              `.antilink on/off\n` +
              `.antivulgar on/off\n` +
              `.bot on/off\n\n` +
              `Bot: ${settings.bot_active ? '✅' : '⏸️'}\n` +
              `Anti-link: ${settings.anti_link ? '✅' : '❌'}\n` +
              `Anti-vulgar: ${settings.anti_vulgar ? '✅' : '❌'}` +
              lockInfo + unlockInfo
          });
        }
      } catch (e) {
        console.log("Message error:", e?.message);
      }
    });

  } catch (err) {
    console.log("❌ Start error:", err?.message);
    setTimeout(startBot, 5000);
  } finally {
    isStarting = false;
  }
}

// -------- START SERVER --------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 Server on http://localhost:${PORT}`);
  startBot();
  startScheduledLockChecker();
});

// -------- GRACEFUL SHUTDOWN --------
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received`);
  
  server.close(() => console.log("✅ Server closed"));

  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
  }

  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
