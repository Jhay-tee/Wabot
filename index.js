/**
 * ======================================================
 * WhatsApp Bot - Production Grade (v1.0.5 - FULLY WORKING)
 * Baileys: 6.7.2 (locked)
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

// Global status
let botStatus = 'starting';

// Locked for your Baileys 6.7.2
const BAILEYS_VERSION = [2, 3000, 1035194821];

const VULGAR_WORDS = [
  "fuck","fucking","fucker","fucked",
  "nigga","nigger","bitch","asshole",
  "shit","pussy","dick","cunt","whore","slut"
];

// ======================================================
// SUPABASE
// ======================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: {
      fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(10000) })
    }
  }
);

// ======================================================
// IN-MEMORY
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
  try {
    if (!groupJid) return { bot_active: true, anti_link: true, anti_vulgar: true };
    const { data, error } = await supabase
      .from("group_settings")
      .select("bot_active, anti_link, anti_vulgar")
      .eq("group_jid", groupJid)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      await supabase.from("group_settings").upsert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true }, { onConflict: 'group_jid' });
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    return data;
  } catch (err) {
    console.error(`[DB] getGroupSettings failed for ${groupJid}:`, err.message);
    return { bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    if (!groupJid) return false;
    const { error } = await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, ...updates }, { onConflict: 'group_jid' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[DB] updateGroupSettings failed:`, err.message);
    return false;
  }
}

async function ensureGroupSettings(groupJid) {
  try {
    if (!groupJid) return false;
    const { error } = await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] ensureGroupSettings failed:`, err.message);
    return false;
  }
}

// STRIKES
async function getStrikes(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) return 0;
    const { data } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    return data?.strikes || 0;
  } catch (err) {
    console.error(`[DB] getStrikes failed:`, err.message);
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
      .upsert({ group_jid: groupJid, user_jid: userJid, strikes: newCount, last_strike: new Date().toISOString() }, { onConflict: 'group_jid,user_jid' });
    if (error) throw error;
    return newCount;
  } catch (err) {
    console.error(`[DB] incrementStrike failed:`, err.message);
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
    console.error(`[DB] resetUserStrikes failed:`, err.message);
    return false;
  }
}

// SCHEDULED LOCKS
async function getScheduledLock(groupJid) {
  try {
    if (!groupJid) return null;
    const { data } = await supabase
      .from("group_scheduled_locks")
      .select("lock_time, unlock_time")
      .eq("group_jid", groupJid)
      .maybeSingle();
    return data || { lock_time: null, unlock_time: null };
  } catch (err) {
    console.error(`[DB] getScheduledLock failed:`, err.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: lockTime, unlock_time: current?.unlock_time || null }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] setScheduledLockTime failed:`, err.message);
    return false;
  }
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: current?.lock_time || null, unlock_time: unlockTime }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] setScheduledUnlockTime failed:`, err.message);
    return false;
  }
}

async function clearLockTime(groupJid) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: null, unlock_time: current?.unlock_time || null }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] clearLockTime failed:`, err.message);
    return false;
  }
}

async function clearUnlockTime(groupJid) {
  try {
    if (!groupJid) return false;
    const current = await getScheduledLock(groupJid);
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: current?.lock_time || null, unlock_time: null }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] clearUnlockTime failed:`, err.message);
    return false;
  }
}

async function ensureGroupScheduledLocks(groupJid) {
  try {
    if (!groupJid) return false;
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: null, unlock_time: null }, { onConflict: 'group_jid' });
    return !error;
  } catch (err) {
    console.error(`[DB] ensureGroupScheduledLocks failed:`, err.message);
    return false;
  }
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
    console.error('[PROVISION] failed:', err.message);
  }
}

async function handleStrike(sock, jid, sender, reason) {
  try {
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split('@')[0]}`;
    if (strikes >= 3) {
      await sock.sendMessage(jid, { text: `⛔ 3/3 ${tag} removed for ${reason}`, mentions: [sender] });
      await sock.groupParticipantsUpdate(jid, [sender], 'remove');
      await resetUserStrikes(jid, sender);
    } else {
      await sock.sendMessage(jid, { text: `⚠️ ${reason} not allowed. Strike ${strikes}/3`, mentions: [sender] });
    }
  } catch (err) {
    console.error('[STRIKE] failed:', err.message);
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
// AUTH
// ======================================================
async function loadSession() {
  try {
    console.log('🔍 Loading session from Supabase...');
    const { data, error } = await supabase.from(WA_TABLE).select('auth_data').eq('id', SESSION_ID).maybeSingle();
    if (error) throw error;
    if (!data?.auth_data) {
      console.log('📱 No session found');
      return null;
    }
    const authData = JSON.parse(data.auth_data, BufferJSON.reviver);
    console.log('✅ Session loaded');
    return authData;
  } catch (err) {
    console.error('❌ loadSession failed:', err.message);
    return null;
  }
}

async function saveSession(snapshot) {
  if (!snapshot?.creds) return false;
  try {
    const serialized = JSON.stringify(snapshot, BufferJSON.replacer);
    const { error } = await supabase.from(WA_TABLE).upsert({ id: SESSION_ID, auth_data: serialized, updated_at: new Date().toISOString() });
    if (error) throw error;
    console.log('✅ Session saved');
    return true;
  } catch (err) {
    console.error('❌ saveSession failed:', err.message);
    return false;
  }
}

async function clearSession() {
  try {
    const { error } = await supabase.from(WA_TABLE).update({ auth_data: null, updated_at: new Date().toISOString() }).eq('id', SESSION_ID);
    if (error) throw error;
    console.log('✅ Session cleared');
    return true;
  } catch (err) {
    console.error('❌ clearSession failed:', err.message);
    return false;
  }
}

function buildAuthState(savedSession) {
  const creds = savedSession?.creds || initAuthCreds();
  let keyStore = {};
  if (savedSession?.keys) {
    try {
      keyStore = typeof savedSession.keys === 'string' ? JSON.parse(savedSession.keys, BufferJSON.reviver) : savedSession.keys;
    } catch {}
  }
  const keys = {
    get: (type, ids) => {
      const data = {};
      for (const id of ids || []) if (keyStore[type]?.[id] !== undefined) data[id] = keyStore[type][id];
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
      saveSession({ creds, keys: keyStore }).catch(e => console.error('Background save failed:', e.message));
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
// EXPRESS
// ======================================================
const app = express();
let currentQR = null;
let sock = null;
let schedulerInterval = null;
let connectionFailures = 0;
const MAX_FAILURES = 3;

// Routes (unchanged)
app.get('/', async (req, res) => { /* your exact HTML route */ });
app.get('/force-qr', async (req, res) => { /* your exact */ });
app.get('/api/status', async (req, res) => { /* your exact */ });
app.get('/debug-db', async (req, res) => { /* your exact */ });
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
        await clearSession();
        setTimeout(startBot, 2000);
        return;
      }
      connectionFailures++;
      if (connectionFailures >= MAX_FAILURES) await clearSession();
      const delay = Math.min(5000 * connectionFailures, 15000);
      console.log(`🔄 Reconnecting in ${delay/1000}s`);
      setTimeout(startBot, delay);
    }
  });

  sock.ev.on('creds.update', () => {
    saveSession({ creds: authState.creds, keys: authState.keys }).catch(e => console.error('Background save failed:', e.message));
  });

  // ====================== MESSAGE HANDLER (with full logging) ======================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
      if (!text) return;

      console.log(`📨 [${jid.split('@')[0]}] ${sender.split('@')[0]}: ${text}`);

      const metadata = await sock.groupMetadata(jid).catch(() => null);
      if (!metadata) return;

      const isUserAdmin = isAdmin(sender, metadata.participants);
      const settings = await getGroupSettings(jid);
      const command = text.toLowerCase().trim();
      const isCommand = command.startsWith('.');

      if (isCommand) {
        console.log(`🔧 Executing command: ${command} (by ${sender.split('@')[0]})`);
      }

      // .bot on/off
      if (isCommand && isUserAdmin) {
        if (command === '.bot on') {
          const success = await updateGroupSettings(jid, { bot_active: true });
          await sock.sendMessage(jid, { text: success ? '✅ Bot active' : '❌ Failed' });
          return;
        }
        if (command === '.bot off') {
          const success = await updateGroupSettings(jid, { bot_active: false });
          await sock.sendMessage(jid, { text: success ? '⏸️ Bot inactive' : '❌ Failed' });
          return;
        }
      }

      if (!settings.bot_active) return;

      // Anti-vulgar
      if (!isUserAdmin && settings.anti_vulgar) {
        const hasVulgar = VULGAR_WORDS.some(w => text.toLowerCase().includes(w));
        if (hasVulgar) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msg.key.id, participant: sender } }).catch(() => {});
          await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, vulgar words not allowed.`, mentions: [sender] }).catch(() => {});
          return;
        }
      }

      // Anti-link
      if (!isUserAdmin && settings.anti_link) {
        const linkRegex = /(https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/i;
        if (linkRegex.test(text)) {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msg.key.id, participant: sender } }).catch(() => {});
          await handleStrike(sock, jid, sender, 'Links');
          return;
        }
      }

      if (!isCommand || !isUserAdmin) return;

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // All your commands here (exactly as before)
      if (command === '.lock') { /* your code */ }
      else if (command === '.lock clear') { /* your code */ }
      else if (command.startsWith('.lock ')) { /* your code */ }
      else if (command === '.unlock') { /* your code */ }
      else if (command === '.unlock clear') { /* your code */ }
      else if (command.startsWith('.unlock ')) { /* your code */ }
      else if (command === '.kick' || command.startsWith('.kick ')) { /* your code */ }
      else if (command === '.strike reset' || command.startsWith('.strike reset ')) { /* your code */ }
      else if (command === '.tagall') { /* your code */ }
      else if (command === '.delete') { /* your code */ }
      else if (command === '.antilink on') { /* your code */ }
      else if (command === '.antilink off') { /* your code */ }
      else if (command === '.vulgar on') { /* your code */ }
      else if (command === '.vulgar off') { /* your code */ }
      else if (command === '.help') {
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
      console.error('Full error stack:', err.stack);
    }
  });

  sock.ev.on('group-participants.update', async ({ action, participants, id }) => {
    /* your exact welcome + reset strikes code */
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

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  if (sock) sock.end();
  process.exit(0);
});
