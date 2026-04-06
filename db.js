import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing Supabase URL or ANON key – bot features disabled');
}

const supabase = (url && key) ? createClient(url, key) : null;

// ────────────────────────────────────────────────
// 📦 AUTH SESSION (jsonb FIXED)
// ────────────────────────────────────────────────

export async function getSession(id = 1) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('wa_sessions')
    .select('auth_data')
    .eq('id', id)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('getSession → error:', error.message);
    return null;
  }

  // ✅ jsonb → return directly
  return data?.auth_data || null;
}

export async function saveSession(authData, id = 1) {
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('wa_sessions')
      .upsert(
        {
          id,
          auth_data: authData, // ✅ store object directly
          timestamp: new Date().toISOString()
        },
        { onConflict: 'id' }
      );

    if (error) throw error;

  } catch (err) {
    console.error('saveSession failed:', err.message);
  }
}

export async function clearSession(id = 1) {
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('wa_sessions')
      .delete()
      .eq('id', id);

    if (error) throw error;

    console.log('🗑️ Session cleared from Supabase');
  } catch (err) {
    console.error('clearSession failed:', err.message);
  }
}

// ────────────────────────────────────────────────
// ⚙️ GROUP SETTINGS
// ────────────────────────────────────────────────

export async function getGroupSettings(groupJid) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('group_settings')
    .select('*')
    .eq('group_jid', groupJid)
    .maybeSingle();

  if (error) {
    console.error('getGroupSettings error:', error.message);
    return null;
  }

  return data || null;
}

export async function setGroupSettings(groupJid, updates) {
  if (!supabase) return;

  const { error } = await supabase
    .from('group_settings')
    .upsert(
      { group_jid: groupJid, ...updates },
      { onConflict: 'group_jid' }
    );

  if (error) {
    console.error('setGroupSettings failed:', error.message);
  }
}

// ────────────────────────────────────────────────
// ⚠️ STRIKES SYSTEM
// ────────────────────────────────────────────────

export async function addUserStrike(groupJid, userJid) {
  if (!supabase) return null;

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
  if (!supabase) return;

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
// ⏰ SCHEDULED LOCKS
// ────────────────────────────────────────────────

export async function getScheduledLocks() {
  if (!supabase) return [];

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
  if (!supabase) return;

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
  if (!supabase) return;

  const { error } = await supabase
    .from('group_scheduled_locks')
    .update({ lock_time: null })
    .eq('group_jid', groupJid);

  if (error) {
    console.error('clearUsedLockTime failed:', error.message);
  }
}

export async function clearUsedUnlockTime(groupJid) {
  if (!supabase) return;

  const { error } = await supabase
    .from('group_scheduled_locks')
    .update({ unlock_time: null })
    .eq('group_jid', groupJid);

  if (error) {
    console.error('clearUsedUnlockTime failed:', error.message);
  }
      }
