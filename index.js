/**
 * ======================================================
 * WhatsApp Bot - Production Grade (FULLY FIXED)
 * Version: 1.0.1
 * Baileys: 6.7.2
 * Database: Supabase (PostgreSQL)
 * Timezone: Africa/Lagos (Nigeria)
 * ======================================================
 */

import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} from '@whiskeysockets/baileys';

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// ======================================================
// ENVIRONMENT VALIDATION
// ======================================================
const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingVars = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

// ======================================================
// CONFIGURATION
// ======================================================
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const BOT_TIMEZONE = "Africa/Lagos";

// Vulgar words list
const VULGAR_WORDS = [
  "fuck", "fucking", "fucker", "fucked",
  "nigga", "nigger", "bitch", "bitching",
  "asshole", "shit", "shitting", "pussy",
  "dick", "cunt", "whore", "slut"
];

// ======================================================
// SUPABASE CLIENT SETUP
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: {
      fetch: (url, options) => {
        return fetch(url, { 
          ...options, 
          signal: AbortSignal.timeout(10000)
        }).catch(err => {
          console.error('📡 Supabase fetch error:', err.message);
          throw err;
        });
      }
    }
  }
);

// ======================================================
// IN-MEMORY STORAGE
// ======================================================
const welcomeBuffers = new Map();
const firedThisMinute = new Set();

// Clean up old entries every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const key of firedThisMinute) {
    const timestamp = parseInt(key.split('_').pop() || '0');
    if (timestamp < oneHourAgo) firedThisMinute.delete(key);
  }
}, 3600000);

// ======================================================
// HELPER FUNCTIONS
// ======================================================

const delay = ms => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  try {
    if (!jid || !participants || !Array.isArray(participants)) return false;
    const user = participants.find(p => p && p.id === jid);
    return user && (user.admin === "admin" || user.admin === "superadmin");
  } catch (err) {
    console.error('isAdmin error:', err.message);
    return false;
  }
};

function getCurrentTimeInZone() {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: BOT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    });
    
    const timeStr = formatter.format(new Date());
    const [hh, mm] = timeStr.split(':').map(Number);
    
    if (isNaN(hh) || isNaN(mm)) throw new Error('Invalid time format');
    
    return { hh, mm };
  } catch (err) {
    console.error('Timezone error:', err.message, '- using UTC fallback');
    const now = new Date();
    return { hh: now.getHours(), mm: now.getMinutes() };
  }
}

function parseTimeTo24h(timeStr) {
  try {
    const cleaned = String(timeStr).trim().toUpperCase().replace(/\s+/g, '');
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
    if (!match) return null;
    
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const period = match[3];
    
    if (hours < 1 || hours > 12) return null;
    if (minutes < 0 || minutes > 59) return null;
    
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch (err) {
    console.error('parseTimeTo24h error:', err.message);
    return null;
  }
}

function formatTime24to12(hhmm) {
  try {
    if (!hhmm || typeof hhmm !== 'string') return hhmm;
    
    const [hh, mm] = hhmm.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return hhmm;
    
    const period = hh >= 12 ? "PM" : "AM";
    const h = hh % 12 || 12;
    
    return `${h}:${String(mm).padStart(2, "0")} ${period}`;
  } catch (err) {
    console.error('formatTime24to12 error:', err.message);
    return hhmm;
  }
}

// ======================================================
// DATABASE FUNCTIONS - GROUP SETTINGS
// ======================================================

async function getGroupSettings(groupJid) {
  try {
    if (!groupJid) return { bot_active: true, anti_link: true, anti_vulgar: true };
    
    const { data, error } = await supabase
      .from("group_settings")
      .select("bot_active, anti_link, anti_vulgar")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    if (error || !data) {
      await supabase
        .from("group_settings")
        .upsert({
          group_jid: groupJid,
          bot_active: true,
          anti_link: true,
          anti_vulgar: true
        }, { onConflict: 'group_jid' });
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    
    return {
      bot_active: data.bot_active ?? true,
      anti_link: data.anti_link ?? true,
      anti_vulgar: data.anti_vulgar ?? true
    };
  } catch (err) {
    console.error(`getGroupSettings exception:`, err.message);
    return { bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    if (!groupJid) return false;
    
    const { error } = await supabase
      .from("group_settings")
      .upsert({
        group_jid: groupJid,
        ...updates
      }, { onConflict: 'group_jid' });
    
    if (error) {
      console.error(`updateGroupSettings error:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`updateGroupSettings exception:`, err.message);
    return false;
  }
}

async function ensureGroupSettings(groupJid) {
  try {
    if (!groupJid) return false;
    
    const { error } = await supabase
      .from("group_settings")
      .upsert({
        group_jid: groupJid,
        bot_active: true,
        anti_link: true,
        anti_vulgar: true
      }, { onConflict: 'group_jid' });
    
    return !error;
  } catch (err) {
    console.error(`ensureGroupSettings exception:`, err.message);
    return false;
  }
}

// ======================================================
// DATABASE FUNCTIONS - STRIKES
// ======================================================

async function getStrikes(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) return 0;
    
    const { data, error } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    
    return data?.strikes || 0;
  } catch (err) {
    console.error(`getStrikes exception:`, err.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) return 0;
    
    const current = await getStrikes(groupJid, userJid);
    const newCount = current + 1;
    
    const { error } = await supabase
      .from("group_strikes")
      .upsert({
        group_jid: groupJid,
        user_jid: userJid,
        strikes: newCount,
        last_strike: new Date().toISOString()
      }, { onConflict: 'group_jid,user_jid' });
    
    if (error && error.message.includes('last_strike')) {
      await supabase
        .from("group_strikes")
        .upsert({
          group_jid: groupJid,
          user_jid: userJid,
          strikes: newCount
        }, { onConflict: 'group_jid,user_jid' });
    }
    
    return newCount;
  } catch (err) {
    console.error(`incrementStrike exception:`, err.message);
    return 0;
  }
}

async function resetUserStrikes(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) return false;
    
    const { error } = await supabase
      .from("group_strikes")
      .delete()
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid);
    
    return !error;
  } catch (err) {
    console.error(`resetUserStrikes exception:`, err.message);
    return false;
  }
}

// ======================================================
// DATABASE FUNCTIONS - SCHEDULED LOCKS
// ======================================================

async function getScheduledLock(groupJid) {
  try {
    if (!groupJid) return null;
    
    const { data, error } = await supabase
      .from("group_scheduled_locks")
      .select("lock_time, unlock_time")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    return data || { lock_time: null, unlock_time: null };
  } catch (err) {
    console.error(`getScheduledLock exception:`, err.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  try {
    if (!groupJid) return false;
    
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: lockTime,
        unlock_time: current?.unlock_time || null
      }, { onConflict: 'group_jid' });
    
    return !error;
  } catch (err) {
    console.error(`setScheduledLockTime exception:`, err.message);
    return false;
  }
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    if (!groupJid) return false;
    
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: current?.lock_time || null,
        unlock_time: unlockTime
      }, { onConflict: 'group_jid' });
    
    return !error;
  } catch (err) {
    console.error(`setScheduledUnlockTime exception:`, err.message);
    return false;
  }
}

async function clearLockTime(groupJid) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: null,
        unlock_time: current?.unlock_time || null
      }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`clearLockTime exception:`, err.message);
    return false;
  }
}

async function clearUnlockTime(groupJid) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: current?.lock_time || null,
        unlock_time: null
      }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`clearUnlockTime exception:`, err.message);
    return false;
  }
}

async function ensureGroupScheduledLocks(groupJid) {
  try {
    if (!groupJid) return false;
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({
        group_jid: groupJid,
        lock_time: null,
        unlock_time: null
      }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`ensureGroupScheduledLocks exception:`, err.message);
    return false;
  }
}

// ======================================================
// PROVISION ALL GROUPS
// ======================================================

async function provisionAllGroups(sock) {
  try {
    if (!sock) return;
    
    console.log('🔍 Checking all groups for provisioning...');
    
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    if (!botJid) return;
    
    const botNumber = botJid.split(':')[0]?.split('@')[0];
    if (!botNumber) return;
    
    let provisionedCount = 0;
    
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p => 
        p.id.split('@')[0] === botNumber || p.id === botJid
      );
      
      if (self && (self.admin === 'admin' || self.admin === 'superadmin')) {
        await ensureGroupSettings(groupJid);
        await ensureGroupScheduledLocks(groupJid);
        provisionedCount++;
      }
    }
    
    console.log(`✅ Provisioning complete: ${provisionedCount} admin groups processed`);
  } catch (err) {
    console.error('provisionAllGroups error:', err.message);
  }
}

// ======================================================
// STRIKE HANDLER
// ======================================================

async function handleStrike(sock, jid, sender, reason) {
  try {
    if (!sock || !jid || !sender) return;
    
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split('@')[0]}`;
    
    if (strikes >= 3) {
      await sock.sendMessage(jid, {
        text: `⛔ 3/3 ${tag} will now be removed from the group for violating group rules (${reason})`,
        mentions: [sender]
      });
      await sock.groupParticipantsUpdate(jid, [sender], 'remove');
      await resetUserStrikes(jid, sender);
    } else {
      await sock.sendMessage(jid, {
        text: `⚠️ ${reason} are not allowed in this group. Strike ${strikes}/3`,
        mentions: [sender]
      });
    }
  } catch (err) {
    console.error('handleStrike error:', err.message);
  }
}

// ======================================================
// WELCOME MESSAGE HANDLER
// ======================================================

function scheduleWelcome(sock, groupJid, participants, groupName) {
  try {
    if (!sock || !groupJid || !participants || participants.length === 0) return;
    
    const validParticipants = participants
      .map(p => typeof p === 'string' ? p : p?.id)
      .filter(Boolean);
    
    if (validParticipants.length === 0) return;
    
    if (!welcomeBuffers.has(groupJid)) {
      welcomeBuffers.set(groupJid, { participants: [] });
    }
    
    const buffer = welcomeBuffers.get(groupJid);
    buffer.participants.push(...validParticipants);
    
    if (buffer.timer) clearTimeout(buffer.timer);
    
    buffer.timer = setTimeout(async () => {
      try {
        const members = welcomeBuffers.get(groupJid)?.participants || [];
        welcomeBuffers.delete(groupJid);
        
        if (members.length === 0) return;
        
        const mentionText = members.map(u => `@${u.split('@')[0]}`).join(', ');
        
        await sock.sendMessage(groupJid, {
          text: `👋 Welcome ${mentionText} to *${groupName}!*`,
          mentions: members
        });
      } catch (err) {
        console.error('Welcome send error:', err.message);
      }
    }, 5000);
  } catch (err) {
    console.error('scheduleWelcome error:', err.message);
  }
}

// ======================================================
// AUTH STATE MANAGEMENT (FIXED)
// ======================================================

async function loadSession() {
  try {
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select('auth_data')
      .eq('id', SESSION_ID)
      .maybeSingle();
    
    if (error || !data?.auth_data) return null;
    
    return JSON.parse(data.auth_data, BufferJSON.reviver);
  } catch (err) {
    console.error('❌ loadSession error:', err.message);
    return null;
  }
}

async function saveSession(snapshot) {
  try {
    if (!snapshot || !snapshot.creds) return false;
    
    const serialized = JSON.stringify(snapshot, BufferJSON.replacer);
    
    await supabase
      .from(WA_TABLE)
      .upsert({
        id: SESSION_ID,
        auth_data: serialized,
        updated_at: new Date().toISOString()
      });
    
    console.log('✅ Session saved');
    return true;
  } catch (err) {
    console.error('❌ saveSession exception:', err.message);
    return false;
  }
}

async function clearSession() {
  try {
    await supabase
      .from(WA_TABLE)
      .update({ 
        auth_data: null, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', SESSION_ID);
    console.log('✅ Session cleared');
    return true;
  } catch (err) {
    console.error('❌ clearSession exception:', err.message);
    return false;
  }
}

function buildAuthState(savedSession) {
  const creds = savedSession?.creds || initAuthCreds();
  let keyStore = savedSession?.keys 
    ? (typeof savedSession.keys === 'string' 
       ? JSON.parse(savedSession.keys, BufferJSON.reviver) 
       : savedSession.keys)
    : {};

  const saveState = async () => {
    await saveSession({ creds, keys: keyStore });
  };

  const keys = {
    get: (type, ids) => {
      const data = {};
      for (const id of ids || []) {
        if (keyStore[type]?.[id] !== undefined) data[id] = keyStore[type][id];
      }
      return data;
    },
    set: (data) => {
      if (!data) return;
      for (const category of Object.keys(data)) {
        keyStore[category] = keyStore[category] || {};
        for (const id of Object.keys(data[category])) {
          if (data[category][id] == null) delete keyStore[category][id];
          else keyStore[category][id] = data[category][id];
        }
      }
      saveState().catch(e => console.error('Background save failed:', e.message));
    }
  };

  return { creds, keys, saveState };
}

// ======================================================
// SCHEDULED LOCK CHECKER (FIXED)
// ======================================================

function startScheduledLockChecker(sock) {
  console.log(`⏰ Starting scheduled lock checker`);
  
  return setInterval(async () => {
    try {
      if (!sock) return;
      
      const { hh, mm } = getCurrentTimeInZone();
      const timeKey = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
      
      const { data, error } = await supabase
        .from('group_scheduled_locks')
        .select('group_jid, lock_time, unlock_time');
      
      if (error || !data) return;
      
      for (const row of data) {
        // LOCK
        if (row.lock_time === timeKey) {
          const lockKey = `lock_${row.group_jid}_${timeKey}`;
          if (!firedThisMinute.has(lockKey)) {
            firedThisMinute.add(lockKey);
            
            try {
              const meta = await sock.groupMetadata(row.group_jid);
              if (!meta.announce) {
                await sock.groupSettingUpdate(row.group_jid, 'announcement');
                await sock.sendMessage(row.group_jid, {
                  text: `🔒 Group automatically locked at ${formatTime24to12(row.lock_time)}`
                });
                await clearLockTime(row.group_jid);
              }
            } catch (err) {}
            
            setTimeout(() => firedThisMinute.delete(lockKey), 61000);
          }
        }
        
        // UNLOCK
        if (row.unlock_time === timeKey) {
          const unlockKey = `unlock_${row.group_jid}_${timeKey}`;
          if (!firedThisMinute.has(unlockKey)) {
            firedThisMinute.add(unlockKey);
            
            try {
              const meta = await sock.groupMetadata(row.group_jid);
              if (meta.announce) {
                await sock.groupSettingUpdate(row.group_jid, 'not_announcement');
                await sock.sendMessage(row.group_jid, {
                  text: `🔓 Group automatically unlocked at ${formatTime24to12(row.unlock_time)}`
                });
                await clearUnlockTime(row.group_jid);
              }
            } catch (err) {}
            
            setTimeout(() => firedThisMinute.delete(unlockKey), 61000);
          }
        }
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  }, 60000);
}

// ======================================================
// EXPRESS WEB SERVER SETUP
// ======================================================

const app = express();
let currentQR = null;
let botStatus = 'starting';
let sock = null;
let schedulerInterval = null;
let connectionFailures = 0;
const MAX_FAILURES = 3;

// ======================================================
// WEB ROUTES
// ======================================================

app.get('/', async (req, res) => {
  try {
    let qrImage = null;
    if (botStatus === 'connected') {
      qrImage = null;
    } else if (currentQR && currentQR !== 'Loading...') {
      qrImage = await QRCode.toDataURL(currentQR).catch(() => null);
    }
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
          .card { background: white; border-radius: 20px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; width: 100%; text-align: center; }
          h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
          .subtitle { color: #666; margin-bottom: 30px; font-size: 16px; }
          .qr-container { background: #f5f5f5; border-radius: 15px; padding: 30px; margin-bottom: 20px; min-height: 250px; display: flex; justify-content: center; align-items: center; }
          .qr-image { max-width: 300px; width: 100%; height: auto; border-radius: 10px; }
          .connected-icon { font-size: 64px; }
          .status { margin-top: 15px; font-weight: 500; padding: 10px; border-radius: 5px; }
          .status.connected { color: #28a745; background: #e8f5e9; }
          .status.waiting { color: #f59e0b; background: #fff3e0; }
          .force-btn { display: inline-block; background: #dc2626; color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; margin-top: 15px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
          .force-btn:hover { background: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 WhatsApp Bot</h1>
          <p class="subtitle">${botStatus === 'connected' ? 'Bot is online' : 'Scan QR to connect'}</p>
          <div class="qr-container">
            ${botStatus === 'connected' ? '<div class="connected-icon">✅</div>' : qrImage ? `<img src="${qrImage}" class="qr-image">` : '<div class="connected-icon">⏳</div>'}
          </div>
          <div class="status ${botStatus === 'connected' ? 'connected' : 'waiting'}">
            ${botStatus === 'connected' ? '✅ Connected' : '⏳ Scan QR Code'}
          </div>
          <a href="/force-qr" class="force-btn">🔄 Force New QR</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.get('/force-qr', async (req, res) => {
  console.log('\n🔄 FORCING NEW QR');
  await clearSession();
  currentQR = null;
  botStatus = 'starting';
  connectionFailures = 0;
  if (sock) { sock.ev.removeAllListeners(); sock.end(); sock = null; }
  setTimeout(() => startBot(), 1000);
  res.send(`<h1 style="text-align:center;padding:50px;background:#0f172a;color:white">Generating New QR...</h1>`);
});

app.get('/api/status', async (req, res) => {
  let qrImage = null;
  if (botStatus === 'qr_ready' && currentQR) {
    qrImage = await QRCode.toDataURL(currentQR).catch(() => null);
  }
  res.json({ connected: botStatus === 'connected', qr: qrImage, status: botStatus });
});

app.get('/health', (req, res) => res.json({ status: 'ok', botStatus, uptime: Math.floor(process.uptime()) }));

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ======================================================
// BOT STARTUP (FIXED + FULL COMMAND HANDLER)
// ======================================================

async function startBot() {
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
  }

  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Using Baileys v${version.join('.')}`);

  const savedSession = await loadSession();
  const { creds, keys, saveState } = buildAuthState(savedSession);

  sock = makeWASocket({
    version,
    auth: { creds, keys },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    qrTimeout: 60000
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = qr;
      botStatus = 'qr_ready';
      console.log('\n✅ QR READY - Scan it now');
      qrcode.generate(qr, { small: true });
      return;
    }

    if (connection === 'open') {
      console.log('\n✅✅✅ BOT CONNECTED SUCCESSFULLY');
      currentQR = null;
      botStatus = 'connected';
      connectionFailures = 0;
      await sock.sendPresenceUpdate('available');
      setTimeout(() => provisionAllGroups(sock), 3000);
      if (schedulerInterval) clearInterval(schedulerInterval);
      schedulerInterval = startScheduledLockChecker(sock);
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        await clearSession();
        setTimeout(startBot, 2000);
        return;
      }
      connectionFailures++;
      if (connectionFailures >= MAX_FAILURES) await clearSession();
      setTimeout(startBot, Math.min(5000 * connectionFailures, 15000));
    }
  });

  sock.ev.on('creds.update', () => saveState().catch(e => console.error('Save failed:', e.message)));

  // ====================== FULL MESSAGE HANDLER ======================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid?.endsWith('@g.us')) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      let text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''
      ).trim();

      if (!text) return;

      console.log(`📨 [${jid}] ${sender.split('@')[0]}: ${text}`);

      const metadata = await sock.groupMetadata(jid).catch(() => null);
      if (!metadata) return;

      const isUserAdmin = isAdmin(sender, metadata.participants);
      const settings = await getGroupSettings(jid);
      const command = text.toLowerCase().trim();

      // Bot on/off
      if (isUserAdmin) {
        if (command === '.bot on') {
          const success = await updateGroupSettings(jid, { bot_active: true });
          await sock.sendMessage(jid, { text: success ? '✅ Bot is now active' : '❌ Failed' });
          return;
        }
        if (command === '.bot off') {
          const success = await updateGroupSettings(jid, { bot_active: false });
          await sock.sendMessage(jid, { text: success ? '⏸️ Bot is now inactive' : '❌ Failed' });
          return;
        }
      }

      if (!settings.bot_active) return;

      // Anti-vulgar
      if (!isUserAdmin && settings.anti_vulgar) {
        const hasVulgar = VULGAR_WORDS.some(word => text.toLowerCase().includes(word));
        if (hasVulgar) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msg.key.id, participant: sender } });
          await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, vulgar words are not allowed.`, mentions: [sender] });
          return;
        }
      }

      // Anti-link
      if (!isUserAdmin && settings.anti_link) {
        const linkRegex = /(https?:\/\/|wa\.me|chat\.whatsapp\.com)/i;
        if (linkRegex.test(text)) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msg.key.id, participant: sender } });
          await handleStrike(sock, jid, sender, 'Links');
          return;
        }
      }

      if (!command.startsWith('.') || !isUserAdmin) return;

      console.log(`🔧 COMMAND EXECUTED: ${command}`);

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // .lock commands
      if (command === '.lock') {
        const meta = await sock.groupMetadata(jid);
        if (!meta.announce) {
          await sock.groupSettingUpdate(jid, 'announcement');
          await clearLockTime(jid);
          await sock.sendMessage(jid, { text: '🔒 Group locked' });
        }
      } else if (command === '.lock clear') {
        await clearLockTime(jid);
        await sock.sendMessage(jid, { text: '🔓 Lock cleared' });
      } else if (command.startsWith('.lock ')) {
        const timeArg = text.slice(6).trim();
        const parsed = parseTimeTo24h(timeArg);
        if (!parsed) return await sock.sendMessage(jid, { text: '❌ Invalid time. Use .lock 9:00PM' });
        await setScheduledLockTime(jid, parsed);
        await sock.sendMessage(jid, { text: `🔒 Auto-lock at ${formatTime24to12(parsed)}` });
      }

      // .unlock commands
      else if (command === '.unlock') {
        const meta = await sock.groupMetadata(jid);
        if (meta.announce) {
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await clearUnlockTime(jid);
          await sock.sendMessage(jid, { text: '🔓 Group unlocked' });
        }
      } else if (command === '.unlock clear') {
        await clearUnlockTime(jid);
        await sock.sendMessage(jid, { text: '🔒 Unlock cleared' });
      } else if (command.startsWith('.unlock ')) {
        const timeArg = text.slice(8).trim();
        const parsed = parseTimeTo24h(timeArg);
        if (!parsed) return await sock.sendMessage(jid, { text: '❌ Invalid time. Use .unlock 6:00AM' });
        await setScheduledUnlockTime(jid, parsed);
        await sock.sendMessage(jid, { text: `🔓 Auto-unlock at ${formatTime24to12(parsed)}` });
      }

      // .kick
      else if (command.startsWith('.kick')) {
        let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : null;
        if (!targets) return await sock.sendMessage(jid, { text: '❌ Tag or reply to kick' });
        
        for (const user of targets) {
          const userExists = metadata.participants.some(p => p.id === user);
          if (!userExists) continue;
          const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
          if (isTargetAdmin) continue;
          
          await sock.groupParticipantsUpdate(jid, [user], 'remove');
          await sock.sendMessage(jid, { text: `✅ @${user.split('@')[0]} removed`, mentions: [user] });
          await delay(500);
        }
      }

      // .strike reset
      else if (command.startsWith('.strike reset')) {
        let targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : null;
        if (!targets) return await sock.sendMessage(jid, { text: '❌ Tag user to reset strikes' });
        
        for (const user of targets) {
          await resetUserStrikes(jid, user);
          await sock.sendMessage(jid, { text: `✅ Strikes cleared`, mentions: [user] });
        }
      }

      // .tagall
      else if (command === '.tagall') {
        const allMembers = metadata.participants.map(p => p.id);
        await sock.sendMessage(jid, {
          text: `📢 ${allMembers.map(m => `@${m.split('@')[0]}`).join(' ')}`,
          mentions: allMembers
        });
      }

      // .delete
      else if (command === '.delete') {
        if (!ctx?.stanzaId || !ctx?.participant) return await sock.sendMessage(jid, { text: '❌ Reply to message to delete' });
        await sock.sendMessage(jid, { delete: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant } });
      }

      // .antilink
      else if (command === '.antilink on') {
        await updateGroupSettings(jid, { anti_link: true });
        await sock.sendMessage(jid, { text: '🔗 Anti-link enabled' });
      } else if (command === '.antilink off') {
        await updateGroupSettings(jid, { anti_link: false });
        await sock.sendMessage(jid, { text: '🔗 Anti-link disabled' });
      }

      // .vulgar
      else if (command === '.vulgar on') {
        await updateGroupSettings(jid, { anti_vulgar: true });
        await sock.sendMessage(jid, { text: '🔞 Vulgar filter enabled' });
      } else if (command === '.vulgar off') {
        await updateGroupSettings(jid, { anti_vulgar: false });
        await sock.sendMessage(jid, { text: '🔞 Vulgar filter disabled' });
      }

      // .help
      else if (command === '.help') {
        const sched = await getScheduledLock(jid);
        const helpText = [
          '📋 *COMMANDS*',
          '',
          '`.lock` - Lock now',
          '`.lock 9:00PM` - Schedule lock',
          '`.lock clear` - Cancel lock',
          '`.unlock` - Unlock now',
          '`.unlock 6:00AM` - Schedule unlock',
          '`.unlock clear` - Cancel unlock',
          '`.kick @user` - Kick user',
          '`.tagall` - Mention all',
          '`.delete` - Delete replied message',
          '`.strike reset @user` - Clear strikes',
          '`.antilink on/off`',
          '`.vulgar on/off`',
          '`.bot on/off`',
          '',
          `Bot: ${settings.bot_active ? '✅' : '⏸️'}`,
          `Anti-link: ${settings.anti_link ? '✅' : '❌'}`,
          `Anti-vulgar: ${settings.anti_vulgar ? '✅' : '❌'}`,
          sched?.lock_time ? `🔒 Lock: ${formatTime24to12(sched.lock_time)}` : '',
          sched?.unlock_time ? `🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` : ''
        ].filter(Boolean).join('\n');
        
        await sock.sendMessage(jid, { text: helpText });
      }
    } catch (err) {
      console.error('Message handler error:', err.message);
    }
  });

  // Group participants update
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { action, participants, id: groupJid } = update;
      if (!groupJid || !participants.length) return;

      if (['add', 'invite', 'linked_group_join'].includes(action)) {
        const settings = await getGroupSettings(groupJid);
        if (settings.bot_active) {
          let groupName = 'the group';
          try {
            const meta = await sock.groupMetadata(groupJid);
            groupName = meta.subject || 'the group';
          } catch {}
          scheduleWelcome(sock, groupJid, participants, groupName);
        }
      }

      if (['remove', 'leave'].includes(action)) {
        for (const user of participants) {
          await resetUserStrikes(groupJid, user);
        }
      }
    } catch (err) {
      console.error('Group update error:', err.message);
    }
  });
}

// ======================================================
// START SERVER
// ======================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  console.log(`📱 Open the URL above to scan QR\n`);
  startBot();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} already in use`);
    process.exit(1);
  }
});
