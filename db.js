// db.js
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
export const supabase = createClient(supabaseUrl, supabaseKey);

// -------------------
// WA Sessions
// -------------------
export async function getSession() {
    const { data, error } = await supabase
        .from('wa_sessions')
        .select('*')
        .eq('id', 1)
        .single();
    if (error) {
        console.error('getSession error:', error);
        return null;
    }
    return data?.auth_data || null;
}

export async function saveSession(authData) {
    const { error } = await supabase
        .from('wa_sessions')
        .upsert({ id: 1, auth_data: authData });
    if (error) console.error('saveSession error:', error);
}

// -------------------
// Group Settings
// -------------------
export async function getGroupSettings(group_jid) {
    const { data, error } = await supabase
        .from('group_settings')
        .select('*')
        .eq('group_jid', group_jid)
        .single();
    if (error) {
        console.error('getGroupSettings error:', error);
        return null;
    }
    return data;
}

export async function setGroupSettings(group_jid, settings = {}) {
    const { error } = await supabase
        .from('group_settings')
        .upsert({ group_jid, ...settings });
    if (error) console.error('setGroupSettings error:', error);
}

// -------------------
// Group Strikes
// -------------------
export async function getUserStrikes(group_jid, user_jid) {
    const { data, error } = await supabase
        .from('group_strikes')
        .select('*')
        .eq('group_jid', group_jid)
        .eq('user_jid', user_jid)
        .single();
    if (error) return null;
    return data;
}

export async function incrementUserStrike(group_jid, user_jid) {
    const current = await getUserStrikes(group_jid, user_jid);
    if (!current) {
        const { error } = await supabase
            .from('group_strikes')
            .insert({ group_jid, user_jid, strikes: 1 });
        if (error) console.error('incrementUserStrike error:', error);
        return 1;
    } else {
        const { error } = await supabase
            .from('group_strikes')
            .update({ strikes: current.strikes + 1, last_strike: new Date() })
            .eq('group_jid', group_jid)
            .eq('user_jid', user_jid);
        if (error) console.error('incrementUserStrike error:', error);
        return current.strikes + 1;
    }
}

export async function resetUserStrikes(group_jid, user_jid) {
    const { error } = await supabase
        .from('group_strikes')
        .delete()
        .eq('group_jid', group_jid)
        .eq('user_jid', user_jid);
    if (error) console.error('resetUserStrikes error:', error);
}

// -------------------
// Scheduled Locks
// -------------------
export async function getScheduledLocks() {
    const { data, error } = await supabase
        .from('group_scheduled_locks')
        .select('*');
    if (error) {
        console.error('getScheduledLocks error:', error);
        return [];
    }
    return data || [];
}

export async function setScheduledLocks(group_jid, lock_time = null, unlock_time = null) {
    const { error } = await supabase
        .from('group_scheduled_locks')
        .upsert({ group_jid, lock_time, unlock_time });
    if (error) console.error('setScheduledLocks error:', error);
}
