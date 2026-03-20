import pkg from '@whiskeysockets/baileys';
const { 
  default: makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON 
} = pkg;

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
const BOT_TIMEZONE = "Africa/Lagos";
const VULGAR_WORDS = [
  "fuck","fucking","fucker","fucked",
  "nigga","nigger","bitch","asshole",
  "shit","pussy","dick","cunt","whore","slut"
];

// Hardcode a known working version for Baileys 6.7.2
const BAILEYS_VERSION = [2, 3000, 1035194821];

// -------- SUPABASE CLIENT --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    global: {
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) })
    }
  }
);

// -------- GLOBAL STATE --------
let botStatus = 'starting';
let currentQR = null;
let sock = null;
let schedulerInterval = null;
let botInternalId = null; // will be learned from first group add

// -------- SESSION STATE --------
let creds = null;
let keys = {};

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

function extractPhoneNumber(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0].replace(/\.\d+$/, '');
}

function getCurrentTimeInZone() {
  const now = new Date();
  return { hh: now.getHours(), mm: now.getMinutes() };
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

// -------- SESSION MANAGEMENT --------
async function loadSession() {
  try {
    console.log('🔍 Loading session from Supabase...');
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select('auth_data')
      .eq('id', SESSION_ID)
      .maybeSingle();
    if (error) {
      console.error('❌ DB error:', error.message);
      return false;
    }
    if (!data?.auth_data) {
      console.log('📱 No session found - will generate QR');
      // Reset in-memory credentials to force fresh start
      creds = null;
      keys = {};
      return false;
    }
    const session = JSON.parse(data.auth_data, BufferJSON.reviver);
    creds = session.creds || initAuthCreds();
    keys = session.keys || {};
    console.log('✅ Session loaded');
    return true;
  } catch (err) {
    console.log('Load error:', err.message);
    // On error, also reset credentials
    creds = null;
    keys = {};
    return false;
  }
}

async function saveSession() {
  if (!creds) return false;
  try {
    const serialized = JSON.stringify({ creds, keys }, BufferJSON.replacer);
    const { error } = await supabase
      .from(WA_TABLE)
      .upsert({ id: SESSION_ID, auth_data: serialized });
    if (error) {
      console.error('❌ Save error:', error.message);
      return false;
    }
    console.log('✅ Session saved');
    return true;
  } catch (err) {
    console.error('❌ Save exception:', err);
    return false;
  }
}

// -------- CLEAR SESSION (both DB and memory) --------
async function clearSession() {
  try {
    console.log('🗑️ Clearing session from Supabase...');
    await supabase.from(WA_TABLE).update({ auth_data: null }).eq('id', SESSION_ID);
    // Reset in-memory credentials
    creds = null;
    keys = {};
    botInternalId = null; // also forget learned ID
    console.log('✅ Session cleared (memory reset)');
  } catch (err) {
    console.log('❌ Clear session error:', err?.message);
  }
}

// -------- DATABASE FUNCTIONS - GROUP SETTINGS --------
async function getGroupSettings(groupJid) {
  try {
    const { data, error } = await supabase
      .from("group_settings")
      .select("bot_active, anti_link, anti_vulgar")
      .eq("group_jid", groupJid)
      .maybeSingle();
    if (error) {
      console.log(`❌ getGroupSettings error:`, error.message);
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    if (!data) {
      // Auto-create if doesn't exist
      const { error: insertError } = await supabase
        .from("group_settings")
        .insert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true });
      if (insertError) {
        console.log(`❌ getGroupSettings insert error:`, insertError.message);
      }
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    return data;
  } catch (err) {
    console.log(`❌ getGroupSettings exception:`, err.message);
    return { bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    const { error } = await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, ...updates }, { onConflict: 'group_jid' });
    if (error) {
      console.log(`❌ updateGroupSettings error:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`❌ updateGroupSettings exception:`, err.message);
    return false;
  }
}

async function ensureGroupSettings(groupJid) {
  try {
    const { error } = await supabase
      .from("group_settings")
      .upsert({ group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true }, { onConflict: 'group_jid' });
    if (error) {
      console.log(`❌ ensureGroupSettings error:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`❌ ensureGroupSettings exception:`, err.message);
    return false;
  }
}

// -------- DATABASE FUNCTIONS - STRIKES --------
async function getStrikes(groupJid, userJid) {
  try {
    const { data, error } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    if (error) {
      console.log(`❌ getStrikes error:`, error.message);
      return 0;
    }
    return data?.strikes || 0;
  } catch (err) {
    console.log(`❌ getStrikes exception:`, err.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  try {
    const current = await getStrikes(groupJid, userJid);
    const newCount = current + 1;
    await supabase
      .from("group_strikes")
      .upsert(
        { group_jid: groupJid, user_jid: userJid, strikes: newCount, last_strike: new Date() },
        { onConflict: 'group_jid,user_jid' }
      );
    return newCount;
  } catch (err) {
    console.log(`❌ incrementStrike error:`, err.message);
    return 0;
  }
}

async function resetUserStrikes(groupJid, userJid) {
  try {
    await supabase
      .from("group_strikes")
      .delete()
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid);
    return true;
  } catch (err) {
    console.log(`❌ resetUserStrikes error:`, err.message);
    return false;
  }
}

// -------- DATABASE FUNCTIONS - SCHEDULED LOCKS --------
async function getScheduledLock(groupJid) {
  try {
    const { data, error } = await supabase
      .from("group_scheduled_locks")
      .select("lock_time, unlock_time")
      .eq("group_jid", groupJid)
      .maybeSingle();
    if (error) {
      console.log(`❌ getScheduledLock error:`, error.message);
      return null;
    }
    return data || { lock_time: null, unlock_time: null };
  } catch (err) {
    console.log(`❌ getScheduledLock exception:`, err.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: lockTime }, { onConflict: 'group_jid' });
    return true;
  } catch (err) {
    console.log(`❌ setScheduledLockTime error:`, err.message);
    return false;
  }
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, unlock_time: unlockTime }, { onConflict: 'group_jid' });
    return true;
  } catch (err) {
    console.log(`❌ setScheduledUnlockTime error:`, err.message);
    return false;
  }
}

async function clearLockTime(groupJid) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .update({ lock_time: null })
      .eq("group_jid", groupJid);
  } catch (err) {
    console.log(`❌ clearLockTime error:`, err.message);
  }
}

async function clearUnlockTime(groupJid) {
  try {
    await supabase
      .from("group_scheduled_locks")
      .update({ unlock_time: null })
      .eq("group_jid", groupJid);
  } catch (err) {
    console.log(`❌ clearUnlockTime error:`, err.message);
  }
}

async function ensureGroupScheduledLocks(groupJid) {
  try {
    const { error } = await supabase
      .from("group_scheduled_locks")
      .upsert({ group_jid: groupJid, lock_time: null, unlock_time: null }, { onConflict: 'group_jid' });
    if (error) {
      console.log(`❌ ensureGroupScheduledLocks error:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`❌ ensureGroupScheduledLocks exception:`, err.message);
    return false;
  }
}

// -------- PROVISION GROUPS (uses learned internal ID) --------
async function provisionAllGroups(sock) {
  try {
    console.log('🔍 Checking groups...');
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    if (!botJid) return;

    // Use learned internal ID if available, otherwise fallback to phone number
    const matchId = botInternalId || botJid.split('@')[0].split(':')[0];
    console.log('🔍 Matching with ID:', matchId);

    let adminCount = 0;
    for (const [groupJid, meta] of Object.entries(groups)) {
      const botParticipant = meta.participants?.find(p => {
        const participantId = p.id.split('@')[0];
        return participantId === matchId;
      });

      if (botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin')) {
        adminCount++;
        await ensureGroupSettings(groupJid);
        await ensureGroupScheduledLocks(groupJid);
      }
    }
    console.log(`✅ Found ${adminCount} admin groups`);
  } catch (err) {
    console.log('❌ Provision error:', err.message);
  }
}

// -------- STRIKE HANDLER --------
async function handleStrike(sock, jid, sender, reason) {
  const strikes = await incrementStrike(jid, sender);
  const tag = `@${sender.split('@')[0]}`;
  if (strikes >= 3) {
    await sock.sendMessage(jid, { text: `⛔ 3/3 ${tag} removed`, mentions: [sender] });
    await sock.groupParticipantsUpdate(jid, [sender], 'remove');
    await resetUserStrikes(jid, sender);
  } else {
    await sock.sendMessage(jid, { text: `⚠️ Strike ${strikes}/3`, mentions: [sender] });
  }
}

// -------- WELCOME BATCH --------
const welcomeBuffers = new Map();
function scheduleWelcome(sock, groupJid, participants, groupName) {
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
      const mentionText = members.map(u => `@${u.split('@')[0]}`).join(', ');
      await sock.sendMessage(groupJid, {
        text: `👋 Welcome ${mentionText} to *${groupName}!*`,
        mentions: members
      });
    }
  }, 5000);
}

// -------- SCHEDULED LOCK CHECKER --------
const firedThisMinute = new Set();
function startScheduledLockChecker(sock) {
  return setInterval(async () => {
    try {
      if (!sock || botStatus !== 'connected') return;
      const { hh, mm } = getCurrentTimeInZone();
      const nowStr = `${hh}:${mm.toString().padStart(2, '0')}`;
      const { data } = await supabase
        .from('group_scheduled_locks')
        .select('group_jid, lock_time, unlock_time');
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
                await sock.sendMessage(row.group_jid, { text: `🔒 Auto-locked` });
                await clearLockTime(row.group_jid);
              }
            } catch (e) {}
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
                await sock.sendMessage(row.group_jid, { text: `🔓 Auto-unlocked` });
                await clearUnlockTime(row.group_jid);
              }
            } catch (e) {}
            setTimeout(() => firedThisMinute.delete(key), 61000);
          }
        }
      }
    } catch (err) {}
  }, 60000);
}

// -------- EXPRESS SETUP --------
const app = express();

app.get('/', async (req, res) => {
  let qrImage = null;
  if (botStatus === 'qr_ready' && currentQR) {
    qrImage = await QRCode.toDataURL(currentQR).catch(() => null);
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>WhatsApp Bot</title></head>
    <body>
      <h1>Bot Status: ${botStatus}</h1>
      ${qrImage ? `<img src="${qrImage}" style="width:300px;">` : '<p>No QR</p>'}
      <br><a href="/force-qr">Force New QR</a>
      <br><a href="/health">Health</a>
    </body>
    </html>
  `);
});

app.get('/force-qr', async (req, res) => {
  console.log('⚠️ /force-qr endpoint called');
  await clearSession(); // clears DB and resets memory
  currentQR = null;
  botStatus = 'starting';
  if (sock) sock.end();
  res.redirect('/');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', botStatus, uptime: process.uptime() });
});

// -------- BOT STARTUP --------
async function startBot() {
  if (sock) {
    sock.ev.removeAllListeners();
    sock.end();
    sock = null;
  }

  await loadSession(); // this may set creds to null if no session

  const keysHandler = {
    get: (type, ids) => {
      const data = {};
      for (const id of ids || []) {
        if (keys[type]?.[id]) data[id] = keys[type][id];
      }
      return data;
    },
    set: (data) => {
      if (!data) return;
      for (const cat in data) {
        keys[cat] = keys[cat] || {};
        for (const id in data[cat]) {
          keys[cat][id] = data[cat][id];
        }
      }
    }
  };

  sock = makeWASocket({
    version: BAILEYS_VERSION,
    auth: { creds: creds || initAuthCreds(), keys: keysHandler },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '126.0.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    qrTimeout: 60000
  });

  sock.ev.on('error', (err) => {
    console.log('💥 Socket error:', err);
  });

  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    console.log('📡', { connection, hasQR: !!qr });

    if (qr) {
      console.log('\n✅✅✅ QR READY - SCAN NOW (60 seconds)\n');
      currentQR = qr;
      botStatus = 'qr_ready';
      qrcode.generate(qr, { small: true });
      return;
    }

    if (connection === 'connecting') {
      console.log('🔄 Connecting to WhatsApp...');
      return;
    }

    if (connection === 'open') {
      console.log('\n✅✅✅ CONNECTED\n');
      botStatus = 'connected';
      await saveSession();
      setTimeout(() => provisionAllGroups(sock), 3000);
      if (schedulerInterval) clearInterval(schedulerInterval);
      schedulerInterval = startScheduledLockChecker(sock);
      return;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message;
      console.log('❌ Closed with code:', code);
      console.log('❌ Error message:', errorMsg);

      if (code === 515) {
        console.log('🔄 QR scanned – waiting 5 seconds for save...');
        await delay(5000);
        const saved = await saveSession();
        if (saved) {
          console.log('✅ Session saved, restarting...');
        } else {
          console.log('❌ Save failed, will restart without session');
        }
        setTimeout(startBot, 2000);
        return;
      }

      if (code === 440 || code === DisconnectReason.loggedOut || code === 401) {
        console.log('🚫 Logged out / unauthorized – clearing session');
        await clearSession(); // resets DB and memory
        setTimeout(startBot, 2000);
        return;
      }

      // For other codes, just reconnect
      console.log('🔄 Reconnecting in 5s...');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('creds.update', async () => {
    console.log('🔐 Credentials updated – saving');
    if (sock?.authState?.creds) {
      creds = sock.authState.creds;
    }
    await saveSession();
  });

  // -------- GROUP PARTICIPANTS UPDATE (learn internal ID) --------
  sock.ev.on('group-participants.update', async ({ action, participants, id }) => {
    try {
      if (!id || !participants?.length) return;

      // If the bot itself is added
      if (action === 'add' && participants.includes(sock.user?.id)) {
        console.log('✅ Bot was added to group, learning its internal ID...');
        await delay(3000);
        const meta = await sock.groupMetadata(id);
        const botParticipant = meta.participants.find(p => p.id === sock.user?.id);
        if (botParticipant) {
          botInternalId = botParticipant.id.split('@')[0];
          console.log('🤖 Bot internal ID learned:', botInternalId);
          await ensureGroupSettings(id);
          await ensureGroupScheduledLocks(id);
          // Send a test message to confirm
          await sock.sendMessage(id, { text: '✅ Bot is now active in this group!' });
        }
      }

      // Welcome new members
      const memberJoinActions = ['add', 'invite', 'linked_group_join'];
      if (memberJoinActions.includes(action) && participants?.length > 0) {
        const settings = await getGroupSettings(id);
        if (settings.bot_active) {
          let groupName = 'the group';
          try {
            const meta = await sock.groupMetadata(id);
            groupName = meta.subject || 'the group';
          } catch {}
          scheduleWelcome(sock, id, participants, groupName);
        }
      }

      // Reset strikes when members leave
      if (action === 'remove' || action === 'leave') {
        for (const user of participants) {
          await resetUserStrikes(id, user).catch(() => {});
        }
      }
    } catch (err) {
      console.error('❌ Group update error:', err.message);
    }
  });

  // -------- MESSAGE HANDLER (all commands) --------
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
        text = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          ''
        ).trim();
      } catch { return; }

      if (!text) return;

      const settings = await getGroupSettings(jid);
      const command = text.toLowerCase().trim();
      const isCommand = command.startsWith('.');

      // .bot on/off
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
        if (isCommand && isUserAdmin && command !== '.bot on') {
          await sock.sendMessage(jid, { text: '⚠️ Bot is off. Use `.bot on` to activate.' });
        }
        return;
      }

      // Anti-vulgar
      if (!isUserAdmin && settings.anti_vulgar) {
        const hasVulgar = VULGAR_WORDS.some(w => text.toLowerCase().includes(w));
        if (hasVulgar) {
          await sock.sendMessage(jid, {
            delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
          }).catch(() => {});
          await sock.sendMessage(jid, {
            text: `⚠️ @${sender.split('@')[0]}, vulgar words not allowed`,
            mentions: [sender]
          }).catch(() => {});
          return;
        }
      }

      // Anti-link
      if (!isUserAdmin && settings.anti_link) {
        const linkRegex = /(https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/i;
        if (linkRegex.test(text)) {
          await sock.sendMessage(jid, {
            delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
          }).catch(() => {});
          await handleStrike(sock, jid, sender, 'Links');
          return;
        }
      }

      // Admin commands only
      if (!isCommand || !isUserAdmin) return;

      const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
      const mentioned = ctx.mentionedJid || [];
      const replyTarget = ctx.participant;

      // COMMANDS
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
          await sock.sendMessage(jid, { text: '❌ Invalid time' });
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
          await sock.sendMessage(jid, { text: '❌ Invalid time' });
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
            await sock.sendMessage(jid, {
              text: `❌ @${user.split('@')[0]} not in group`,
              mentions: [user]
            });
            continue;
          }
          const isAdminTarget = metadata.participants.find(p => p.id === user)?.admin;
          if (isAdminTarget) {
            await sock.sendMessage(jid, { text: '❌ Cannot remove admin' });
            continue;
          }
          await sock.groupParticipantsUpdate(jid, [user], 'remove');
          await sock.sendMessage(jid, {
            text: `✅ @${user.split('@')[0]} removed`,
            mentions: [user]
          });
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
            await sock.sendMessage(jid, {
              text: `✅ Strikes cleared`,
              mentions: [user]
            });
          }
        }
      } else if (command === '.tagall') {
        const all = metadata.participants.map(p => p.id);
        const mentionText = all.map(m => `@${m.split('@')[0]}`).join(' ');
        await sock.sendMessage(jid, {
          text: `📢 ${mentionText}`,
          mentions: all
        });
      } else if (command === '.delete') {
        if (!ctx?.stanzaId) {
          await sock.sendMessage(jid, { text: '❌ Reply to message to delete' });
          return;
        }
        await sock.sendMessage(jid, {
          delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }
        });
      } else if (command === '.antilink on') {
        if (await updateGroupSettings(jid, { anti_link: true })) {
          await sock.sendMessage(jid, { text: '🔗 Anti-link enabled' });
        }
      } else if (command === '.antilink off') {
        if (await updateGroupSettings(jid, { anti_link: false })) {
          await sock.sendMessage(jid, { text: '🔗 Anti-link disabled' });
        }
      } else if (command === '.vulgar on') {
        if (await updateGroupSettings(jid, { anti_vulgar: true })) {
          await sock.sendMessage(jid, { text: '🔞 Vulgar filter enabled' });
        }
      } else if (command === '.vulgar off') {
        if (await updateGroupSettings(jid, { anti_vulgar: false })) {
          await sock.sendMessage(jid, { text: '🔞 Vulgar filter disabled' });
        }
      } else if (command === '.help') {
        const sched = await getScheduledLock(jid);
        const lockInfo = sched?.lock_time ? `\n🔒 Lock: ${formatTime24to12(sched.lock_time)}` : '';
        const unlockInfo = sched?.unlock_time ? `\n🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` : '';
        await sock.sendMessage(jid, {
          text: `📋 *COMMANDS*\n\n` +
                `.lock / .lock 9PM / .lock clear\n` +
                `.unlock / .unlock 6AM / .unlock clear\n` +
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
      console.error('❌ Message error:', err.message);
    }
  });
}

// -------- START SERVER --------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  startBot();
});

// -------- GRACEFUL SHUTDOWN --------
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await saveSession();
  if (sock) sock.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await saveSession();
  if (sock) sock.end();
  process.exit(0);
});