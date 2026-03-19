/**
 * ======================================================
 * WhatsApp Bot - Production Grade
 * Version: 1.0.0
 * Baileys: 6.7.2
 * Database: Supabase (PostgreSQL)
 * Timezone: Africa/Lagos (Nigeria)
 * ======================================================
 */

import Baileys from '@whiskeysockets/baileys';
const { 
  default: makeWASocket, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON 
} = Baileys;

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
const spamTracker = new Map();
const commandCooldown = new Map();
const welcomeBuffers = new Map();
const firedThisMinute = new Set();

// Clean up old entries every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  
  for (const [key, value] of spamTracker.entries()) {
    if (value.time < oneHourAgo) spamTracker.delete(key);
  }
  
  for (const [key, time] of commandCooldown.entries()) {
    if (time < oneHourAgo) commandCooldown.delete(key);
  }
  
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

const normalize = str => {
  try {
    return String(str).replace(/\s+/g, "").toLowerCase();
  } catch {
    return "";
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
    if (!groupJid) {
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    
    const { data, error } = await supabase
      .from("group_settings")
      .select("bot_active, anti_link, anti_vulgar")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    if (error) {
      console.error(`getGroupSettings error for ${groupJid}:`, error.message);
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    
    if (!data) {
      // Try to create settings for this group
      await supabase
        .from("group_settings")
        .insert({
          group_jid: groupJid,
          bot_active: true,
          anti_link: true,
          anti_vulgar: true
        })
        .then(() => console.log(`✅ Created settings for ${groupJid}`))
        .catch(err => console.error(`Failed to create settings:`, err.message));
      
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
    
    if (error) {
      console.error(`ensureGroupSettings error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`getStrikes error:`, error.message);
      return 0;
    }
    
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
    
    // Try with last_strike first
    const { error } = await supabase
      .from("group_strikes")
      .upsert({
        group_jid: groupJid,
        user_jid: userJid,
        strikes: newCount,
        last_strike: new Date().toISOString()
      }, { onConflict: 'group_jid,user_jid' });
    
    // If error about last_strike column, try without it
    if (error && error.message.includes('last_strike')) {
      const { error: fallbackError } = await supabase
        .from("group_strikes")
        .upsert({
          group_jid: groupJid,
          user_jid: userJid,
          strikes: newCount
        }, { onConflict: 'group_jid,user_jid' });
      
      if (fallbackError) {
        console.error(`incrementStrike fallback error:`, fallbackError.message);
      }
    } else if (error) {
      console.error(`incrementStrike error:`, error.message);
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
    
    if (error) {
      console.error(`resetUserStrikes error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`getScheduledLock error:`, error.message);
      return null;
    }
    
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
    
    if (error) {
      console.error(`setScheduledLockTime error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`setScheduledUnlockTime error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`clearLockTime error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`clearUnlockTime error:`, error.message);
      return false;
    }
    
    return true;
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
    
    if (error) {
      console.error(`ensureGroupScheduledLocks error:`, error.message);
      return false;
    }
    
    return true;
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
    
    let adminCount = 0;
    let provisionedCount = 0;
    
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p => 
        p.id.split('@')[0] === botNumber || p.id === botJid
      );
      
      if (self && (self.admin === 'admin' || self.admin === 'superadmin')) {
        adminCount++;
        
        const settingsOk = await ensureGroupSettings(groupJid);
        const locksOk = await ensureGroupScheduledLocks(groupJid);
        
        if (settingsOk && locksOk) provisionedCount++;
      }
    }
    
    console.log(`✅ Provisioning complete: ${provisionedCount}/${adminCount} admin groups processed`);
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
      try {
        await sock.sendMessage(jid, {
          text: `⛔ 3/3 ${tag} will now be removed from the group for violating group rules (${reason})`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('Failed to send kick message:', err.message);
      }
      
      try {
        await sock.groupParticipantsUpdate(jid, [sender], 'remove');
        console.log(`✅ Kicked ${sender} (3 strikes)`);
      } catch (err) {
        console.error('Failed to kick user:', err.message);
      }
      
      await resetUserStrikes(jid, sender);
    } else {
      try {
        await sock.sendMessage(jid, {
          text: `⚠️ ${reason} are not allowed in this group. Strike ${strikes}/3`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('Failed to send warning:', err.message);
      }
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
        
        if (members.length === 0 || !sock) return;
        
        const mentionText = members.map(u => `@${u.split('@')[0]}`).join(', ');
        
        await sock.sendMessage(groupJid, {
          text: `👋 Welcome ${mentionText} to *${groupName}!*`,
          mentions: members
        });
        
        console.log(`👋 Welcome sent to ${members.length} new members`);
      } catch (err) {
        console.error('Welcome send error:', err.message);
      }
    }, 5000);
  } catch (err) {
    console.error('scheduleWelcome error:', err.message);
  }
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
      console.log('📱 No existing session found');
      return null;
    }
    
    let authData;
    try {
      authData = JSON.parse(data.auth_data, BufferJSON.reviver);
    } catch (parseErr) {
      console.error('❌ Failed to parse session data:', parseErr.message);
      return null;
    }
    
    if (!authData || !authData.creds) {
      console.error('❌ Invalid session structure');
      return null;
    }
    
    console.log('✅ Valid session loaded');
    return authData;
  } catch (err) {
    console.error('❌ loadSession error:', err.message);
    return null;
  }
}

async function saveSession(snapshot) {
  try {
    if (!snapshot || !snapshot.creds) return false;
    
    const serialized = JSON.stringify(snapshot, BufferJSON.replacer);
    
    if (typeof serialized !== 'string') return false;
    
    const { error } = await supabase
      .from(WA_TABLE)
      .upsert({
        id: SESSION_ID,
        auth_data: serialized,
        updated_at: new Date().toISOString()
      });
    
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
      .update({ 
        auth_data: null, 
        updated_at: new Date().toISOString() 
      })
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
  try {
    const creds = savedSession?.creds || initAuthCreds();
    
    let keyStore = {};
    if (savedSession?.keys) {
      try {
        keyStore = typeof savedSession.keys === 'string'
          ? JSON.parse(savedSession.keys, BufferJSON.reviver)
          : savedSession.keys;
      } catch (err) {
        console.error('Error parsing keys:', err.message);
        keyStore = {};
      }
    }
    
    const keys = {
      get: (type, ids) => {
        try {
          if (!type || !ids || !Array.isArray(ids)) return {};
          
          const data = {};
          for (const id of ids) {
            if (keyStore[type]?.[id] !== undefined) {
              data[id] = keyStore[type][id];
            }
          }
          return data;
        } catch (err) {
          console.error('keys.get error:', err.message);
          return {};
        }
      },
      
      set: (data) => {
        try {
          if (!data) return;
          
          for (const category of Object.keys(data)) {
            keyStore[category] = keyStore[category] || {};
            for (const id of Object.keys(data[category])) {
              const val = data[category][id];
              if (val == null) {
                delete keyStore[category][id];
              } else {
                keyStore[category][id] = val;
              }
            }
          }
          
          const snapshot = { creds, keys: keyStore };
          saveSession(snapshot).catch(err => {
            console.error('Background save failed:', err.message);
          });
        } catch (err) {
          console.error('keys.set error:', err.message);
        }
      }
    };
    
    return { creds, keys };
  } catch (err) {
    console.error('buildAuthState error:', err.message);
    const creds = initAuthCreds();
    const keys = { get: () => ({}), set: () => {} };
    return { creds, keys };
  }
}

// ======================================================
// SCHEDULED LOCK CHECKER
// ======================================================

function startScheduledLockChecker(sock) {
  if (!sock) return;
  
  console.log(`⏰ Starting scheduled lock checker`);
  
  const intervalId = setInterval(async () => {
    try {
      if (!sock || botStatus !== 'connected') return;
      
      const { hh: currentHH, mm: currentMM } = getCurrentTimeInZone();
      const timeKey = `${currentHH}:${currentMM}`;
      
      const { data, error } = await supabase
        .from('group_scheduled_locks')
        .select('group_jid, lock_time, unlock_time');
      
      if (error) {
        console.error('Scheduler: failed to fetch locks:', error.message);
        return;
      }
      
      if (!data || data.length === 0) return;
      
      for (const row of data) {
        if (row.lock_time === timeKey) {
          const lockKey = `lock_${row.group_jid}_${currentHH}_${currentMM}`;
          
          if (!firedThisMinute.has(lockKey)) {
            firedThisMinute.add(lockKey);
            
            try {
              const meta = await sock.groupMetadata(row.group_jid);
              
              if (!meta.announce) {
                await sock.groupSettingUpdate(row.group_jid, 'announcement');
                await sock.sendMessage(row.group_jid, {
                  text: `🔒 Group automatically locked at ${formatTime24to12(row.lock_time)}`
                });
                console.log(`✅ Scheduled lock executed`);
              }
              
              await clearLockTime(row.group_jid);
            } catch (err) {
              console.error(`Scheduler: lock execution failed:`, err.message);
            }
            
            setTimeout(() => firedThisMinute.delete(lockKey), 61000);
          }
        }
        
        if (row.unlock_time === timeKey) {
          const unlockKey = `unlock_${row.group_jid}_${currentHH}_${currentMM}`;
          
          if (!firedThisMinute.has(unlockKey)) {
            firedThisMinute.add(unlockKey);
            
            try {
              const meta = await sock.groupMetadata(row.group_jid);
              
              if (meta.announce) {
                await sock.groupSettingUpdate(row.group_jid, 'not_announcement');
                await sock.sendMessage(row.group_jid, {
                  text: `🔓 Group automatically unlocked at ${formatTime24to12(row.unlock_time)}`
                });
                console.log(`✅ Scheduled unlock executed`);
              }
              
              await clearUnlockTime(row.group_jid);
            } catch (err) {
              console.error(`Scheduler: unlock execution failed:`, err.message);
            }
            
            setTimeout(() => firedThisMinute.delete(unlockKey), 61000);
          }
        }
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  }, 60000);
  
  return intervalId;
}

// ======================================================
// EXPRESS WEB SERVER SETUP
// ======================================================

const app = express();
let currentQR = null;
let botStatus = 'starting';
let sock = null;
let isStarting = false;
let reconnectTimer = null;
let schedulerInterval = null;
let connectionFailures = 0;
const MAX_FAILURES = 3;

// ======================================================
// DATABASE VERIFICATION
// ======================================================

async function verifyTables() {
  try {
    console.log('🔍 Verifying database tables...');
    
    const tables = ['group_settings', 'group_strikes', 'group_scheduled_locks', 'wa_sessions'];
    let allGood = true;
    
    for (const table of tables) {
      const { error } = await supabase
        .from(table)
        .select('count')
        .limit(1);
      
      if (error && error.message.includes('relation') && error.message.includes('does not exist')) {
        console.error(`❌ Table '${table}' does not exist!`);
        allGood = false;
      } else if (error) {
        console.error(`⚠️ Table '${table}' check returned:`, error.message);
      } else {
        console.log(`✅ Table '${table}' exists`);
      }
    }
    
    return allGood;
  } catch (err) {
    console.error('❌ Table verification error:', err.message);
    return false;
  }
}

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {
  console.log(`\n🛑 ${signal} received - shutting down...`);
  
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (schedulerInterval) clearInterval(schedulerInterval);
  
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
      console.log('✅ WhatsApp socket closed');
    } catch (err) {
      console.error('Socket close error:', err.message);
    }
  }
  
  await delay(2000);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

// ======================================================
// WEB ROUTES
// ======================================================

app.get('/', async (req, res) => {
  try {
    let qrImage = null;
    
    if (botStatus === 'connected') {
      qrImage = null;
    } else if (currentQR && currentQR !== 'Loading...') {
      try {
        qrImage = await QRCode.toDataURL(currentQR);
      } catch (qrErr) {
        console.error('QR generation error:', qrErr.message);
      }
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
            min-height: 250px;
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
          .connected-icon {
            font-size: 64px;
          }
          .status {
            margin-top: 15px;
            font-weight: 500;
            padding: 10px;
            border-radius: 5px;
          }
          .status.connected {
            color: #28a745;
            background: #e8f5e9;
          }
          .status.waiting {
            color: #f59e0b;
            background: #fff3e0;
          }
          .status.error {
            color: #dc3545;
            background: #ffebee;
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
            transition: background 0.2s;
          }
          .force-btn:hover {
            background: #b91c1c;
          }
          .info {
            margin-top: 20px;
            font-size: 14px;
            color: #999;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 WhatsApp Bot</h1>
          <p class="subtitle">${botStatus === 'connected' ? 'Bot is online' : 'Scan QR to connect'}</p>
          
          <div class="qr-container" id="qrContainer">
            ${botStatus === 'connected' 
              ? '<div class="connected-icon">✅</div>' 
              : qrImage 
                ? `<img src="${qrImage}" class="qr-image" alt="QR Code">` 
                : '<div class="connected-icon">⏳</div>'
            }
          </div>
          
          <div class="status ${botStatus === 'connected' ? 'connected' : botStatus === 'qr_ready' ? 'waiting' : 'error'}" id="statusText">
            ${botStatus === 'connected' 
              ? '✅ Connected' 
              : botStatus === 'qr_ready' 
                ? '⏳ Scan QR' 
                : botStatus === 'starting'
                  ? '🔄 Starting...'
                  : '❌ Failed'
            }
          </div>
          
          <a href="/force-qr" class="force-btn">🔄 New QR</a>
          <a href="/debug-db" class="force-btn" style="background:#4b5563; margin-left:10px;">🔍 Debug DB</a>
        </div>
        
        <script>
          async function checkStatus() {
            try {
              const res = await fetch('/api/status');
              const data = await res.json();
              
              const qrContainer = document.getElementById('qrContainer');
              const statusText = document.getElementById('statusText');
              
              if (data.connected) {
                qrContainer.innerHTML = '<div class="connected-icon">✅</div>';
                statusText.className = 'status connected';
                statusText.textContent = '✅ Connected';
              } else if (data.qr) {
                qrContainer.innerHTML = '<img src="' + data.qr + '" class="qr-image" alt="QR Code">';
                statusText.className = 'status waiting';
                statusText.textContent = '⏳ Scan QR';
              } else {
                qrContainer.innerHTML = '<div class="connected-icon">⏳</div>';
                statusText.className = 'status waiting';
                statusText.textContent = '⏳ Generating...';
              }
            } catch (err) {}
          }
          
          setInterval(checkStatus, 3000);
          checkStatus();
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Route / error:', err.message);
    res.status(500).send('Server error');
  }
});

app.get('/force-qr', async (req, res) => {
  try {
    console.log('\n🔄 FORCING NEW QR');
    
    await clearSession();
    
    currentQR = null;
    botStatus = 'starting';
    connectionFailures = 0;
    
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
        sock = null;
      } catch (err) {
        console.error('Force QR error:', err.message);
      }
    }
    
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    setTimeout(() => startBot(), 1000);
    
    res.send(`
      <html>
        <head><meta http-equiv="refresh" content="2;url=/"></head>
        <body style="background:#0f172a;color:white;text-align:center;padding:50px">
          <h1>🔄 Generating New QR...</h1>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Force QR error:', err.message);
    res.redirect('/');
  }
});

app.get('/api/status', async (req, res) => {
  try {
    let qrImage = null;
    if (botStatus === 'qr_ready' && currentQR && currentQR !== 'Loading...') {
      try {
        qrImage = await QRCode.toDataURL(currentQR);
      } catch (err) {
        console.error('QR generation error:', err.message);
      }
    }
    
    res.json({
      connected: botStatus === 'connected',
      qr: qrImage,
      status: botStatus
    });
  } catch (err) {
    console.error('API status error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    botStatus,
    uptime: Math.floor(process.uptime())
  });
});

app.get('/debug-db', async (req, res) => {
  const results = {};
  
  const tables = ['group_settings', 'group_strikes', 'group_scheduled_locks', 'wa_sessions'];
  
  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);
      
      results[table] = { 
        exists: !error, 
        error: error?.message,
        hasData: data && data.length > 0
      };
    } catch (err) {
      results[table] = { exists: false, error: err.message };
    }
  }
  
  res.json(results);
});

// ======================================================
// BOT STARTUP
// ======================================================

async function startBot() {
  if (isStarting) {
    console.log('⏳ Already starting...');
    return;
  }
  
  isStarting = true;
  
  try {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 STARTING BOT');
    console.log('='.repeat(50) + '\n');
    
    await verifyTables();
    
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Using version: ${version.join('.')}`);
    
    const savedSession = await loadSession();
    const authState = buildAuthState(savedSession);
    
    currentQR = 'Loading...';
    botStatus = 'starting';
    
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
        sock = null;
      } catch (err) {
        console.error('Cleanup error:', err.message);
      }
    }
    
    sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 1000,
      maxRetries: 3,
      fireInitQueries: true,
      shouldIgnoreJid: (jid) => jid === 'status@broadcast'
    });
    
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, qr, lastDisconnect } = update;
        
        console.log('📡 Update:', { connection: connection || 'none', hasQR: !!qr });
        
        if (qr) {
          console.log('\n✅✅✅ QR READY\n');
          currentQR = qr;
          botStatus = 'qr_ready';
          connectionFailures = 0;
          
          try {
            qrcode.generate(qr, { small: true });
          } catch (qrErr) {
            console.error('QR error:', qrErr.message);
          }
          
          return;
        }
        
        if (connection === 'open') {
          console.log('\n✅✅✅ CONNECTED\n');
          currentQR = null;
          botStatus = 'connected';
          connectionFailures = 0;
          
          try {
            await sock.sendPresenceUpdate('available');
          } catch (err) {
            console.error('Presence error:', err.message);
          }
          
          setTimeout(() => provisionAllGroups(sock), 3000);
          
          if (schedulerInterval) clearInterval(schedulerInterval);
          schedulerInterval = startScheduledLockChecker(sock);
          
          return;
        }
        
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          
          console.log('❌ Closed:', statusCode || 'unknown');
          
          if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚫 Logged out');
            await clearSession();
            connectionFailures = 0;
            botStatus = 'starting';
            setTimeout(() => startBot(), 2000);
            return;
          }
          
          connectionFailures++;
          console.log(`⚠️ Failure #${connectionFailures}`);
          
          if (connectionFailures >= MAX_FAILURES) {
            console.log('🔄 Too many failures, clearing session');
            await clearSession();
            connectionFailures = 0;
            botStatus = 'starting';
            setTimeout(() => startBot(), 2000);
            return;
          }
          
          const delayMs = Math.min(5000 * connectionFailures, 15000);
          console.log(`🔄 Reconnecting in ${delayMs/1000}s`);
          
          botStatus = 'reconnecting';
          setTimeout(() => startBot(), delayMs);
        }
      } catch (err) {
        console.error('Connection handler error:', err.message);
      }
    });
    
    sock.ev.on('creds.update', () => {
      saveSession({ creds: authState.creds, keys: authState.keys }).catch(err => {
        console.error('Background save failed:', err.message);
      });
    });
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message || msg.key.fromMe) return;
        
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || !jid.endsWith('@g.us')) return;
        
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;
        
        let metadata;
        try {
          metadata = await sock.groupMetadata(jid);
          if (!metadata) return;
        } catch (err) {
          console.error('Metadata error:', err.message);
          return;
        }
        
        const isUserAdmin = isAdmin(sender, metadata.participants);
        
        let text = '';
        try {
          text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ''
          ).trim();
        } catch (err) {
          return;
        }
        
        if (!text) return;
        
        const settings = await getGroupSettings(jid);
        const command = text.toLowerCase().trim();
        const isCommand = command.startsWith('.');
        
        // Bot on/off commands
        if (isCommand && isUserAdmin) {
          if (command === '.bot on') {
            const success = await updateGroupSettings(jid, { bot_active: true });
            await sock.sendMessage(jid, { 
              text: success ? '✅ Bot is now active' : '❌ Failed' 
            });
            return;
          }
          
          if (command === '.bot off') {
            const success = await updateGroupSettings(jid, { bot_active: false });
            await sock.sendMessage(jid, { 
              text: success ? '⏸️ Bot is now inactive' : '❌ Failed' 
            });
            return;
          }
        }
        
        if (!settings.bot_active) {
          if (isCommand && isUserAdmin && !['.bot on', '.bot off'].includes(command)) {
            await sock.sendMessage(jid, {
              text: '⚠️ Bot is off. Use `.bot on` to activate.'
            });
          }
          return;
        }
        
        // Anti-vulgar
        if (!isUserAdmin && settings.anti_vulgar) {
          const hasVulgar = VULGAR_WORDS.some(word => 
            text.toLowerCase().includes(word.toLowerCase())
          );
          
          if (hasVulgar) {
            try {
              await sock.sendMessage(jid, {
                delete: { 
                  remoteJid: jid, 
                  fromMe: false, 
                  id: msg.key.id, 
                  participant: sender 
                }
              });
            } catch (err) {}
            
            try {
              await sock.sendMessage(jid, {
                text: `⚠️ @${sender.split('@')[0]}, vulgar words are not allowed.`,
                mentions: [sender]
              });
            } catch (err) {}
            
            return;
          }
        }
        
        // Anti-link
        if (!isUserAdmin && settings.anti_link) {
          const linkRegex = /(https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/i;
          
          if (linkRegex.test(text)) {
            try {
              await sock.sendMessage(jid, {
                delete: { 
                  remoteJid: jid, 
                  fromMe: false, 
                  id: msg.key.id, 
                  participant: sender 
                }
              });
            } catch (err) {}
            
            await handleStrike(sock, jid, sender, 'Links');
            
            return;
          }
        }
        
        if (!isCommand || !isUserAdmin) return;
        
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;
        
        // .lock
        if (command === '.lock') {
          try {
            const meta = await sock.groupMetadata(jid);
            
            if (meta.announce) return;
            
            await sock.groupSettingUpdate(jid, 'announcement');
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: '🔒 Group locked' });
          } catch (err) {
            console.error('.lock error:', err.message);
          }
        }
        
        // .lock clear
        else if (command === '.lock clear') {
          try {
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: '🔓 Lock cleared' });
          } catch (err) {
            console.error('.lock clear error:', err.message);
          }
        }
        
        // .lock [time]
        else if (command.startsWith('.lock ')) {
          const timeArg = text.slice(6).trim();
          const parsed = parseTimeTo24h(timeArg);
          
          if (!parsed) {
            await sock.sendMessage(jid, { 
              text: '❌ Invalid time. Use .lock 9:00PM' 
            });
            return;
          }
          
          try {
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, { 
              text: `🔒 Auto-lock at ${formatTime24to12(parsed)}` 
            });
          } catch (err) {
            console.error('.lock time error:', err.message);
          }
        }
        
        // .unlock
        else if (command === '.unlock') {
          try {
            const meta = await sock.groupMetadata(jid);
            
            if (!meta.announce) return;
            
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: '🔓 Group unlocked' });
          } catch (err) {
            console.error('.unlock error:', err.message);
          }
        }
        
        // .unlock clear
        else if (command === '.unlock clear') {
          try {
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: '🔒 Unlock cleared' });
          } catch (err) {
            console.error('.unlock clear error:', err.message);
          }
        }
        
        // .unlock [time]
        else if (command.startsWith('.unlock ')) {
          const timeArg = text.slice(8).trim();
          const parsed = parseTimeTo24h(timeArg);
          
          if (!parsed) {
            await sock.sendMessage(jid, { 
              text: '❌ Invalid time. Use .unlock 6:00AM' 
            });
            return;
          }
          
          try {
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, { 
              text: `🔓 Auto-unlock at ${formatTime24to12(parsed)}` 
            });
          } catch (err) {
            console.error('.unlock time error:', err.message);
          }
        }
        
        // .kick
        else if (command === '.kick' || command.startsWith('.kick ')) {
          try {
            let targets = [];
            
            if (mentioned.length > 0) {
              targets = mentioned;
            } else if (replyTarget) {
              targets = [replyTarget];
            } else {
              await sock.sendMessage(jid, { 
                text: '❌ Tag or reply to kick' 
              });
              return;
            }
            
            for (const user of targets) {
              const userExists = metadata.participants.some(p => p.id === user);
              
              if (!userExists) {
                await sock.sendMessage(jid, {
                  text: `❌ @${user.split('@')[0]} not in group`,
                  mentions: [user]
                });
                continue;
              }
              
              const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
              
              if (isTargetAdmin) {
                await sock.sendMessage(jid, {
                  text: `❌ Cannot remove admin`,
                  mentions: [user]
                });
                continue;
              }
              
              await sock.groupParticipantsUpdate(jid, [user], 'remove');
              
              await sock.sendMessage(jid, {
                text: `✅ @${user.split('@')[0]} removed`,
                mentions: [user]
              });
              
              await delay(500);
            }
          } catch (err) {
            console.error('.kick error:', err.message);
          }
        }
        
        // .strike reset
        else if (command === '.strike reset' || command.startsWith('.strike reset ')) {
          try {
            let targets = [];
            
            if (mentioned.length > 0) {
              targets = mentioned;
            } else if (replyTarget) {
              targets = [replyTarget];
            } else {
              await sock.sendMessage(jid, { 
                text: '❌ Tag user to reset strikes' 
              });
              return;
            }
            
            for (const user of targets) {
              const success = await resetUserStrikes(jid, user);
              
              await sock.sendMessage(jid, {
                text: success ? `✅ Strikes cleared` : `❌ Failed`,
                mentions: [user]
              });
            }
          } catch (err) {
            console.error('.strike reset error:', err.message);
          }
        }
        
        // .tagall
        else if (command === '.tagall') {
          try {
            const allMembers = metadata.participants.map(p => p.id);
            const mentionText = allMembers.map(m => `@${m.split('@')[0]}`).join(' ');
            
            await sock.sendMessage(jid, {
              text: `📢 ${mentionText}`,
              mentions: allMembers
            });
          } catch (err) {
            console.error('.tagall error:', err.message);
          }
        }
        
        // .delete
        else if (command === '.delete') {
          try {
            if (!ctx?.stanzaId || !ctx?.participant) {
              await sock.sendMessage(jid, { 
                text: '❌ Reply to message to delete' 
              });
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
          } catch (err) {
            console.error('.delete error:', err.message);
          }
        }
        
        // .antilink on/off
        else if (command === '.antilink on') {
          const success = await updateGroupSettings(jid, { anti_link: true });
          await sock.sendMessage(jid, { 
            text: success ? '🔗 Anti-link on' : '❌ Failed' 
          });
        }
        
        else if (command === '.antilink off') {
          const success = await updateGroupSettings(jid, { anti_link: false });
          await sock.sendMessage(jid, { 
            text: success ? '🔗 Anti-link off' : '❌ Failed' 
          });
        }
        
        // .vulgar on/off
        else if (command === '.vulgar on') {
          const success = await updateGroupSettings(jid, { anti_vulgar: true });
          await sock.sendMessage(jid, { 
            text: success ? '🔞 Filter on' : '❌ Failed' 
          });
        }
        
        else if (command === '.vulgar off') {
          const success = await updateGroupSettings(jid, { anti_vulgar: false });
          await sock.sendMessage(jid, { 
            text: success ? '🔞 Filter off' : '❌ Failed' 
          });
        }
        
        // .help
        else if (command === '.help') {
          try {
            const sched = await getScheduledLock(jid);
            const lockInfo = sched?.lock_time 
              ? `\n🔒 Lock: ${formatTime24to12(sched.lock_time)}` 
              : '';
            const unlockInfo = sched?.unlock_time 
              ? `\n🔓 Unlock: ${formatTime24to12(sched.unlock_time)}` 
              : '';
            
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
              '`.delete` - Delete message',
              '`.strike reset @user` - Clear strikes',
              '`.antilink on/off` - Link protection',
              '`.vulgar on/off` - Word filter',
              '`.bot on/off` - Toggle bot',
              '',
              `Bot: ${settings.bot_active ? '✅' : '⏸️'}`,
              `Anti-link: ${settings.anti_link ? '✅' : '❌'}`,
              `Anti-vulgar: ${settings.anti_vulgar ? '✅' : '❌'}`,
              lockInfo,
              unlockInfo
            ].filter(l => l !== '');
            
            await sock.sendMessage(jid, { text: helpText.join('\n') });
          } catch (err) {
            console.error('.help error:', err.message);
          }
        }
      } catch (err) {
        console.error('Message handler error:', err.message);
      }
    });
    
    sock.ev.on('group-participants.update', async (update) => {
      try {
        const { action, participants, id: groupJid } = update;
        
        if (!groupJid || !participants || participants.length === 0) return;
        
        const joinActions = ['add', 'invite', 'linked_group_join'];
        
        if (joinActions.includes(action)) {
          const settings = await getGroupSettings(groupJid);
          
          if (settings.bot_active) {
            let groupName = 'the group';
            try {
              const meta = await sock.groupMetadata(groupJid);
              groupName = meta.subject || 'the group';
            } catch (err) {}
            
            scheduleWelcome(sock, groupJid, participants, groupName);
          }
        }
        
        if (action === 'remove' || action === 'leave') {
          for (const user of participants) {
            await resetUserStrikes(groupJid, user);
          }
        }
      } catch (err) {
        console.error('Group update error:', err.message);
      }
    });
    
  } catch (err) {
    console.error('❌ startBot error:', err.message);
    botStatus = 'failed';
    setTimeout(() => startBot(), 10000);
  } finally {
    isStarting = false;
  }
}

// ======================================================
// START SERVER
// ======================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Server on http://localhost:${PORT}`);
  console.log(`📱 Open URL to see QR\n`);
  startBot();
});

server.on('error', (err) => {
  console.error('Server error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} in use`);
    process.exit(1);
  }
});
