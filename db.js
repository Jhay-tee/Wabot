// db.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- WA Sessions ---
export async function getSession() {
    const { data, error } = await supabase
        .from('wa_sessions')
        .select('auth_data')
        .eq('id', 1)
        .single();
    if (error) throw error;
    return data?.auth_data || null;
}

export async function saveSession(authData) {
    // Only save if valid object
    if (!authData) return;
    await supabase
        .from('wa_sessions')
        .update({ auth_data: authData, updated_at: new Date().toISOString() })
        .eq('id', 1);
}

// --- Group Settings ---
export async function getGroupSettings(groupJid) {
    const { data } = await supabase
        .from('group_settings')
        .select('*')
        .eq('group_jid', groupJid)
        .single();
    return data || null;
}

export async function setGroupSettings(groupJid, settings) {
    await supabase
        .from('group_settings')
        .upsert({ group_jid: groupJid, ...settings });
}

// --- Strikes ---
export async function getUserStrikes(groupJid, userJid) {
    const { data } = await supabase
        .from('group_strikes')
        .select('strikes')
        .eq('group_jid', groupJid)
        .eq('user_jid', userJid)
        .single();
    return data?.strikes || 0;
}

export async function addUserStrike(groupJid, userJid) {
    const current = await getUserStrikes(groupJid, userJid);
    const strikes = current + 1;
    await supabase
        .from('group_strikes')
        .upsert({ group_jid: groupJid, user_jid: userJid, strikes, last_strike: new Date().toISOString() });
    return strikes;
}

export async function resetUserStrikes(groupJid, userJid) {
    await supabase
        .from('group_strikes')
        .delete()
        .eq('group_jid', groupJid)
        .eq('user_jid', userJid);
}

// --- Scheduled Locks ---
export async function getScheduledLocks() {
    const { data } = await supabase
        .from('group_scheduled_locks')
        .select('*');
    return data || [];
}

export async function setScheduledLock(groupJid, lockTime, unlockTime) {
    await supabase
        .from('group_scheduled_locks')
        .upsert({ group_jid: groupJid, lock_time: lockTime, unlock_time: unlockTime });
            }
