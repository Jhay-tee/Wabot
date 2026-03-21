// db.js
import { createClient } from '@supabase/supabase-js';
import { BufferJSON } from '@whiskeysockets/baileys';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing Supabase URL or ANON key');
  process.exit(1);
}

const supabase = createClient(url, key);

// ────────────────────────────────────────────────
// Auth session (Baileys v7 compatible – with BufferJSON)
// ────────────────────────────────────────────────

export async function getSession(id = 1) {
  const { data, error } = await supabase
    .from('wa_sessions')
    .select('auth_data')
    .eq('id', id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('getSession → error:', error.message);
    return null;
  }

  if (!data?.auth_data) return null;

  try {
    // Use BufferJSON.reviver to restore Buffers
    return JSON.parse(data.auth_data, BufferJSON.reviver);
  } catch (e) {
    console.error('Failed to parse stored auth data:', e.message);
    return null;
  }
}

export async function saveSession(authState, id = 1) {
  if (!authState?.creds) {
    console.warn('saveSession called with incomplete authState');
    return;
  }

  try {
    // Use BufferJSON.replacer to serialize Buffers
    const payload = JSON.stringify(authState, BufferJSON.replacer);

    const { error } = await supabase
      .from('wa_sessions')
      .upsert({ id, auth_data: payload }, { onConflict: 'id' });

    if (error) throw error;

    console.log('💾 Auth state saved to Supabase');
  } catch (err) {
    console.error('saveSession failed:', err.message);
  }
}

export async function clearSession(id = 1) {
  try {
    const { error } = await supabase
      .from('wa_sessions')
      .delete()
      .eq('id', id);

    if (error) throw error;

    console.log('🗑️ Session cleared');
  } catch (err) {
    console.error('clearSession failed:', err.message);
  }
}

// ────────────────────────────────────────────────
// Group settings
// ────────────────────────────────────────────────

export async function getGroupSettings(groupJid) {
  const { data, error } = await supabase
    .from('group_settings')
    .select('*')
    .eq('group_jid', groupJid)
    .maybeSingle();

  if (error) {
    console.error('getGroupSettings error:', error.message);
    return null;
  }
  return data;
}

export async function setGroupSettings(groupJid, updates) {
  const { error } = await supabase
    .from('group_settings')
    .upsert({ group_jid: groupJid, ...updates }, { onConflict: 'group_jid' });

  if (error) {
    console.error('setGroupSettings failed:', error.message);
  }
}

// ────────────────────────────────────────────────
// Strikes
// ────────────────────────────────────────────────

export async function addUserStrike(groupJid, userJid) {
  try {
    const { data } = await supabase
      .from('group_strikes')
      .select('strikes')
      .eq('group_jid', groupJid)
      .eq('user_jid', userJid)
      .maybeSingle();

    let strikes = data?.strikes ?? 0;
    strikes += 1;

    const { error } = await supabase
      .from('group_strikes')
      .upsert(
        { group_jid: groupJid, user_jid: userJid, strikes },
        { onConflict: ['group_jid', 'user_jid'] }
      );

    if (error) throw error;
    return strikes;
  } catch (err) {
    console.error('addUserStrike failed:', err.message);
    return null;
  }
}

export async function resetUserStrikes(groupJid, userJid) {
  const { error } = await supabase
    .from('group_strikes')
    .upsert(
      { group_jid: groupJid, user_jid: userJid, strikes: 0 },
      { onConflict: ['group_jid', 'user_jid'] }
    );

  if (error) {
    console.error('resetUserStrikes failed:', error.message);
  }
}

// ────────────────────────────────────────────────
// Scheduled locks
// ────────────────────────────────────────────────

export async function getScheduledLocks() {
  const { data, error } = await supabase
    .from('group_scheduled_locks')
    .select('*');

  if (error) {
    console.error('getScheduledLocks error:', error.message);
    return [];
  }
  return data || [];
}

export async function setScheduledLocks(groupJid, lockTimeIso, unlockTimeIso) {
  const row = { group_jid: groupJid };
  if (lockTimeIso !== undefined) row.lock_time = lockTimeIso;
  if (unlockTimeIso !== undefined) row.unlock_time = unlockTimeIso;

  const { error } = await supabase
    .from('group_scheduled_locks')
    .upsert(row, { onConflict: 'group_jid' });

  if (error) {
    console.error('setScheduledLocks failed:', error.message);
  }
}

export async function clearUsedLockTime(groupJid) {
  const { error } = await supabase
    .from('group_scheduled_locks')
    .update({ lock_time: null })
    .eq('group_jid', groupJid);

  if (error) console.error('clearUsedLockTime failed:', error.message);
}

export async function clearUsedUnlockTime(groupJid) {
  const { error } = await supabase
    .from('group_scheduled_locks')
    .update({ unlock_time: null })
    .eq('group_jid', groupJid);

  if (error) console.error('clearUsedUnlockTime failed:', error.message);
}
