\/**
 * ======================================================
 * WhatsApp Bot - Production Grade (v1.0.4 - FINAL FIXED)
 * Baileys: 6.7.2 (protocol version locked)
 * Database: Supabase
 * Timezone: Africa/Lagos
 * ======================================================
 */

import {
  makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON
} from '@whiskeysockets/baileys';

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// ======================================================
// CONFIG
// ======================================================
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const BOT_TIMEZONE = "Africa/Lagos";

// Locked for your exact Baileys 6.7.2 (prevents 440 forever)
const BAILEYS_VERSION = [2, 3000, 1035194821];

const VULGAR_WORDS = [
  "fuck","fucking","fucker","fucked",
  "nigga","nigger","bitch","asshole",
  "shit","pussy","dick","cunt","whore","slut"
];

// ======================================================
// GLOBAL STATUS (used by routes + scheduler)
// ======================================================
let botStatus = 'starting';

// ======================================================
// SUPABASE
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: {
      fetch: (url, opts) =>
        fetch(url, { ...opts, signal: AbortSignal.timeout(10000) })
    }
  }
);

// ======================================================
// IN-MEMORY STORAGE
// ======================================================
const welcomeBuffers = new Map();
const firedThisMinute = new Set();

setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const key of firedThisMinute) {
    const ts = parseInt(key.split('_').pop() || '0');
    if (ts < oneHourAgo) firedThisMinute.delete(key);
  }
}, 3600000);

// ======================================================
// HELPERS
// ======================================================
const delay = ms => new Promise(r => setTimeout(r, ms));

const isAdmin = (jid, participants) => {
  if (!jid || !Array.isArray(participants)) return false;
  const user = participants.find(p => p?.id === jid);
  return user && (user.admin === 'admin' || user.admin === 'superadmin');
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
    const [hh, mm] = formatter.format(new Date()).split(':').map(Number);
    return { hh, mm };
  } catch {
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
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  } catch { return null; }
}

function formatTime24to12(hhmm) {
  if (!hhmm) return hhmm;
  const [hh, mm] = hhmm.split(':').map(Number);
  const period = hh >= 12 ? "PM" : "AM";
  const h = hh % 12 || 12;
  return `${h}:${mm.toString().padStart(2, '0')} ${period}`;
}

// ======================================================
// DATABASE FUNCTIONS
// ======================================================

async function getGroupSettings(groupJid) {
  if (!groupJid) return { bot_active: true, anti_link: true, anti_vulgar: true };
  const { data } = await supabase
    .from("group_settings")
    .select("bot_active, anti_link, anti_vulgar")
    .eq("group_jid", groupJid)
    .maybeSingle();
  if (!data) {
    await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true }, { onConflict: 'group_jid' });
    return { bot_active: true, anti_link: true, anti_vulgar: true };
  }
  return data;
}

async function updateGroupSettings(groupJid, updates) {
  if (!groupJid) return false;
  const { error } = await supabase
    .from("group_settings")
    .upsert({ group_jid: groupJid, ...updates }, { onConflict: 'group_jid' });
  return !error;
}

async function ensureGroupSettings(groupJid) {
  if (!groupJid) return false;
  const { error } = await supabase
    .from("group_settings")
    .upsert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true }, { onConflict: 'group_jid' });
  return !error;
}

async function getStrikes(groupJid, userJid) {
  if (!groupJid || !userJid) return 0;
  const { data } = await supabase
    .from("group_strikes")
    .select("strikes")
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid)
    .maybeSingle();
  return data?.strikes || 0;
}

async function incrementStrike(groupJid, userJid) {
  if (!groupJid || !userJid) return 0;
  const current = await getStrikes(groupJid, userJid);
  const newCount = current + 1;
  const { error } = await supabase
    .from("group_strikes")
    .upsert(
      { group_jid: groupJid, user_jid: userJid, strikes: newCount, last_strike: new Date().toISOString() },
      { onConflict: 'group_jid,user_jid' }
    );
  if (error && error.message.includes('last_strike')) {
    await supabase
      .from("group_strikes")
      .upsert(
        { group_jid: groupJid, user_jid: userJid, strikes: newCount },
        { onConflict: 'group_jid,user_jid' }
      );
  }
  return newCount;
}

async function resetUserStrikes(groupJid, userJid) {
  if (!groupJid || !userJid) return false;
  const { error } = await supabase
    .from("group_strikes")
    .delete()
    .eq("group_jid", groupJid)
    .eq("user_jid", userJid);
  return !error;
}

async function getScheduledLock(groupJid) {
  if (!groupJid) return null;
  const { data } = await supabase
    .from("group_scheduled_locks")
    .select("lock_time, unlock_time")
    .eq("group_jid", groupJid)
    .maybeSingle();
  return data || { lock_time: null, unlock_time: null };
}

async function setScheduledLockTime(groupJid, lockTime) {
  if (!groupJid) return false;
  const current = await getScheduledLock(groupJid);
  const { error } = await supabase
    .from("group_scheduled_locks")
    .upsert(
      { group_jid: groupJid, lock_time: lockTime, unlock_time: current?.unlock_time || null },
      { onConflict: 'group_jid' }
    );
  return !error;
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  if (!groupJid) return false;
  const current = await getScheduledLock(groupJid);
  const { error } = await supabase
    .from("group_scheduled_locks")
    .upsert(
      { group_jid: groupJid, lock_time: current?.lock_time || null, unlock_time: unlockTime },
      { onConflict: 'group_jid' }
    );
  return !error;
}

async function clearLockTime(groupJid) {
  if (!groupJid) return false;
  const current = await getScheduledLock(groupJid);
  const { error } = await supabase
    .from("group_scheduled_locks")
    .upsert(
      { group_jid: groupJid, lock_time: null, unlock_time: current?.unlock_time || null },
      { onConflict: 'group_jid' }
    );
  return !error;
}

async function clearUnlockTime(groupJid) {
  if (!groupJid) return false;
  const current = await getScheduledLock(groupJid);
  const { error } = await supabase
    .from("group_scheduled_locks")
    .upsert(
      { group_jid: groupJid, lock_time: current?.lock_time || null, unlock_time: null },
      { onConflict: 'group_jid' }
    );
  return !error;
}

async function ensureGroupScheduledLocks(groupJid) {
  if (!groupJid) return false;
  const { error } = await supabase
    .from("group_scheduled_locks")
    .upsert({ group_jid: groupJid, lock_time: null, unlock_time: null }, { onConflict: 'group_jid' });
  return !error;
}

async function provisionAllGroups(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    if (!botJid) return;
    const botPhone = botJid.split('@')[0].split(':')[0].replace(/\.\d+$/, '');
    let count = 0;
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p => {
        const pPhone = p.id.split('@')[0].split(':')[0].replace(/\.\d+$/, '');
        return pPhone === botPhone;
      });
      if (self && (self.admin === 'admin' || self.admin === 'superadmin')) {
        await ensureGroupSettings(groupJid);
        await ensureGroupScheduledLocks(groupJid);
        count++;
      }
    }
    console.log(`✅ Provisioning complete: ${count} groups`);
  } catch (err) {
    console.error('Provision error:', err.message);
  }
}

async function handleStrike(sock, jid, sender, reason) {
  const strikes = await incrementStrike(jid, sender);
  const tag = `@${sender.split('@')[0]}`;
  if (strikes >= 3) {
    await sock.sendMessage(jid, { text: `⛔ 3/3 ${tag} removed for ${reason}`, mentions: [sender] });
    await sock.groupParticipantsUpdate(jid, [sender], 'remove');
    await resetUserStrikes(jid, sender);
  } else {
    await sock.sendMessage(jid, { text: `⚠️ ${reason} not allowed. Strike ${strikes}/3`, mentions: [sender] });
  }
}

function scheduleWelcome(sock, groupJid, participants, groupName) {
  if (!sock || !groupJid || !participants?.length) return;
  const valid = participants.map(p => typeof p === 'string' ? p : p?.id).filter(Boolean);
  if (!valid.length) return;
  if (!welcomeBuffers.has(groupJid)) welcomeBuffers.set(groupJid, { participants: [] });
  const buffer = welcomeBuffers.get(groupJid);
  buffer.participants.push(...valid);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(async () => {
    const members = welcomeBuffers.get(groupJid)?.participants || [];
    welcomeBuffers.delete(groupJid);
    if (members.length && sock) {
      await sock.sendMessage(groupJid, {
        text: `👋 Welcome ${members.map(u => `@${u.split('@')[0]}`).join(', ')} to *${groupName}!*`,
        mentions: members
      });
    }
  }, 5000);
}

// ======================================================
// AUTH STATE MANAGEMENT
// ======================================================

async function loadSession() {
  try {
    console.log('🔍 Loading session from Supabase...');
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select('auth_data')
      .eq('id', SESSION_ID)
      .maybeSingle();
    if (error) {
      console.error('❌ Supabase query error:', error.message);
      return null;
    }
    if (!data?.auth_data) {
      console.log('📱 No session found');
      return null;
    }
    let authData;
    try {
      authData = JSON.parse(data.auth_data, BufferJSON.reviver);
    } catch (e) {
      console.error('❌ Failed to parse session:', e.message);
      return null;
    }
    if (!authData?.creds) return null;
    console.log('✅ Session loaded');
    return authData;
  } catch (err) {
    console.error('❌ loadSession error:', err.message);
    return null;
  }
}

async function saveSession(snapshot) {
  if (!snapshot?.creds) return false;
  try {
    const serialized = JSON.stringify(snapshot, BufferJSON.replacer);
    if (typeof serialized !== 'string') return false;
    const { error } = await supabase
      .from(WA_TABLE)
      .upsert({ id: SESSION_ID, auth_data: serialized, updated_at: new Date().toISOString() });
    if (error) {
      console.error('❌ saveSession error:', error.message);
      return false;
    }
    console.log('✅ Session saved');
    return true;
  } catch (err) {
    console.error('❌ saveSession exception:', err.message);
    return false;
  }
}

async function clearSession() {
  try {
    const { error } = await supabase
      .from(WA_TABLE)
      .update({ auth_data: null, updated_at: new Date().toISOString() })
      .eq('id', SESSION_ID);
    if (error) {
      console.error('❌ clearSession error:', error.message);
      return false;
    }
    console.log('✅ Session cleared');
    return true;
  } catch (err) {
    console.error('❌ clearSession exception:', err.message);
    return false;
  }
}

function buildAuthState(savedSession) {
  const creds = savedSession?.creds || initAuthCreds();
  let keyStore = {};
  if (savedSession?.keys) {
    try {
      keyStore = typeof savedSession.keys === 'string'
        ? JSON.parse(savedSession.keys, BufferJSON.reviver)
        : savedSession.keys;
    } catch (err) {
      console.error('Error parsing keys:', err.message);
    }
  }
  const keys = {
    get: (type, ids) => {
      const data = {};
      for (const id of ids) if (keyStore[type]?.[id] !== undefined) data[id] = keyStore[type][id];
      return data;
    },
    set: (data) => {
      if (!data) return;
      for (const cat of Object.keys(data)) {
        keyStore[cat] = keyStore[cat] || {};
        for (const id of Object.keys(data[cat])) {
          const val = data[cat][id];
          if (val == null) delete keyStore[cat][id];
          else keyStore[cat][id] = val;
        }
      }
      saveSession({ creds, keys: keyStore }).catch(() => {});
    }
  };
  return { creds, keys };
}

// ======================================================
// SCHEDULED LOCK CHECKER
// ======================================================
function startScheduledLockChecker(sock) {
  if (!sock) return;
  console.log(`⏰ Starting scheduler (${BOT_TIMEZONE})`);
  return setInterval(async () => {
    if (!sock || botStatus !== 'connected') return;
    const { hh, mm } = getCurrentTimeInZone();
    const nowStr = `${hh}:${mm.toString().padStart(2,'0')}`;
    const { data } = await supabase.from('group_scheduled_locks').select('group_jid, lock_time, unlock_time');
    if (!data) return;
    for (const row of data) {
      if (row.lock_time === nowStr) {
        const key = `lock_${row.group_jid}_${nowStr}`;
        if (!firedThisMinute.has(key)) {
          firedThisMinute.add(key);
          try {
            const meta = await sock.groupMetadata(row.group_jid);
            if (!meta.announce) {
              await sock.groupSettingUpdate(row.group_jid, 'announcement');
              await sock.sendMessage(row.group_jid, { text: `🔒 Auto-locked at ${formatTime24to12(nowStr)}` });
            }
          } catch (e) { console.error('Lock exec error:', e.message); }
          await clearLockTime(row.group_jid);
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
              await sock.groupSettingUpdate(row.group_jid, 'not_announcement');
              await sock.sendMessage(row.group_jid, { text: `🔓 Auto-unlocked at ${formatTime24to12(nowStr)}` });
            }
          } catch (e) { console.error('Unlock exec error:', e.message); }
          await clearUnlockTime(row.group_jid);
          setTimeout(() => firedThisMinute.delete(key), 61000);
        }
      }
    }
  }, 60000);
}

// ======================================================
// EXPRESS SETUP
// ======================================================
const app = express();
let currentQR = null;
let sock = null;
let schedulerInterval = null;
let connectionFailures = 0;
const MAX_FAILURES = 3;

// ---------- ROUTES ----------
app.get('/', async (req, res) => {
  let qrImage = null;
  if (botStatus === 'qr_ready' && currentQR && currentQR !== 'Loading...') {
    try { qrImage = await QRCode.toDataURL(currentQR); } catch {}
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>WhatsApp Bot</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); font-family:system-ui; min-height:100vh; display:flex; justify-content:center; align-items:center; padding:20px; }
      .card { background:white; border-radius:20px; padding:40px; max-width:500px; width:100%; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
      .qr-container { background:#f5f5f5; border-radius:15px; padding:30px; margin-bottom:20px; min-height:250px; display:flex; justify-content:center; align-items:center; }
      .qr-image { max-width:300px; border-radius:10px; }
      .connected-icon { font-size:64px; }
      .status { margin-top:15px; font-weight:500; padding:10px; border-radius:5px; }
      .status.connected { color:#28a745; background:#e8f5e9; }
      .status.waiting { color:#f59e0b; background:#fff3e0; }
      .force-btn { display:inline-block; background:#dc2626; color:white; text-decoration:none; padding:10px 20px; border-radius:5px; margin-top:15px; }
    </style>
    </head>
    <body>
      <div class="card">
        <h1>🤖 WhatsApp Bot</h1>
        <p>${botStatus === 'connected' ? 'Bot is online' : 'Scan QR to connect'}</p>
        <div class="qr-container" id="qrContainer">
          ${botStatus === 'connected' ? '<div class="connected-icon">✅</div>' :
            qrImage ? `<img src="${qrImage}" class="qr-image">` : '<div class="connected-icon">⏳</div>'}
        </div>
        <div class="status ${botStatus === 'connected' ? 'connected' : 'waiting'}" id="statusText">
          ${botStatus === 'connected' ? '✅ Connected' : botStatus === 'qr_ready' ? '⏳ Scan QR' : '🔄 Starting...'}
        </div>
        <a href="/force-qr" class="force-btn">🔄 New QR</a>
        <a href="/debug-db" class="force-btn" style="background:#4b5563; margin-left:10px;">🔍 Debug DB</a>
      </div>
      <script>
        async function checkStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (data.connected) {
              document.getElementById('qrContainer').innerHTML = '<div class="connected-icon">✅</div>';
              document.getElementById('statusText').innerHTML = '✅ Connected';
            } else if (data.qr) {
              document.getElementById('qrContainer').innerHTML = '<img src="'+data.qr+'" class="qr-image">';
              document.getElementById('statusText').innerHTML = '⏳ Scan QR';
            }
          } catch {}
        }
        setInterval(checkStatus, 3000);
        checkStatus();
      </script>
    </body>
    </html>
  `);
});

app.get('/force-qr', async (req, res) => {
  console.log('🔄 Forcing new QR');
  await clearSession();
  currentQR = null;
  botStatus = 'starting';
  connectionFailures = 0;
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
    sock = null;
  }
  setTimeout(startBot, 1000);
  res.send('<html><head><meta http-equiv="refresh" content="2;url=/"></head><body style="background:#0f172a;color:white;text-align:center;padding:50px"><h1>🔄 Generating new QR...</h1></body></html>');
});

app.get('/api/status', async (req, res) => {
  let qrImage = null;
  if (botStatus === 'qr_ready' && currentQR) {
    qrImage = await QRCode.toDataURL(currentQR).catch(() => null);
  }
  res.json({ connected: botStatus === 'connected', qr: qrImage });
});

app.get('/debug-db', async (req, res) => {
  const tables = ['group_settings','group_strikes','group_scheduled_locks','wa_sessions'];
  const result = {};
  for (const t of tables) {
    try {
      const { data, error } = await supabase.from(t).select('*').limit(1);
      result[t] = { exists: !error, error: error?.message, hasData: data?.length > 0 };
    } catch (err) {
      result[t] = { exists: false, error: err.message };
    }
  }
  res.json(result);
});

app.get('/health', (req, res) => res.json({ status: 'ok', botStatus, uptime: process.uptime() }));

// ======================================================
// BOT STARTUP
// ======================================================
async function startBot() {
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
    sock = null;
  }

  console.log(`📱 Using locked Baileys version: ${BAILEYS_VERSION.join('.')}`);

  const savedSession = await loadSession();
  const authState = buildAuthState(savedSession);

  sock = makeWASocket({
    version: BAILEYS_VERSION,
    auth: authState,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '126.0.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    qrTimeout: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 1000,
    maxRetries: 3,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast'
  });

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    console.log('📡 Connection update:', { connection, hasQR: !!qr });

    if (qr) {
      console.log('\n✅✅✅ QR READY\n');
      currentQR = qr;
      botStatus = 'qr_ready';
      connectionFailures = 0;
      try { qrcode.generate(qr, { small: true }); } catch {}
      return;
    }

    if (connection === 'open') {
      console.log('\n✅✅✅ CONNECTED\n');
      currentQR = null;
      botStatus = 'connected';
      connectionFailures = 0;
      try { await sock.sendPresenceUpdate('available'); } catch {}
      setTimeout(() => provisionAllGroups(sock), 3000);
      if (schedulerInterval) clearInterval(schedulerInterval);
      schedulerInterval = startScheduledLockChecker(sock);
      return;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Closed:', code);

      if (code === DisconnectReason.loggedOut) {
        console.log('🚫 Logged out');
        await clearSession();
        connectionFailures = 0;
        setTimeout(startBot, 2000);
        return;
      }

      connectionFailures++;
      if (connectionFailures >= MAX_FAILURES) {
        console.log('🔄 Too many failures, clearing session');
        await clearSession();
        connectionFailures = 0;
        setTimeout(startBot, 2000);
      } else {
        const delay = Math.min(5000 * connectionFailures, 15000);
        console.log(`🔄 Reconnecting in ${delay/1000}s`);
        setTimeout(startBot, delay);
      }
    }
  });

  sock.ev.on('creds.update', () => {
    saveSession({ creds: authState.creds, keys: authState.keys }).catch(() => {});
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast' || !jid.endsWith('@g.us')) return;
      const sender = msg.key.participant || msg.key.remoteJid;
      if (!sender) return;

      const metadata = await sock.groupMetadata(jid).catch(() => null);
      if (!metadata) return;
      const isUserAdmin = isAdmin(sender, metadata.participants);

      let text = '';
      try {
        text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '').trim();
      } catch { return; }
      if (!text) return;

      const settings = await getGroupSettings(jid);
      const command = text.toLowerCase().trim();
      const isCommand = command.startsWith('.');

      // .bot on/off (even when off)
      if (isCommand && isUserAdmin) {
        if (command === '.bot on') {
          await updateGroupSettings(jid, { bot_active: true });
          await sock.sendMessage(jid, { text: '✅ Bot active' });
          return;
        }
        if (command === '.bot off') {
          await updateGroupSettings(jid, { bot_active: false });
          await sock.sendMessage(jid, { text: '⏸️ Bot inactive' });
          return;
        }
      }

      if (!settings.bot_active) {
        if (isCommand && isUserAdmin && command !== '.bot on' && command !== '.bot off') {
          await sock.sendMessage(jid, { text: '⚠️ Bot is off. Use `.bot on` to activate.' });
        }
        return;
      }

      // Anti-vulgar (non-admins)
      if (!isUserAdmin && settings.anti_vulgar) {
        const hasVulgar = VULGAR_WORDS.some(w => text.toLowerCase().includes(w));
        if (hasVulgar) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } }).catch(() => {});
          await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, vulgar words not allowed.`, mentions: [sender] }).catch(() => {});
          return;
        }
      }

      // Anti-link (non-admins)
      if (!isUserAdmin && settings.anti_link) {
        const linkRegex = /(https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/i;
        if (linkRegex.test(text)) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender } }).catch(() => {});
          await handleStrike(sock, jid, sender, 'Links');
          return;
        }
      }

      if (!isCommand || !isUserAdmin) return;

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // ---------- COMMANDS ----------
      if (command === '.lock') {
        const meta = await sock.groupMetadata(jid);
        if (!meta.announce) {
          await sock.groupSettingUpdate(jid, 'announcement');
          await clearLockTime(jid);
          await sock.sendMessage(jid, { text: '🔒 Group locked' });
        }
      } else if (command === '.lock clear') {
        await clearLockTime(jid);
        await sock.sendMessage(jid, { text: '🔓 Lock schedule cleared' });
      } else if (command.startsWith('.lock ')) {
        const time = parseTimeTo24h(text.slice(6));
        if (!time) {
          await sock.sendMessage(jid, { text: '❌ Invalid time. Use .lock 9:00PM' });
          return;
        }
        if (await setScheduledLockTime(jid, time)) {
          await sock.sendMessage(jid, { text: `🔒 Auto-lock at ${formatTime24to12(time)}` });
        }
      } else if (command === '.unlock') {
        const meta = await sock.groupMetadata(jid);
        if (meta.announce) {
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await clearUnlockTime(jid);
          await sock.sendMessage(jid, { text: '🔓 Group unlocked' });
        }
      } else if (command === '.unlock clear') {
        await clearUnlockTime(jid);
        await sock.sendMessage(jid, { text: '🔒 Unlock schedule cleared' });
      } else if (command.startsWith('.unlock ')) {
        const time = parseTimeTo24h(text.slice(8));
        if (!time) {
          await sock.sendMessage(jid, { text: '❌ Invalid time. Use .unlock 6:00AM' });
          return;
        }
        if (await setScheduledUnlockTime(jid, time)) {
          await sock.sendMessage(jid, { text: `🔓 Auto-unlock at ${formatTime24to12(time)}` });
        }
      } else if (command === '.kick' || command.startsWith('.kick ')) {
        const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
        if (!targets.length) {
          await sock.sendMessage(jid, { text: '❌ Tag or reply to kick' });
          return;
        }
        for (const user of targets) {
          const exists = metadata.participants.some(p => p.id === user);
          if (!exists) {
            await sock.sendMessage(jid, { text: `❌ @${user.split('@')[0]} not in group`, mentions: [user] });
            continue;
          }
          const isAdminTarget = metadata.participants.find(p => p.id === user)?.admin;
          if (isAdminTarget) {
            await sock.sendMessage(jid, { text: '❌ Cannot remove admin' });
            continue;
          }
          await sock.groupParticipantsUpdate(jid, [user], 'remove');
          await sock.sendMessage(jid, { text: `✅ @${user.split('@')[0]} removed`, mentions: [user] });
          await delay(500);
        }
      } else if (command === '.strike reset' || command.startsWith('.strike reset ')) {
        const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
        if (!targets.length) {
          await sock.sendMessage(jid, { text: '❌ Tag user to reset strikes' });
          return;
        }
        for (const user of targets) {
          if (await resetUserStrikes(jid, user)) {
            await sock.sendMessage(jid, { text: `✅ Strikes cleared`, mentions: [user] });
          }
        }
      } else if (command === '.tagall') {
        const all = metadata.participants.map(p => p.id);
        await sock.sendMessage(jid, { text: `📢 ${all.map(m => `@${m.split('@')[0]}`).join(' ')}`, mentions: all });
      } else if (command === '.delete') {
        if (!ctx?.stanzaId) {
          await sock.sendMessage(jid, { text: '❌ Reply to message to delete' });
          return;
        }
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant } });
      } else if (command === '.antilink on') {
        if (await updateGroupSettings(jid, { anti_link: true })) await sock.sendMessage(jid, { text: '🔗 Anti-link on' });
      } else if (command === '.antilink off') {
        if (await updateGroupSettings(jid, { anti_link: false })) await sock.sendMessage(jid, { text: '🔗 Anti-link off' });
      } else if (command === '.vulgar on') {
        if (await updateGroupSettings(jid, { anti_vulgar: true })) await sock.sendMessage(jid, { text: '🔞 Vulgar filter on' });
      } else if (command === '.vulgar off') {
        if (await updateGroupSettings(jid, { anti_vulgar: false })) await sock.sendMessage(jid, { text: '🔞 Vulgar filter off' });
      } else if (command === '.help') {
        const sched = await getScheduledLock(jid);
        const lockInfo = sched?.lock_time ? `\n🔒 Lock: ${formatTime24to12(sched.lock_time)}` : '';
        const unlockInfo = sched?.unlock_time ? `\n🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` : '';
        await sock.sendMessage(jid, {
          text: `📋 *COMMANDS*\n\n` +
                `.lock\n.lock 9:00PM\n.lock clear\n` +
                `.unlock\n.unlock 6:00AM\n.unlock clear\n` +
                `.kick @user\n.tagall\n.delete\n` +
                `.strike reset @user\n` +
                `.antilink on/off\n.vulgar on/off\n.bot on/off\n\n` +
                `Bot: ${settings.bot_active ? '✅' : '⏸️'}\n` +
                `Anti-link: ${settings.anti_link ? '✅' : '❌'}\n` +
                `Anti-vulgar: ${settings.anti_vulgar ? '✅' : '❌'}` +
                lockInfo + unlockInfo
        });
      }
    } catch (err) {
      console.error('Msg error:', err.message);
    }
  });

  sock.ev.on('group-participants.update', async ({ action, participants, id }) => {
    if (!id || !participants?.length) return;
    if (['add','invite','linked_group_join'].includes(action)) {
      const settings = await getGroupSettings(id);
      if (settings.bot_active) {
        let name = 'the group';
        try { name = (await sock.groupMetadata(id)).subject; } catch {}
        scheduleWelcome(sock, id, participants, name);
      }
    } else if (action === 'remove' || action === 'leave') {
      for (const u of participants) await resetUserStrikes(id, u).catch(() => {});
    }
  });
}

// ======================================================
// START SERVER
// ======================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  startBot();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} in use`);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
  }
  process.exit(0);
});
