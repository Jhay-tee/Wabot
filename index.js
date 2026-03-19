/**
 * ======================================================
 * WhatsApp Bot - Production Grade
 * Version: 1.0.0
 * Baileys: 6.7.2
 * Database: Supabase (PostgreSQL)
 * Timezone: Africa/Lagos (Nigeria)
 * ======================================================
 * 
 * This bot implements:
 * - QR code authentication with web interface
 * - Session persistence in Supabase
 * - Group management commands (.lock, .unlock, .kick, .tagall, .delete)
 * - Scheduled lock/unlock with Lagos timezone
 * - Anti-link protection with 3-strike system
 * - Anti-vulgar word filter
 * - Welcome messages for new members
 * - Bot on/off toggle per group
 * - Proper error handling with meaningful logs
 * - Correct connection flow (handshake BEFORE save)
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
  console.error('Please add them to your .env file or Render dashboard');
  process.exit(1);
}

// ======================================================
// CONFIGURATION
// ======================================================
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;  // Single session bot, always use ID 1
const WA_TABLE = "wa_sessions";
const BOT_TIMEZONE = "Africa/Lagos";  // Nigeria timezone

// Vulgar words list (expand as needed)
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
        // Set timeout to prevent hanging requests
        return fetch(url, { 
          ...options, 
          signal: AbortSignal.timeout(10000) // 10 second timeout
        }).catch(err => {
          console.error('📡 Supabase fetch error:', err.message);
          throw err;
        });
      }
    }
  }
);

// ======================================================
// IN-MEMORY STORAGE (for active data)
// ======================================================
const spamTracker = new Map();        // Track message spam
const commandCooldown = new Map();    // Prevent command spam
const welcomeBuffers = new Map();     // Batch welcome messages
const firedThisMinute = new Set();    // Prevent duplicate scheduled actions

// Clean up old entries every hour to prevent memory leaks
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  
  // Clean spam tracker
  for (const [key, value] of spamTracker.entries()) {
    if (value.time < oneHourAgo) spamTracker.delete(key);
  }
  
  // Clean command cooldown
  for (const [key, time] of commandCooldown.entries()) {
    if (time < oneHourAgo) commandCooldown.delete(key);
  }
  
  // Clean fired minutes (keep only last hour)
  for (const key of firedThisMinute) {
    const timestamp = parseInt(key.split('_').pop() || '0');
    if (timestamp < oneHourAgo) firedThisMinute.delete(key);
  }
}, 3600000);

// ======================================================
// HELPER FUNCTIONS
// ======================================================

/**
 * Delay execution (Promise-based sleep)
 */
const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Check if a user is an admin in a group
 */
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

/**
 * Normalize text for comparison (remove spaces, lowercase)
 */
const normalize = str => {
  try {
    return String(str).replace(/\s+/g, "").toLowerCase();
  } catch {
    return "";
  }
};

/**
 * Get current time in Lagos/Nigeria timezone
 * Returns { hh, mm } in 24-hour format
 */
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
    
    // Validate numbers
    if (isNaN(hh) || isNaN(mm)) throw new Error('Invalid time format');
    
    return { hh, mm };
  } catch (err) {
    console.error('Timezone error:', err.message, '- using UTC fallback');
    const now = new Date();
    return { hh: now.getHours(), mm: now.getMinutes() };
  }
}

/**
 * Parse time string like "9:00PM", "10AM", "8:30PM" to 24-hour format "HH:MM"
 * Returns null if invalid
 */
function parseTimeTo24h(timeStr) {
  try {
    const cleaned = String(timeStr).trim().toUpperCase().replace(/\s+/g, '');
    
    // Pattern: 9PM, 9:00PM, 10AM, 10:30AM
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
    if (!match) return null;
    
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const period = match[3];
    
    // Validate ranges
    if (hours < 1 || hours > 12) return null;
    if (minutes < 0 || minutes > 59) return null;
    
    // Convert to 24-hour
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch (err) {
    console.error('parseTimeTo24h error:', err.message);
    return null;
  }
}

/**
 * Format 24-hour time "HH:MM" to 12-hour format like "9:00 PM"
 */
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

/**
 * Get settings for a specific group
 * Returns defaults if not found
 */
async function getGroupSettings(groupJid) {
  try {
    if (!groupJid) {
      throw new Error('groupJid is required');
    }
    
    const { data, error } = await supabase
      .from("group_settings")
      .select("bot_active, anti_link, anti_vulgar")
      .eq("group_jid", groupJid)
      .maybeSingle();
    
    if (error) {
      console.error(`getGroupSettings error for ${groupJid}:`, error.message);
      // Return defaults on error
      return { bot_active: true, anti_link: true, anti_vulgar: true };
    }
    
    // Return data or defaults
    return {
      bot_active: data?.bot_active ?? true,
      anti_link: data?.anti_link ?? true,
      anti_vulgar: data?.anti_vulgar ?? true
    };
  } catch (err) {
    console.error(`getGroupSettings exception for ${groupJid}:`, err.message);
    return { bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

/**
 * Update settings for a specific group
 */
async function updateGroupSettings(groupJid, updates) {
  try {
    if (!groupJid) {
      throw new Error('groupJid is required');
    }
    
    if (!updates || typeof updates !== 'object') {
      throw new Error('updates must be an object');
    }
    
    const { error } = await supabase
      .from("group_settings")
      .upsert({
        group_jid: groupJid,
        ...updates
      }, { onConflict: 'group_jid' });
    
    if (error) {
      console.error(`updateGroupSettings error for ${groupJid}:`, error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`updateGroupSettings exception for ${groupJid}:`, err.message);
    return false;
  }
}

/**
 * Ensure a group has settings (create if missing)
 */
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
      console.error(`ensureGroupSettings error for ${groupJid}:`, error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`ensureGroupSettings exception for ${groupJid}:`, err.message);
    return false;
  }
}

// ======================================================
// DATABASE FUNCTIONS - STRIKES
// ======================================================

/**
 * Get strike count for a user in a group
 */
async function getStrikes(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) {
      throw new Error('groupJid and userJid are required');
    }
    
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

/**
 * Increment strike count for a user
 */
async function incrementStrike(groupJid, userJid) {
  try {
    if (!groupJid || !userJid) {
      throw new Error('groupJid and userJid are required');
    }
    
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
    
    if (error) {
      console.error(`incrementStrike error:`, error.message);
      return current; // Return old count on error
    }
    
    return newCount;
  } catch (err) {
    console.error(`incrementStrike exception:`, err.message);
    return 0;
  }
}

/**
 * Reset strikes for a user
 */
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

/**
 * Get scheduled lock/unlock times for a group
 */
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

/**
 * Set scheduled lock time for a group
 */
async function setScheduledLockTime(groupJid, lockTime) {
  try {
    if (!groupJid) return false;
    
    // Get current to preserve unlock_time
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

/**
 * Set scheduled unlock time for a group
 */
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

/**
 * Clear scheduled lock time for a group
 */
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

/**
 * Clear scheduled unlock time for a group
 */
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

/**
 * Ensure a group has a scheduled locks entry
 */
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

/**
 * When bot connects, ensure all groups it's admin in have settings
 */
async function provisionAllGroups(sock) {
  try {
    if (!sock) {
      console.error('provisionAllGroups: sock is null');
      return;
    }
    
    console.log('🔍 Checking all groups for provisioning...');
    
    // Get all groups bot is in
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    
    if (!botJid) {
      console.error('provisionAllGroups: botJid is null');
      return;
    }
    
    const botNumber = botJid.split(':')[0]?.split('@')[0];
    if (!botNumber) {
      console.error('provisionAllGroups: could not extract bot number');
      return;
    }
    
    let adminCount = 0;
    let provisionedCount = 0;
    
    for (const [groupJid, meta] of Object.entries(groups)) {
      // Check if bot is admin in this group
      const self = meta.participants?.find(p => 
        p.id.split('@')[0] === botNumber || p.id === botJid
      );
      
      if (self && (self.admin === 'admin' || self.admin === 'superadmin')) {
        adminCount++;
        
        // Ensure both tables have entries for this group
        const settingsOk = await ensureGroupSettings(groupJid);
        const locksOk = await ensureGroupScheduledLocks(groupJid);
        
        if (settingsOk && locksOk) {
          provisionedCount++;
        }
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

/**
 * Handle a strike for a user
 * - Increment strike count
 * - Send warning or kick based on count
 */
async function handleStrike(sock, jid, sender, reason) {
  try {
    if (!sock || !jid || !sender) {
      console.error('handleStrike: missing required parameters');
      return;
    }
    
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split('@')[0]}`;
    
    if (strikes >= 3) {
      // Strike 3 - kick user
      try {
        await sock.sendMessage(jid, {
          text: `⛔ 3/3 ${tag} will now be removed from the group for violating group rules (${reason})`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('handleStrike: failed to send kick message:', err.message);
      }
      
      // Kick the user
      try {
        await sock.groupParticipantsUpdate(jid, [sender], 'remove');
        console.log(`✅ Kicked ${sender} from ${jid} (3 strikes)`);
      } catch (err) {
        console.error('handleStrike: failed to kick user:', err.message);
      }
      
      // Reset their strikes
      await resetUserStrikes(jid, sender);
    } else {
      // Strike 1 or 2 - send warning
      try {
        await sock.sendMessage(jid, {
          text: `⚠️ ${reason} are not allowed in this group. Strike ${strikes}/3`,
          mentions: [sender]
        });
      } catch (err) {
        console.error('handleStrike: failed to send warning:', err.message);
      }
    }
  } catch (err) {
    console.error('handleStrike error:', err.message);
  }
}

// ======================================================
// WELCOME MESSAGE HANDLER (Batched)
// ======================================================

/**
 * Schedule a welcome message for new members
 * Batches multiple joins within 5 seconds into one message
 */
function scheduleWelcome(sock, groupJid, participants, groupName) {
  try {
    if (!sock || !groupJid || !participants || participants.length === 0) return;
    
    // Extract valid participant JIDs
    const validParticipants = participants
      .map(p => typeof p === 'string' ? p : p?.id)
      .filter(Boolean);
    
    if (validParticipants.length === 0) return;
    
    // Initialize buffer for this group if needed
    if (!welcomeBuffers.has(groupJid)) {
      welcomeBuffers.set(groupJid, { participants: [] });
    }
    
    const buffer = welcomeBuffers.get(groupJid);
    buffer.participants.push(...validParticipants);
    
    // Clear existing timer
    if (buffer.timer) clearTimeout(buffer.timer);
    
    // Set new timer
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
        
        console.log(`👋 Welcome sent to ${members.length} new members in ${groupName}`);
      } catch (err) {
        console.error('scheduleWelcome send error:', err.message);
      }
    }, 5000); // 5 second batch window
    
  } catch (err) {
    console.error('scheduleWelcome error:', err.message);
  }
}

// ======================================================
// AUTH STATE MANAGEMENT - FIXED VERSION
// ======================================================

/**
 * ======================================================
 * AUTH STATE HANDLING - CRITICAL SECTION
 * ======================================================
 * 
 * The auth state consists of two parts:
 * 1. creds - Identity credentials (me, keys, signed keys)
 * 2. keys - Signal protocol keys for encryption
 * 
 * These must be stored together and handled with BufferJSON
 * to preserve binary data.
 * 
 * CORRECT USAGE:
 * - Saving: JSON.stringify(obj, BufferJSON.replacer) → STRING
 * - Loading: JSON.parse(string, BufferJSON.reviver) → OBJECT
 * - NEVER double-parse (JSON.parse(JSON.stringify(...))) - this corrupts data
 */

/**
 * Load session from Supabase
 * Returns auth state object or null if not found/corrupted
 */
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
      console.log('📱 No existing session found - will generate QR');
      return null;
    }
    
    console.log('📦 Session data retrieved from Supabase');
    
    // CORRECT: auth_data is a string, parse it with BufferJSON.reviver
    let authData;
    try {
      authData = JSON.parse(data.auth_data, BufferJSON.reviver);
    } catch (parseErr) {
      console.error('❌ Failed to parse session data:', parseErr.message);
      return null;
    }
    
    // Validate that we have the required structure
    if (!authData || !authData.creds) {
      console.error('❌ Invalid session structure - missing creds');
      return null;
    }
    
    // Check if session appears valid (has required fields)
    const hasRequired = !!(
      authData.creds.me &&
      authData.creds.noiseKey &&
      authData.creds.signedIdentityKey &&
      authData.creds.signedPreKey &&
      authData.creds.advSecretKey
    );
    
    if (!hasRequired) {
      console.error('❌ Session missing required credential fields');
      return null;
    }
    
    console.log('✅ Valid session loaded from Supabase');
    console.log('📱 Connected as:', authData.creds.me?.name || authData.creds.me?.jid || 'Unknown');
    
    return authData;
  } catch (err) {
    console.error('❌ loadSession error:', err.message);
    return null;
  }
}

/**
 * Save session to Supabase - FIXED VERSION
 * Uses BufferJSON to handle binary data correctly
 */
async function saveSession(snapshot) {
  try {
    if (!snapshot || !snapshot.creds) {
      console.error('❌ saveSession: invalid snapshot');
      return false;
    }
    
    console.log('💾 Saving session to Supabase...');
    
    // CORRECT: Use BufferJSON.replacer directly in JSON.stringify
    // This produces a STRING that Supabase can store in JSONB column
    const serialized = JSON.stringify(snapshot, BufferJSON.replacer);
    
    // Verify serialized is a string
    if (typeof serialized !== 'string') {
      console.error('❌ saveSession: serialized data is not a string');
      return false;
    }
    
    const { error } = await supabase
      .from(WA_TABLE)
      .upsert({
        id: SESSION_ID,
        auth_data: serialized,  // This is now a string, exactly what Supabase expects
        updated_at: new Date().toISOString()
      });
    
    if (error) {
      console.error('❌ saveSession error:', error.message);
      return false;
    }
    
    console.log('✅ Session saved successfully');
    return true;
  } catch (err) {
    console.error('❌ saveSession exception:', err.message);
    return false;
  }
}

/**
 * Clear session from Supabase
 */
async function clearSession() {
  try {
    console.log('🗑️ Clearing session from Supabase...');
    
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

/**
 * Build auth state object for Baileys
 * Creates the { creds, keys } structure expected by makeWASocket
 */
function buildAuthState(savedSession) {
  try {
    // If we have a saved session, use its creds and keys
    // Otherwise, initialize fresh credentials
    const creds = savedSession?.creds || initAuthCreds();
    
    // Initialize keys store from saved session or empty
    let keyStore = {};
    if (savedSession?.keys) {
      // Handle both object and string formats
      try {
        keyStore = typeof savedSession.keys === 'string'
          ? JSON.parse(savedSession.keys, BufferJSON.reviver)
          : savedSession.keys;
      } catch (err) {
        console.error('buildAuthState: error parsing keys:', err.message);
        keyStore = {};
      }
    }
    
    // Create the keys interface required by Baileys
    const keys = {
      /**
       * Get keys by type and IDs
       */
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
      
      /**
       * Set keys - this is called by Baileys when keys are updated
       * We save the session whenever keys change
       */
      set: (data) => {
        try {
          if (!data) return;
          
          // Update keyStore with new data
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
          
          // Schedule a save when keys are updated
          // This happens after handshake is complete
          const snapshot = { creds, keys: keyStore };
          saveSession(snapshot).catch(err => {
            console.error('keys.set: background save failed:', err.message);
          });
        } catch (err) {
          console.error('keys.set error:', err.message);
        }
      }
    };
    
    return { creds, keys };
  } catch (err) {
    console.error('buildAuthState error:', err.message);
    // Return fresh credentials as fallback
    const creds = initAuthCreds();
    const keys = { get: () => ({}), set: () => {} };
    return { creds, keys };
  }
}

// ======================================================
// SCHEDULED LOCK CHECKER
// ======================================================

/**
 * Starts a background process that checks every minute
 * for scheduled locks/unlocks and executes them
 */
function startScheduledLockChecker(sock) {
  if (!sock) {
    console.error('startScheduledLockChecker: sock is required');
    return;
  }
  
  console.log(`⏰ Starting scheduled lock checker (timezone: ${BOT_TIMEZONE})`);
  
  const intervalId = setInterval(async () => {
    try {
      // Only check if connected
      if (!sock || botStatus !== 'connected') return;
      
      const { hh: currentHH, mm: currentMM } = getCurrentTimeInZone();
      const now = new Date();
      const timeKey = `${currentHH}:${currentMM}`;
      
      // Fetch all scheduled locks
      const { data, error } = await supabase
        .from('group_scheduled_locks')
        .select('group_jid, lock_time, unlock_time');
      
      if (error) {
        console.error('Scheduler: failed to fetch locks:', error.message);
        return;
      }
      
      if (!data || data.length === 0) return;
      
      for (const row of data) {
        // Check lock time
        if (row.lock_time === timeKey) {
          const lockKey = `lock_${row.group_jid}_${currentHH}_${currentMM}`;
          
          // Prevent duplicate execution
          if (!firedThisMinute.has(lockKey)) {
            firedThisMinute.add(lockKey);
            
            try {
              // Check current group state
              const meta = await sock.groupMetadata(row.group_jid);
              
              if (!meta.announce) {
                await sock.groupSettingUpdate(row.group_jid, 'announcement');
                await sock.sendMessage(row.group_jid, {
                  text: `🔒 Group automatically locked at ${formatTime24to12(row.lock_time)}`
                });
                console.log(`✅ Scheduled lock executed for ${row.group_jid}`);
              }
              
              // Clear the lock time after execution (one-time use)
              await clearLockTime(row.group_jid);
              
            } catch (err) {
              console.error(`Scheduler: lock execution failed for ${row.group_jid}:`, err.message);
            }
            
            // Remove from set after a minute
            setTimeout(() => firedThisMinute.delete(lockKey), 61000);
          }
        }
        
        // Check unlock time
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
                console.log(`✅ Scheduled unlock executed for ${row.group_jid}`);
              }
              
              await clearUnlockTime(row.group_jid);
              
            } catch (err) {
              console.error(`Scheduler: unlock execution failed for ${row.group_jid}:`, err.message);
            }
            
            setTimeout(() => firedThisMinute.delete(unlockKey), 61000);
          }
        }
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  }, 60000); // Check every minute
  
  return intervalId;
}

// ======================================================
// EXPRESS WEB SERVER SETUP
// ======================================================

const app = express();
let currentQR = null;
let botStatus = 'starting'; // starting, qr_ready, connected, reconnecting, failed
let sock = null;
let isStarting = false;
let reconnectTimer = null;
let schedulerInterval = null;
let connectionFailures = 0;
const MAX_FAILURES = 3;

/**
 * Graceful shutdown handler
 */
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} received - shutting down gracefully...`);
  
  // Clear timers
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (schedulerInterval) clearInterval(schedulerInterval);
  
  // Close socket
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
      console.log('✅ WhatsApp socket closed');
    } catch (err) {
      console.error('Socket close error:', err.message);
    }
  }
  
  // Give time for final saves
  await delay(2000);
  
  console.log('👋 Goodbye!');
  process.exit(0);
}

// Handle termination signals
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors (but don't crash)
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

/**
 * Main page - displays QR or connected status
 */
app.get('/', async (req, res) => {
  try {
    let qrImage = null;
    
    if (botStatus === 'connected') {
      // Connected - show checkmark
      qrImage = null;
    } else if (currentQR && currentQR !== 'Loading...') {
      // Generate QR image for web display
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
          <p class="subtitle">${botStatus === 'connected' ? 'Bot is online and monitoring your groups' : 'Scan the QR code to connect your WhatsApp'}</p>
          
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
              ? '✅ Connected to WhatsApp' 
              : botStatus === 'qr_ready' 
                ? '⏳ Scan the QR code with WhatsApp' 
                : botStatus === 'starting'
                  ? '🔄 Starting up...'
                  : '❌ Connection failed - try force QR'
            }
          </div>
          
          <a href="/force-qr" class="force-btn">🔄 Force New QR Code</a>
          
          <div class="info" id="timeInfo"></div>
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
                statusText.textContent = '✅ Connected to WhatsApp';
              } else if (data.qr) {
                qrContainer.innerHTML = '<img src="' + data.qr + '" class="qr-image" alt="QR Code">';
                statusText.className = 'status waiting';
                statusText.textContent = '⏳ Scan the QR code with WhatsApp';
              } else {
                qrContainer.innerHTML = '<div class="connected-icon">⏳</div>';
                statusText.className = 'status waiting';
                statusText.textContent = '⏳ Generating QR code...';
              }
              
              document.getElementById('timeInfo').textContent = 'Lagos Time: ' + data.currentTime;
            } catch (err) {
              console.error('Status check failed:', err);
            }
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

/**
 * Force new QR code endpoint
 */
app.get('/force-qr', async (req, res) => {
  try {
    console.log('\n🔄 FORCING NEW QR CODE');
    
    // Clear session from database
    await clearSession();
    
    // Reset state
    currentQR = null;
    botStatus = 'starting';
    connectionFailures = 0;
    
    // Close existing socket
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
        sock = null;
      } catch (err) {
        console.error('Force QR: socket close error:', err.message);
      }
    }
    
    // Clear any pending reconnect
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    // Restart bot
    setTimeout(() => startBot(), 1000);
    
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="2;url=/">
          <style>
            body { background: #0f172a; color: white; font-family: system-ui; text-align: center; padding: 50px; }
            h1 { color: #fbbf24; }
          </style>
        </head>
        <body>
          <h1>🔄 Generating New QR Code...</h1>
          <p>Redirecting in 2 seconds...</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Force QR error:', err.message);
    res.redirect('/');
  }
});

/**
 * API endpoint for QR status
 */
app.get('/api/status', async (req, res) => {
  try {
    const now = new Date();
    const lagosTime = now.toLocaleString('en-US', { 
      timeZone: BOT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    
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
      status: botStatus,
      currentTime: lagosTime
    });
  } catch (err) {
    console.error('API status error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Health check endpoint for Render
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    botStatus,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ======================================================
// BOT STARTUP FUNCTION
// ======================================================

/**
 * Main bot startup function
 * Handles loading session, creating socket, and setting up event handlers
 */
async function startBot() {
  // Prevent multiple simultaneous starts
  if (isStarting) {
    console.log('⏳ Bot already starting, skipping...');
    return;
  }
  
  isStarting = true;
  
  try {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 STARTING BOT');
    console.log('='.repeat(50) + '\n');
    
    // Get latest Baileys version
    console.log('📱 Fetching latest Baileys version...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`✅ Using version: ${version.join('.')}${isLatest ? ' (latest)' : ''}`);
    
    // Load session from Supabase
    const savedSession = await loadSession();
    
    // Build auth state from saved session or fresh
    console.log('🔧 Building auth state...');
    const authState = buildAuthState(savedSession);
    
    // Reset QR state
    currentQR = 'Loading...';
    botStatus = 'starting';
    
    // Clean up any existing socket
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
        sock = null;
      } catch (err) {
        console.error('Cleanup error:', err.message);
      }
    }
    
    // Create new socket
    console.log('🔌 Creating WhatsApp socket...');
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
    
    console.log('✅ Socket created');
    
    // ======================================================
    // EVENT: Connection Update
    // ======================================================
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, qr, lastDisconnect } = update;
        
        console.log('📡 Connection update:', { 
          connection: connection || 'none', 
          hasQR: !!qr,
          timestamp: new Date().toISOString()
        });
        
        // ===== QR CODE GENERATED =====
        if (qr) {
          console.log('\n' + '✅'.repeat(10));
          console.log('✅✅✅ QR CODE READY');
          console.log('✅'.repeat(10) + '\n');
          
          currentQR = qr;
          botStatus = 'qr_ready';
          connectionFailures = 0;
          
          // Generate QR in terminal
          try {
            qrcode.generate(qr, { small: true });
            console.log('\n📱 Scan the QR code above with WhatsApp\n');
          } catch (qrErr) {
            console.error('Terminal QR error:', qrErr.message);
          }
          
          return; // CRITICAL: Stop processing
        }
        
        // ===== CONNECTION OPENED =====
        if (connection === 'open') {
          console.log('\n' + '✅'.repeat(10));
          console.log('✅✅✅ CONNECTED TO WHATSAPP');
          console.log('✅'.repeat(10) + '\n');
          
          currentQR = null;
          botStatus = 'connected';
          connectionFailures = 0;
          
          // Set online presence
          try {
            await sock.sendPresenceUpdate('available');
          } catch (err) {
            console.error('Failed to set presence:', err.message);
          }
          
          // Provision all groups (non-critical, run in background)
          setTimeout(() => provisionAllGroups(sock), 3000);
          
          // Start scheduled lock checker
          if (schedulerInterval) clearInterval(schedulerInterval);
          schedulerInterval = startScheduledLockChecker(sock);
          
          return;
        }
        
        // ===== CONNECTION CLOSED =====
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMessage = lastDisconnect?.error?.message;
          
          console.log('❌ Connection closed');
          console.log('   Code:', statusCode || 'unknown');
          console.log('   Error:', errorMessage || 'none');
          
          // Check if logged out
          if (statusCode === DisconnectReason.loggedOut) {
            console.log('🚫 Device logged out - clearing session');
            await clearSession();
            connectionFailures = 0;
            botStatus = 'starting';
            
            // Restart after a short delay
            setTimeout(() => startBot(), 2000);
            return;
          }
          
          // Count failures
          connectionFailures++;
          console.log(`⚠️ Connection failure #${connectionFailures} of ${MAX_FAILURES}`);
          
          // If too many failures, clear session and start fresh
          if (connectionFailures >= MAX_FAILURES) {
            console.log('🔄 Too many failures - session may be corrupted');
            console.log('🗑️ Clearing session and starting fresh');
            await clearSession();
            connectionFailures = 0;
            botStatus = 'starting';
            setTimeout(() => startBot(), 2000);
            return;
          }
          
          // Otherwise, reconnect with exponential backoff
          const delayMs = Math.min(5000 * connectionFailures, 15000);
          console.log(`🔄 Reconnecting in ${delayMs/1000}s...`);
          
          botStatus = 'reconnecting';
          setTimeout(() => startBot(), delayMs);
        }
      } catch (err) {
        console.error('connection.update handler error:', err.message);
      }
    });
    
    // ======================================================
    // EVENT: Credentials Update
    // ======================================================
    // This fires when the handshake completes and keys are ready
    // This is the RIGHT time to save - after full authentication
    sock.ev.on('creds.update', () => {
      console.log('🔐 Credentials updated - handshake complete');
      
      // Get the current auth state and save
      // Note: We don't await this - let it run in background
      saveSession({ 
        creds: authState.creds, 
        keys: authState.keys 
      }).catch(err => {
        console.error('Background session save failed:', err.message);
      });
    });
    
    // ======================================================
    // EVENT: Messages Upsert
    // ======================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        // Process only the first message in batch
        const msg = messages?.[0];
        if (!msg?.message || msg.key.fromMe) return;
        
        // Extract message metadata
        const jid = msg.key.remoteJid;
        
        // Ignore status broadcasts and non-group messages
        if (!jid || jid === 'status@broadcast' || !jid.endsWith('@g.us')) return;
        
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;
        
        // Get group metadata
        let metadata;
        try {
          metadata = await sock.groupMetadata(jid);
          if (!metadata) return;
        } catch (err) {
          console.error('Failed to get group metadata:', err.message);
          return;
        }
        
        // Check if sender is admin
        const isUserAdmin = isAdmin(sender, metadata.participants);
        
        // Extract message text
        let text = '';
        try {
          text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ''
          ).trim();
        } catch (err) {
          console.error('Text extraction error:', err.message);
          return;
        }
        
        if (!text) return;
        
        // Get group settings
        const settings = await getGroupSettings(jid);
        const command = text.toLowerCase().trim();
        const isCommand = command.startsWith('.');
        
        // ====================================================
        // BOT ON/OFF COMMANDS (work even when bot is off)
        // ====================================================
        if (isCommand && isUserAdmin) {
          if (command === '.bot on') {
            const success = await updateGroupSettings(jid, { bot_active: true });
            await sock.sendMessage(jid, { 
              text: success ? '✅ Bot is now active' : '❌ Failed to activate bot' 
            });
            return;
          }
          
          if (command === '.bot off') {
            const success = await updateGroupSettings(jid, { bot_active: false });
            await sock.sendMessage(jid, { 
              text: success ? '⏸️ Bot is now inactive' : '❌ Failed to deactivate bot' 
            });
            return;
          }
        }
        
        // ====================================================
        // HANDLE BOT INACTIVE STATE
        // ====================================================
        if (!settings.bot_active) {
          // If bot is off and admin sends a command, remind them
          if (isCommand && isUserAdmin && !['.bot on', '.bot off'].includes(command)) {
            await sock.sendMessage(jid, {
              text: '⚠️ Bot automation is currently off. Please use `.bot on` to activate it.'
            });
          }
          return; // Ignore all other messages when bot is off
        }
        
        // ====================================================
        // ANTI-VULGAR FILTER (non-admins only)
        // ====================================================
        if (!isUserAdmin && settings.anti_vulgar) {
          const hasVulgar = VULGAR_WORDS.some(word => 
            text.toLowerCase().includes(word.toLowerCase())
          );
          
          if (hasVulgar) {
            // Delete the message
            try {
              await sock.sendMessage(jid, {
                delete: { 
                  remoteJid: jid, 
                  fromMe: false, 
                  id: msg.key.id, 
                  participant: sender 
                }
              });
            } catch (err) {
              console.error('Failed to delete vulgar message:', err.message);
            }
            
            // Send warning (no strikes)
            try {
              await sock.sendMessage(jid, {
                text: `⚠️ @${sender.split('@')[0]}, vulgar words like that are not allowed in this group.`,
                mentions: [sender]
              });
            } catch (err) {
              console.error('Failed to send vulgar warning:', err.message);
            }
            
            return;
          }
        }
        
        // ====================================================
        // ANTI-LINK PROTECTION (non-admins only)
        // ====================================================
        if (!isUserAdmin && settings.anti_link) {
          const linkRegex = /(https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+)/i;
          
          if (linkRegex.test(text)) {
            // Delete the message
            try {
              await sock.sendMessage(jid, {
                delete: { 
                  remoteJid: jid, 
                  fromMe: false, 
                  id: msg.key.id, 
                  participant: sender 
                }
              });
            } catch (err) {
              console.error('Failed to delete link message:', err.message);
            }
            
            // Handle strike
            await handleStrike(sock, jid, sender, 'Links');
            
            return;
          }
        }
        
        // ====================================================
        // ADMIN COMMANDS ONLY (beyond this point)
        // ====================================================
        if (!isCommand || !isUserAdmin) return;
        
        // Extract context info for quoted messages
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;
        
        // ====================================================
        // COMMAND: .lock
        // ====================================================
        if (command === '.lock') {
          try {
            const meta = await sock.groupMetadata(jid);
            
            if (meta.announce) {
              // Already locked - silent ignore
              return;
            }
            
            await sock.groupSettingUpdate(jid, 'announcement');
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: '🔒 Group locked' });
            console.log(`🔒 Group ${jid} locked by admin`);
          } catch (err) {
            console.error('.lock error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to lock group' });
          }
        }
        
        // ====================================================
        // COMMAND: .lock clear
        // ====================================================
        else if (command === '.lock clear') {
          try {
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: '🔓 Scheduled lock cleared' });
          } catch (err) {
            console.error('.lock clear error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to clear lock' });
          }
        }
        
        // ====================================================
        // COMMAND: .lock [time]
        // ====================================================
        else if (command.startsWith('.lock ')) {
          const timeArg = text.slice(6).trim();
          const parsed = parseTimeTo24h(timeArg);
          
          if (!parsed) {
            await sock.sendMessage(jid, { 
              text: '❌ Invalid time format. Use: .lock 9:00PM or .lock 10AM' 
            });
            return;
          }
          
          try {
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, { 
              text: `🔒 Auto-lock scheduled for ${formatTime24to12(parsed)}` 
            });
          } catch (err) {
            console.error('.lock time error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to schedule lock' });
          }
        }
        
        // ====================================================
        // COMMAND: .unlock
        // ====================================================
        else if (command === '.unlock') {
          try {
            const meta = await sock.groupMetadata(jid);
            
            if (!meta.announce) {
              // Already unlocked - silent ignore
              return;
            }
            
            await sock.groupSettingUpdate(jid, 'not_announcement');
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: '🔓 Group unlocked' });
            console.log(`🔓 Group ${jid} unlocked by admin`);
          } catch (err) {
            console.error('.unlock error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to unlock group' });
          }
        }
        
        // ====================================================
        // COMMAND: .unlock clear
        // ====================================================
        else if (command === '.unlock clear') {
          try {
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: '🔒 Scheduled unlock cleared' });
          } catch (err) {
            console.error('.unlock clear error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to clear unlock' });
          }
        }
        
        // ====================================================
        // COMMAND: .unlock [time]
        // ====================================================
        else if (command.startsWith('.unlock ')) {
          const timeArg = text.slice(8).trim();
          const parsed = parseTimeTo24h(timeArg);
          
          if (!parsed) {
            await sock.sendMessage(jid, { 
              text: '❌ Invalid time format. Use: .unlock 6:00AM or .unlock 8:30PM' 
            });
            return;
          }
          
          try {
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, { 
              text: `🔓 Auto-unlock scheduled for ${formatTime24to12(parsed)}` 
            });
          } catch (err) {
            console.error('.unlock time error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to schedule unlock' });
          }
        }
        
        // ====================================================
        // COMMAND: .kick
        // ====================================================
        else if (command === '.kick' || command.startsWith('.kick ')) {
          try {
            // Get targets from mentions or reply
            let targets = [];
            
            if (mentioned.length > 0) {
              targets = mentioned;
            } else if (replyTarget) {
              targets = [replyTarget];
            } else {
              await sock.sendMessage(jid, { 
                text: '❌ Tag a user or reply to their message with .kick' 
              });
              return;
            }
            
            // Process each target
            for (const user of targets) {
              // Check if user exists in group
              const userExists = metadata.participants.some(p => p.id === user);
              
              if (!userExists) {
                await sock.sendMessage(jid, {
                  text: `❌ @${user.split('@')[0]} is not in this group`,
                  mentions: [user]
                });
                continue;
              }
              
              // Check if target is admin
              const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
              
              if (isTargetAdmin) {
                await sock.sendMessage(jid, {
                  text: `❌ Cannot remove admin @${user.split('@')[0]}`,
                  mentions: [user]
                });
                continue;
              }
              
              // Perform kick
              await sock.groupParticipantsUpdate(jid, [user], 'remove');
              
              // Send success message
              await sock.sendMessage(jid, {
                text: `✅ @${user.split('@')[0]} has been successfully removed by admin`,
                mentions: [user]
              });
              
              // Small delay between kicks
              await delay(500);
            }
          } catch (err) {
            console.error('.kick error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to kick user' });
          }
        }
        
        // ====================================================
        // COMMAND: .strike reset
        // ====================================================
        else if (command === '.strike reset' || command.startsWith('.strike reset ')) {
          try {
            // Get targets from mentions or reply
            let targets = [];
            
            if (mentioned.length > 0) {
              targets = mentioned;
            } else if (replyTarget) {
              targets = [replyTarget];
            } else {
              await sock.sendMessage(jid, { 
                text: '❌ Tag a user or reply to reset their strikes' 
              });
              return;
            }
            
            // Reset strikes for each target
            for (const user of targets) {
              const success = await resetUserStrikes(jid, user);
              
              if (success) {
                await sock.sendMessage(jid, {
                  text: `✅ Strikes cleared for @${user.split('@')[0]}`,
                  mentions: [user]
                });
              } else {
                await sock.sendMessage(jid, {
                  text: `❌ Failed to clear strikes for @${user.split('@')[0]}`,
                  mentions: [user]
                });
              }
            }
          } catch (err) {
            console.error('.strike reset error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to reset strikes' });
          }
        }
        
        // ====================================================
        // COMMAND: .tagall
        // ====================================================
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
            await sock.sendMessage(jid, { text: '❌ Failed to tag all members' });
          }
        }
        
        // ====================================================
        // COMMAND: .delete
        // ====================================================
        else if (command === '.delete') {
          try {
            if (!ctx?.stanzaId || !ctx?.participant) {
              await sock.sendMessage(jid, { 
                text: '❌ Reply to a message to delete it' 
              });
              return;
            }
            
            // Delete the message (silent - no announcement)
            await sock.sendMessage(jid, {
              delete: { 
                remoteJid: jid, 
                fromMe: false, 
                id: ctx.stanzaId, 
                participant: ctx.participant 
              }
            });
            
            console.log(`🗑️ Message deleted in ${jid} by admin`);
          } catch (err) {
            console.error('.delete error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to delete message' });
          }
        }
        
        // ====================================================
        // COMMAND: .antilink on/off
        // ====================================================
        else if (command === '.antilink on') {
          const success = await updateGroupSettings(jid, { anti_link: true });
          await sock.sendMessage(jid, { 
            text: success ? '🔗 Anti-link protection enabled' : '❌ Failed to enable anti-link' 
          });
        }
        
        else if (command === '.antilink off') {
          const success = await updateGroupSettings(jid, { anti_link: false });
          await sock.sendMessage(jid, { 
            text: success ? '🔗 Anti-link protection disabled' : '❌ Failed to disable anti-link' 
          });
        }
        
        // ====================================================
        // COMMAND: .vulgar on/off
        // ====================================================
        else if (command === '.vulgar on') {
          const success = await updateGroupSettings(jid, { anti_vulgar: true });
          await sock.sendMessage(jid, { 
            text: success ? '🔞 Vulgar word filter enabled' : '❌ Failed to enable filter' 
          });
        }
        
        else if (command === '.vulgar off') {
          const success = await updateGroupSettings(jid, { anti_vulgar: false });
          await sock.sendMessage(jid, { 
            text: success ? '🔞 Vulgar word filter disabled' : '❌ Failed to disable filter' 
          });
        }
        
        // ====================================================
        // COMMAND: .help
        // ====================================================
        else if (command === '.help') {
          try {
            // Get scheduled times
            const sched = await getScheduledLock(jid);
            const lockInfo = sched?.lock_time 
              ? `\n🔒 Lock scheduled: ${formatTime24to12(sched.lock_time)}` 
              : '';
            const unlockInfo = sched?.unlock_time 
              ? `\n🔓 Unlock scheduled: ${formatTime24to12(sched.unlock_time)}` 
              : '';
            
            const helpText = [
              '📋 *AVAILABLE COMMANDS*',
              '',
              '*Lock/Unlock:*',
              '`.lock` - Lock group now',
              '`.lock 9:00PM` - Schedule auto-lock',
              '`.lock clear` - Cancel scheduled lock',
              '`.unlock` - Unlock group now',
              '`.unlock 6:00AM` - Schedule auto-unlock',
              '`.unlock clear` - Cancel scheduled unlock',
              '',
              '*Member Management:*',
              '`.kick @user` - Remove user',
              '`.tagall` - Mention everyone',
              '`.delete` - Delete replied message',
              '',
              '*Strike System:*',
              '`.strike reset @user` - Clear user strikes',
              '',
              '*Feature Toggles:*',
              '`.antilink on/off` - Link protection',
              '`.vulgar on/off` - Vulgar word filter',
              '`.bot on/off` - Enable/disable bot',
              '',
              '*Current Settings:*',
              `Bot: ${settings.bot_active ? '✅ On' : '⏸️ Off'}`,
              `Anti-Link: ${settings.anti_link ? '✅ On' : '❌ Off'}`,
              `Anti-Vulgar: ${settings.anti_vulgar ? '✅ On' : '❌ Off'}`,
              lockInfo,
              unlockInfo
            ].filter(line => line !== '');
            
            await sock.sendMessage(jid, { text: helpText.join('\n') });
          } catch (err) {
            console.error('.help error:', err.message);
            await sock.sendMessage(jid, { text: '❌ Failed to show help' });
          }
        }
        
      } catch (err) {
        console.error('messages.upsert handler error:', err.message);
      }
    });
    
    // ======================================================
    // EVENT: Group Participants Update
    // ======================================================
    sock.ev.on('group-participants.update', async (update) => {
      try {
        const { action, participants, id: groupJid } = update;
        
        if (!groupJid || !participants || participants.length === 0) return;
        
        // Handle new members joining
        const joinActions = ['add', 'invite', 'linked_group_join'];
        
        if (joinActions.includes(action)) {
          // Check if bot is active in this group
          const settings = await getGroupSettings(groupJid);
          
          if (settings.bot_active) {
            // Get group name
            let groupName = 'the group';
            try {
              const meta = await sock.groupMetadata(groupJid);
              groupName = meta.subject || 'the group';
            } catch (err) {
              console.error('Failed to get group name:', err.message);
            }
            
            // Schedule welcome message
            scheduleWelcome(sock, groupJid, participants, groupName);
          }
        }
        
        // Handle members leaving (clean up strikes)
        if (action === 'remove' || action === 'leave') {
          for (const user of participants) {
            await resetUserStrikes(groupJid, user);
          }
        }
      } catch (err) {
        console.error('group-participants.update error:', err.message);
      }
    });
    
  } catch (err) {
    console.error('❌ startBot error:', err.message);
    console.error(err.stack);
    
    // Schedule restart on error
    botStatus = 'failed';
    setTimeout(() => startBot(), 10000);
  } finally {
    isStarting = false;
  }
}

// ======================================================
// START THE SERVER
// ======================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Web server running on http://localhost:${PORT}`);
  console.log(`📱 Open this URL in your browser to see the QR code\n`);
  
  // Start the bot
  startBot();
});

// Handle server errors
server.on('error', (err) => {
  console.error('Server error:', err.message);
  
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    console.error('Please choose a different port or stop the other process');
    process.exit(1);
  }
});
