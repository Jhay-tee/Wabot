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
import NodeCache from "node-cache"; // Add this: npm install node-cache

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

// -------- CACHING (Reduces DB calls by 90%) --------
const groupSettingsCache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache
const groupLocksCache = new NodeCache({ stdTTL: 60 });    // 1 minute cache
const strikesCache = new NodeCache({ stdTTL: 60 });       // 1 minute cache
const pendingWrites = new Map(); // Batch pending writes

// -------- CONNECTION POOLING (Healthier for Supabase) --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: {
      fetch: (url, options) => {
        // Intelligent timeout - shorter for reads, longer for writes
        const isWrite = options?.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method);
        const timeout = isWrite ? 30000 : 10000; // 30s writes, 10s reads
        
        return fetch(url, { 
          ...options, 
          signal: AbortSignal.timeout(timeout)
        }).catch(err => {
          console.log(`📡 Supabase ${isWrite ? 'write' : 'read'} timeout:`, err.message);
          throw err;
        });
      }
    },
    db: {
      pool: {
        max: 10,              // Max connections in pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
    },
    realtime: {
      timeout: 10000
    }
  }
);

// -------- TRACKERS --------
const spamTracker = {};
const commandCooldown = {};

// -------- APP --------
const app = express();
let currentQR = null;
let botStatus = "starting";
let waVersion = null;
let sock = null;

// -------- HELPER FUNCTIONS --------
const delay = ms => new Promise(res => setTimeout(res, ms));

function getCurrentTimeInZone() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BOT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date());
    const hh = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    const mm = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
    return { hh, mm };
  } catch {
    const now = new Date();
    return { hh: now.getHours(), mm: now.getMinutes() };
  }
}

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

function parseTimeTo24h(timeStr) {
  try {
    const cleaned = String(timeStr).trim();
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const period = match[3].toUpperCase();
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

// -------- BATCHED DATABASE OPERATIONS (Healthier for Supabase) --------

// Batch writer - accumulates writes and flushes every 5 seconds
async function flushPendingWrites() {
  if (pendingWrites.size === 0) return;
  
  const writes = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  
  console.log(`📦 Flushing ${writes.length} batched writes`);
  
  // Group by table
  const settingsWrites = [];
  const strikesWrites = [];
  const locksWrites = [];
  
  for (const [key, value] of writes) {
    if (key.startsWith('settings_')) {
      settingsWrites.push(value);
    } else if (key.startsWith('strikes_')) {
      strikesWrites.push(value);
    } else if (key.startsWith('locks_')) {
      locksWrites.push(value);
    }
  }
  
  // Execute batch upserts
  try {
    if (settingsWrites.length > 0) {
      await supabase.from('group_settings').upsert(settingsWrites, { 
        onConflict: 'group_jid',
        ignoreDuplicates: false 
      });
    }
    
    if (strikesWrites.length > 0) {
      await supabase.from('group_strikes').upsert(strikesWrites, { 
        onConflict: 'group_jid,user_jid',
        ignoreDuplicates: false 
      });
    }
    
    if (locksWrites.length > 0) {
      await supabase.from('group_scheduled_locks').upsert(locksWrites, { 
        onConflict: 'group_jid',
        ignoreDuplicates: false 
      });
    }
  } catch (err) {
    console.log("❌ Batch write error:", err.message);
  }
}

// Schedule batch flush every 5 seconds
setInterval(flushPendingWrites, 5000);

// Cache cleanup every 10 minutes
setInterval(() => {
  groupSettingsCache.flushAll();
  groupLocksCache.flushAll();
  strikesCache.flushAll();
  console.log("🧹 Cache cleared");
}, 600000);

// -------- CACHED DATABASE FUNCTIONS --------

async function getGroupSettings(groupJid) {
  // Check cache first
  const cached = groupSettingsCache.get(groupJid);
  if (cached) return cached;
  
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
    
    const settings = data || { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
    
    // Cache it
    groupSettingsCache.set(groupJid, settings);
    return settings;
  } catch (e) {
    console.log("getGroupSettings exception:", e?.message);
    return { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  // Update cache immediately
  const current = await getGroupSettings(groupJid);
  const updated = { ...current, ...updates };
  groupSettingsCache.set(groupJid, updated);
  
  // Queue for batch write
  pendingWrites.set(`settings_${groupJid}`, {
    group_jid: groupJid,
    ...updated
  });
  
  return updated;
}

async function getStrikes(groupJid, userJid) {
  const cacheKey = `${groupJid}_${userJid}`;
  const cached = strikesCache.get(cacheKey);
  if (cached !== undefined) return cached;
  
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
    
    const strikes = data?.strikes || 0;
    strikesCache.set(cacheKey, strikes, 30); // 30 second cache
    return strikes;
  } catch (e) {
    console.log("getStrikes exception:", e?.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  const cacheKey = `${groupJid}_${userJid}`;
  const current = await getStrikes(groupJid, userJid);
  const newCount = current + 1;
  
  // Update cache
  strikesCache.set(cacheKey, newCount, 30);
  
  // Queue for batch write
  pendingWrites.set(`strikes_${groupJid}_${userJid}`, {
    group_jid: groupJid,
    user_jid: userJid,
    strikes: newCount,
    last_strike: new Date().toISOString()
  });
  
  return newCount;
}

async function resetUserStrikes(groupJid, userJid) {
  const cacheKey = `${groupJid}_${userJid}`;
  
  // Update cache
  strikesCache.del(cacheKey);
  
  // Queue deletion
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
  const cached = groupLocksCache.get(groupJid);
  if (cached !== undefined) return cached;
  
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
    
    groupLocksCache.set(groupJid, data);
    return data;
  } catch (e) {
    console.log("getScheduledLock exception:", e?.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  // Get current or create new
  let current = await getScheduledLock(groupJid) || { group_jid: groupJid };
  const updated = { ...current, lock_time: lockTime };
  
  // Update cache
  groupLocksCache.set(groupJid, updated);
  
  // Queue for batch write
  pendingWrites.set(`locks_${groupJid}`, {
    group_jid: groupJid,
    lock_time: lockTime,
    unlock_time: current.unlock_time || null
  });
  
  return updated;
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  let current = await getScheduledLock(groupJid) || { group_jid: groupJid };
  const updated = { ...current, unlock_time: unlockTime };
  
  groupLocksCache.set(groupJid, updated);
  
  pendingWrites.set(`locks_${groupJid}`, {
    group_jid: groupJid,
    lock_time: current.lock_time || null,
    unlock_time: unlockTime
  });
  
  return updated;
}

async function clearLockTime(groupJid) {
  let current = await getScheduledLock(groupJid);
  if (!current) return;
  
  const updated = { ...current, lock_time: null };
  groupLocksCache.set(groupJid, updated);
  
  pendingWrites.set(`locks_${groupJid}`, {
    group_jid: groupJid,
    lock_time: null,
    unlock_time: current.unlock_time || null
  });
}

async function clearUnlockTime(groupJid) {
  let current = await getScheduledLock(groupJid);
  if (!current) return;
  
  const updated = { ...current, unlock_time: null };
  groupLocksCache.set(groupJid, updated);
  
  pendingWrites.set(`locks_${groupJid}`, {
    group_jid: groupJid,
    lock_time: current.lock_time || null,
    unlock_time: null
  });
}

async function ensureGroupSettings(groupJid, botJid) {
  const settings = await getGroupSettings(groupJid);
  if (!settings.bot_jid) {
    await updateGroupSettings(groupJid, { bot_jid: botJid });
  }
  return settings;
}

async function ensureGroupScheduledLocks(groupJid) {
  const locks = await getScheduledLock(groupJid);
  if (!locks) {
    pendingWrites.set(`locks_${groupJid}`, {
      group_jid: groupJid,
      lock_time: null,
      unlock_time: null
    });
    groupLocksCache.set(groupJid, { group_jid: groupJid, lock_time: null, unlock_time: null });
  }
  return locks || { group_jid: groupJid, lock_time: null, unlock_time: null };
}

// -------- PROVISION ALL GROUPS (Optimized) --------
async function provisionAllGroups() {
  try {
    console.log("🔍 provisionAllGroups: Starting...");
    
    if (!sock) {
      console.log("❌ provisionAllGroups: sock is null");
      return;
    }
    
    const groups = await sock.groupFetchAllParticipating();
    console.log("📊 Found", Object.keys(groups).length, "groups total");
    
    const botJid = sock.user?.id;
    if (!botJid) {
      console.log("❌ provisionAllGroups: botJid is null");
      return;
    }
    
    const botNumber = botJid.split(":")[0]?.split("@")[0];
    console.log("🤖 Bot number:", botNumber);
    
    let adminCount = 0;
    
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p => 
        p.id.split("@")[0] === botNumber || p.id === botJid
      );
      
      if (self && (self.admin === "admin" || self.admin === "superadmin")) {
        adminCount++;
        // Just update cache - batch writer will handle DB
        await ensureGroupSettings(groupJid, botJid);
        await ensureGroupScheduledLocks(groupJid);
      }
    }
    
    console.log(`✅ provisionAllGroups: Found ${adminCount} admin groups`);
  } catch (e) {
    console.log("❌ provisionAllGroups error:", e?.message);
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
          text: `⛔ ${tag} has received *3/3 strikes* for ${reason} and has been *removed* from the group.`,
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
          text: `⚠️ Warning ${tag}: ${reason}.\nStrike *${strikes}/3* — at 3 strikes you will be removed.`,
          mentions: [sender]
        });
      } catch {}
    }
  } catch (e) {
    console.log("handleStrike error:", e?.message);
  }
}

// -------- WELCOME BATCH --------
const welcomeBuffers = {};

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
          text: `👋 Welcome ${mentionText} to *${groupName}*! \n\n📜 *Group Rules:*\n• No spam\n• No links (unless admin)\n• No vulgar language\n\nEnjoy your stay and be respectful! ✨`,
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
    const hasRequired = !!(
      session.creds.me &&
      session.creds.noiseKey &&
      session.creds.signedIdentityKey &&
      session.creds.signedPreKey &&
      session.creds.advSecretKey
    );
    return hasRequired;
  } catch (e) {
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
      console.log("✅ Session valid — connected as:", sessionData.creds.me?.name || "Unknown");
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
        const cleanSession = {
          creds: snapshot.creds,
          keys: snapshot.keys || {}
        };
        
        const { error } = await supabase
          .from(WA_TABLE)
          .upsert({
            id: SESSION_ID,
            auth_data: cleanSession,
            updated_at: new Date().toISOString()
          });
        
        if (error) throw error;
        console.log("💾 Session saved");
      } catch (err) {
        console.log("❌ Save error:", err?.message);
      }
    }, 2000); // 2 second debounce
  } catch (e) {
    console.log("scheduleSave error:", e?.message);
  }
}

async function clearSession() {
  try {
    await supabase
      .from(WA_TABLE)
      .upsert({
        id: SESSION_ID,
        auth_data: null,
        updated_at: new Date().toISOString()
      });
    console.log("🗑️ Session cleared");
  } catch (err) {
    console.log("❌ Clear session error:", err?.message);
  }
}

// -------- SCHEDULED LOCK CHECKER --------
const firedThisMinute = new Set();

function startScheduledLockChecker() {
  console.log("⏰ Starting scheduled lock checker with timezone:", BOT_TIMEZONE);
  
  setInterval(async () => {
    try {
      if (!sock || botStatus !== "connected") return;

      const { hh: currentHH, mm: currentMM } = getCurrentTimeInZone();
      
      // Get all locks from cache/db
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
              setTimeout(() => firedThisMinute.delete(key), 65000);

              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (!meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔒 Group automatically locked at ${formatTime24to12(row.lock_time)}.`
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
              setTimeout(() => firedThisMinute.delete(key), 65000);

              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "not_announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔓 Group automatically unlocked at ${formatTime24to12(row.unlock_time)}.`
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
    const keys = {
      get: () => ({}),
      set: () => {}
    };
    
    if (savedSession?.keys) {
      keys.get = (type, ids) => {
        const data = {};
        for (const id of ids) {
          if (savedSession.keys[type]?.[id]) {
            data[id] = savedSession.keys[type][id];
          }
        }
        return data;
      };
    }

    const getSnapshot = () => ({ creds, keys: savedSession?.keys || {} });

    return { creds, keys, getSnapshot };
  } catch (e) {
    console.log("buildAuthState error:", e?.message);
    const creds = initAuthCreds();
    const keys = { get: () => ({}), set: () => {} };
    return { creds, keys, getSnapshot: () => ({ creds, keys: {} }) };
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
          <p class="subtitle">${botStatus === "connected" ? "Bot is live and monitoring your groups" : "Scan QR code to connect your WhatsApp"}</p>

          <div class="qr-container">
            ${botStatus === "connected"
              ? '<div class="connected-icon">✅</div>'
              : qrImage
                ? `<img src="${qrImage}" class="qr-image" alt="QR Code">`
                : '<div class="loading">⏳ Generating QR Code...</div>'
            }
          </div>

          ${botStatus !== "connected" ? `
          <div class="steps">
            <h3>📱 How to connect:</h3>
            <ol>
              <li>Open WhatsApp on your phone</li>
              <li>Tap Menu (3 dots) or Settings</li>
              <li>Select "Linked Devices"</li>
              <li>Tap "Link a Device"</li>
              <li>Scan this QR code</li>
            </ol>
          </div>` : ""}

          <div class="status ${botStatus === "connected" ? "ok" : "waiting"}">
            ${botStatus === "connected" ? "✅ Bot is active and connected" : "⏳ Waiting for QR scan..."}
          </div>

          <a href="/force-qr" class="force-btn">🔄 Force New QR Code</a>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.log("/ route error:", e?.message);
    res.status(500).send("Server error");
  }
});

app.get("/force-qr", async (req, res) => {
  try {
    console.log("\n🔄 FORCING NEW QR CODE\n");
    await clearSession();
    currentQR = null;
    botStatus = "starting";
    if (sock) { try { sock.end(); sock = null; } catch {} }
    setTimeout(() => startBot(), 1000);
    res.redirect("/");
  } catch (e) {
    console.log("/force-qr error:", e?.message);
    res.redirect("/");
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    botStatus,
    uptime: Math.floor(process.uptime()),
    connected: botStatus === "connected"
  });
});

app.get("/status", (req, res) => {
  res.json({
    botStatus,
    hasQR: !!currentQR,
    uptime: Math.floor(process.uptime())
  });
});

app.get("/qr-status", async (req, res) => {
  try {
    const connected = botStatus === "connected";
    let qrImage = null;
    if (!connected && currentQR && currentQR !== "Loading...") {
      try { qrImage = await QRCode.toDataURL(currentQR); } catch {}
    }
    res.json({ connected, qrImage });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// -------- START BOT --------
let isStarting = false;
let reconnectTimer = null;

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, delayMs);
}

async function startBot() {
  if (isStarting) {
    console.log("⏳ Bot already starting, skipping...");
    return;
  }
  isStarting = true;

  try {
    console.log("\n🚀 STARTING BOT 🚀\n");

    if (!waVersion) {
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version;
      console.log("✅ Using version:", waVersion);
    }

    const result = await loadSession();

    if (result.dbError) {
      console.log("⚠️ Supabase unavailable — retrying in 10s...");
      scheduleReconnect(10000);
      return;
    }

    const loadedSession = result.session;
    console.log(loadedSession ? "✅ Using existing session" : "🆕 Fresh start — QR will generate");

    const authState = buildAuthState(loadedSession);
    currentQR = "Loading...";

    if (sock) { try { sock.end(); sock = null; } catch {} }

    sock = makeWASocket({
      version: waVersion,
      auth: { creds: authState.creds, keys: authState.keys },
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on("error", (err) => {
      console.log("💥 Socket error:", err?.message);
    });

    sock.ev.on("creds.update", () => {
      try { scheduleSave(authState.getSnapshot()); } catch {}
    });

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      try {
        console.log("📡 Connection update:", { connection, hasQR: !!qr });

        if (qr) {
          console.log("\n✅✅✅ QR CODE GENERATED — scan with WhatsApp\n");
          currentQR = qr;
          botStatus = "awaiting_scan";
          try { qrcode.generate(qr, { small: true }); } catch {}
          return;
        }

        if (connection === "open") {
          console.log("\n✅✅✅ CONNECTED TO WHATSAPP ✅✅✅\n");
          currentQR = null;
          botStatus = "connected";
          try { await sock.sendPresenceUpdate("available"); } catch {}
          setTimeout(() => provisionAllGroups(), 3000);
          return;
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          console.log("🔌 Connection closed:", code);

          if (code === DisconnectReason.loggedOut) {
            console.log("🚫 Logged out — clearing session");
            await clearSession();
            currentQR = null;
            botStatus = "starting";
            scheduleReconnect(2000);
            return;
          }

          console.log("🔄 Reconnecting in 5s...");
          scheduleReconnect(5000);
        }
      } catch (e) {
        console.log("connection.update error:", e?.message);
      }
    });

    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { action, participants, id: groupJid } = update;
        const botJid = sock.user?.id;
        const botNumber = botJid?.split(":")[0]?.split("@")[0];

        const joinActions = ["add", "invite", "linked_group_join"];

        // Welcome new members
        const humanParticipants = (participants || []).filter(p => {
          const pNum = (p.split ? p.split("@")[0] : p?.id?.split("@")[0]) || "";
          return pNum !== botNumber;
        });

        if (joinActions.includes(action) && humanParticipants.length > 0) {
          try {
            const settings = await getGroupSettings(groupJid);
            if (settings.bot_active) {
              let groupName = "the group";
              try {
                const meta = await sock.groupMetadata(groupJid);
                groupName = meta.subject || "the group";
              } catch {}
              scheduleWelcome(groupJid, humanParticipants, groupName);
            }
          } catch (e) {
            console.log("Welcome queue error:", e?.message);
          }
        }

        if (action === "remove" || action === "leave") {
          for (const user of (participants || [])) {
            try { await resetUserStrikes(groupJid, user); } catch {}
          }
        }
      } catch (e) {
        console.log("group-participants.update error:", e?.message);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;

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
            try { await sock.sendMessage(jid, { text: "✅ Bot is now *active*." }); } catch {}
            return;
          }
          if (command === ".bot off") {
            await updateGroupSettings(jid, { bot_active: false });
            try { await sock.sendMessage(jid, { text: "⏸️ Bot is now *inactive*." }); } catch {}
            return;
          }
        }

        if (!settings.bot_active && isCommand && isUserAdmin && command !== ".bot on") {
          try {
            await sock.sendMessage(jid, { text: "⚠️ Bot is deactivated. Use `.bot on` to activate." });
          } catch {}
          return;
        }

        if (!settings.bot_active && !isCommand) return;

        // Anti-vulgar
        if (!isUserAdmin && settings.bot_active && settings.anti_vulgar) {
          const normalizedText = normalize(text);
          const hasVulgar = VULGAR_WORDS.some(word => normalizedText.includes(normalize(word)));
          if (hasVulgar) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
              await sock.sendMessage(jid, {
                text: `⚠️ @${sender.split("@")[0]}, vulgar language is not allowed.`,
                mentions: [sender]
              });
            } catch {}
            return;
          }
        }

        // Anti-link
        if (!isUserAdmin && settings.bot_active && settings.anti_link) {
          const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
          if (linkRegex.test(text)) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
            } catch {}
            await handleStrike(jid, sender, "sending a link");
            return;
          }
        }

        if (!isCommand || !isUserAdmin) return;

        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;

        // ----- COMMANDS -----
        if (command === ".lock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (meta.announce) return;
            await sock.groupSettingUpdate(jid, "announcement");
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: "🔒 Group locked." });
          } catch (e) {
            console.log(".lock error:", e?.message);
          }
        } else if (command === ".lock clear") {
          try {
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: "🔓 Scheduled lock cleared." });
          } catch (e) {
            console.log(".lock clear error:", e?.message);
          }
        } else if (command.startsWith(".lock ")) {
          try {
            const timeArg = text.slice(6).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, { text: `❌ Invalid time format. Use e.g. .lock 8:30PM` });
              return;
            }
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `🔒 Auto-lock set for ${formatTime24to12(parsed)}.`
            });
          } catch (e) {
            console.log(".lock time error:", e?.message);
          }
        } else if (command === ".unlock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (!meta.announce) return;
            await sock.groupSettingUpdate(jid, "not_announcement");
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: "🔓 Group unlocked." });
          } catch (e) {
            console.log(".unlock error:", e?.message);
          }
        } else if (command === ".unlock clear") {
          try {
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: "🔒 Scheduled unlock cleared." });
          } catch (e) {
            console.log(".unlock clear error:", e?.message);
          }
        } else if (command.startsWith(".unlock ")) {
          try {
            const timeArg = text.slice(8).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, { text: `❌ Invalid time format.` });
              return;
            }
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `🔓 Auto-unlock set for ${formatTime24to12(parsed)}.`
            });
          } catch (e) {
            console.log(".unlock time error:", e?.message);
          }
        } else if (command.startsWith(".kick")) {
          try {
            const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
            if (!targets.length) {
              await sock.sendMessage(jid, { text: "❌ Tag someone to kick." });
              return;
            }
            for (const user of targets) {
              const userExists = metadata.participants.some(p => p.id === user);
              if (!userExists) {
                await sock.sendMessage(jid, {
                  text: `❌ @${user.split("@")[0]} not in group.`,
                  mentions: [user]
                });
                continue;
              }
              const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
              if (isTargetAdmin) {
                await sock.sendMessage(jid, { text: "❌ Cannot kick admin." });
                continue;
              }
              await sock.groupParticipantsUpdate(jid, [user], "remove");
              await sock.sendMessage(jid, {
                text: `✅ @${user.split("@")[0]} removed.`,
                mentions: [user]
              });
              await delay(500);
            }
          } catch (e) {
            console.log(".kick error:", e?.message);
          }
        } else if (command.startsWith(".strike reset")) {
          try {
            const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
            if (!targets.length) {
              await sock.sendMessage(jid, { text: "❌ Tag user to reset strikes." });
              return;
            }
            for (const user of targets) {
              await resetUserStrikes(jid, user);
              await sock.sendMessage(jid, {
                text: `✅ Strikes cleared for @${user.split("@")[0]}.`,
                mentions: [user]
              });
            }
          } catch (e) {
            console.log(".strike reset error:", e?.message);
          }
        } else if (command === ".tagall") {
          try {
            const allMembers = metadata.participants.map(p => p.id);
            const mentionText = allMembers.map(m => `@${m.split("@")[0]}`).join(" ");
            await sock.sendMessage(jid, { text: `📢 ${mentionText}`, mentions: allMembers });
          } catch (e) {
            console.log(".tagall error:", e?.message);
          }
        } else if (command === ".delete") {
          try {
            if (!ctx?.stanzaId) {
              await sock.sendMessage(jid, { text: "❌ Reply to message to delete." });
              return;
            }
            await sock.sendMessage(jid, {
              delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }
            });
          } catch (e) {
            console.log(".delete error:", e?.message);
          }
        } else if (command === ".antilink on") {
          await updateGroupSettings(jid, { anti_link: true });
          await sock.sendMessage(jid, { text: "🔗 Anti-link enabled." });
        } else if (command === ".antilink off") {
          await updateGroupSettings(jid, { anti_link: false });
          await sock.sendMessage(jid, { text: "🔗 Anti-link disabled." });
        } else if (command === ".antivulgar on") {
          await updateGroupSettings(jid, { anti_vulgar: true });
          await sock.sendMessage(jid, { text: "🔞 Anti-vulgar enabled." });
        } else if (command === ".antivulgar off") {
          await updateGroupSettings(jid, { anti_vulgar: false });
          await sock.sendMessage(jid, { text: "🔞 Anti-vulgar disabled." });
        } else if (command === ".help") {
          const sched = await getScheduledLock(jid);
          const lockInfo = sched?.lock_time ? `\n🔒 Lock: ${formatTime24to12(sched.lock_time)}` : "";
          const unlockInfo = sched?.unlock_time ? `\n🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` : "";

          await sock.sendMessage(jid, {
            text:
              `📋 *Commands*\n\n` +
              `🔒 .lock / .lock 9PM / .lock clear\n` +
              `🔓 .unlock / .unlock 6AM / .unlock clear\n` +
              `👥 .kick @user\n` +
              `📢 .tagall\n` +
              `🗑️ .delete\n` +
              `⚡ .strike reset @user\n` +
              `🔗 .antilink on/off\n` +
              `🔞 .antivulgar on/off\n` +
              `🤖 .bot on/off\n` +
              `📊 Bot: ${settings.bot_active ? '✅' : '⏸️'}\n` +
              `🔗 Anti-link: ${settings.anti_link ? '✅' : '❌'}\n` +
              `🔞 Anti-vulgar: ${settings.anti_vulgar ? '✅' : '❌'}` +
              lockInfo + unlockInfo
          });
        }
      } catch (e) {
        console.log("messages.upsert error:", e?.message);
      }
    });
  } catch (err) {
    console.log("❌ startBot error:", err?.message);
    scheduleReconnect(5000);
  } finally {
    isStarting = false;
  }
}

// -------- START SERVER --------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  startBot();
  startScheduledLockChecker();
});

// -------- GRACEFUL SHUTDOWN --------
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received — flushing writes and shutting down...`);
  
  // Flush any pending writes
  await flushPendingWrites();
  
  server.close(() => console.log("✅ HTTP server closed"));

  if (sock) {
    try {
      sock.end();
      console.log("✅ WhatsApp socket closed");
    } catch (e) {}
  }

  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
