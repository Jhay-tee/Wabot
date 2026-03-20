// db.js
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Supabase URL or Key is missing in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Session
export async function getSession() {
  const { data, error } = await supabase
    .from('wa_sessions')
    .select('auth_data')
    .eq('id', 1)
    .single();
  if (error) return null;
  return data;
}

export async function saveSession(authData) {
  const { error } = await supabase
    .from('wa_sessions')
    .upsert({ id: 1, auth_data: authData }, { onConflict: ['id'] });
  if (error) console.error('Error saving session:', error);
}

// Group settings
export async function getGroupSettings(groupJid) {
  const { data, error } = await supabase
    .from('group_settings')
    .select('*')
    .eq('group_jid', groupJid)
    .single();
  if (error) return null;
  return data;
}

export async function setGroupSettings(groupJid, updates) {
  const { error } = await supabase
    .from('group_settings')
    .upsert({ group_jid: groupJid, ...updates }, { onConflict: ['group_jid'] });
  if (error) console.error('Error updating group settings:', error);
}

// Strikes
export async function addUserStrike(groupJid, userJid) {
  const { data } = await supabase
    .from('group_strikes')
    .select('strikes')
    .eq('group_jid', groupJid)
    .eq('user_jid', userJid)
    .single();
  let strikes = data?.strikes ?? 0;
  strikes += 1;

  const { error } = await supabase
    .from('group_strikes')
    .upsert({ group_jid: groupJid, user_jid: userJid, strikes }, { onConflict: ['group_jid', 'user_jid'] });

  if (error) console.error('Error adding strike:', error);
  return strikes;
}

export async function resetUserStrikes(groupJid, userJid) {
  const { error } = await supabase
    .from('group_strikes')
    .upsert({ group_jid: groupJid, user_jid: userJid, strikes: 0 }, { onConflict: ['group_jid', 'user_jid'] });
  if (error) console.error('Error resetting strikes:', error);
}

// Scheduled locks
export async function getScheduledLocks() {
  const { data, error } = await supabase.from('group_scheduled_locks').select('*');
  if (error) return [];
  return data;
}

export async function setScheduledLocks(groupJid, lockTime, unlockTime) {
  const { error } = await supabase
    .from('group_scheduled_locks')
    .upsert({ group_jid: groupJid, lock_time: lockTime, unlock_time: unlockTime }, { onConflict: ['group_jid'] });
  if (error) console.error('Error updating scheduled locks:', error);
}
