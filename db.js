import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

export const supabase = createClient(CONFIG.SUPERBASE_URL, CONFIG.SUPERBASE_KEY);

// WA Sessions
export const getSession = async () => {
  const { data, error } = await supabase.from('wa_sessions').select('*').eq('id', 1).single();
  if (error) throw error;
  return data?.auth_data || null;
};

export const saveSession = async (authData) => {
  const { error } = await supabase.from('wa_sessions').update({ auth_data: authData }).eq('id', 1);
  if (error) console.error('Error saving session:', error);
};

// Group Settings
export const getGroupSettings = async (groupJid) => {
  const { data } = await supabase.from('group_settings').select('*').eq('group_jid', groupJid).single();
  return data;
};

export const updateGroupSetting = async (groupJid, update) => {
  await supabase.from('group_settings').upsert({ group_jid: groupJid, ...update });
};

// Strikes
export const getStrikes = async (groupJid, userJid) => {
  const { data } = await supabase.from('group_strikes').select('*').eq('group_jid', groupJid).eq('user_jid', userJid).single();
  return data?.strikes || 0;
};

export const incrementStrike = async (groupJid, userJid) => {
  const strikes = await getStrikes(groupJid, userJid);
  await supabase.from('group_strikes').upsert({ group_jid: groupJid, user_jid: userJid, strikes: strikes + 1 });
  return strikes + 1;
};

export const resetStrikes = async (groupJid, userJid) => {
  await supabase.from('group_strikes').delete().eq('group_jid', groupJid).eq('user_jid', userJid);
};

// Scheduled Locks
export const getScheduledLock = async (groupJid) => {
  const { data } = await supabase.from('group_scheduled_locks').select('*').eq('group_jid', groupJid).single();
  return data;
};

export const upsertScheduledLock = async (groupJid, lockTime, unlockTime) => {
  await supabase.from('group_scheduled_locks').upsert({ group_jid: groupJid, lock_time: lockTime, unlock_time: unlockTime });
};
