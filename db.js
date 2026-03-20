// db.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// SESSION HANDLING
export async function getSession() {
    const { data } = await supabase.from('wa_sessions').select('*').eq('id', 1).single();
    return data?.auth_data || null;
}

export async function saveSession(authData) {
    await supabase.from('wa_sessions').upsert({ id: 1, auth_data: authData, updated_at: new Date() });
}

// GROUP SETTINGS
export async function getGroupSettings(group_jid) {
    const { data } = await supabase.from('group_settings').select('*').eq('group_jid', group_jid).single();
    return data || null;
}

export async function setGroupSettings(group_jid, settings) {
    await supabase.from('group_settings').upsert({ group_jid, ...settings });
}

// GROUP STRIKES
export async function getUserStrikes(group_jid, user_jid) {
    const { data } = await supabase.from('group_strikes').select('strikes').eq('group_jid', group_jid).eq('user_jid', user_jid).single();
    return data?.strikes || 0;
}

export async function addUserStrike(group_jid, user_jid) {
    const current = await getUserStrikes(group_jid, user_jid);
    const strikes = current + 1;
    await supabase.from('group_strikes').upsert({ group_jid, user_jid, strikes, last_strike: new Date() });
    return strikes;
}

export async function resetUserStrikes(group_jid, user_jid) {
    await supabase.from('group_strikes').upsert({ group_jid, user_jid, strikes: 0, last_strike: new Date() });
}

// SCHEDULED LOCKS
export async function getScheduledLocks(group_jid) {
    const { data } = await supabase.from('group_scheduled_locks').select('*').eq('group_jid', group_jid).single();
    return data || null;
}

export async function setScheduledLocks(group_jid, lock_time, unlock_time) {
    await supabase.from('group_scheduled_locks').upsert({ group_jid, lock_time, unlock_time });
}

export default supabase;
