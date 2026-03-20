// database.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- INITIALIZATION ----------
async function initDB() {
    console.log('✅ Supabase client initialized');
}

// ---------- SESSION HANDLING ----------
async function getSession() {
    const { data, error } = await supabase
        .from('wa_sessions')
        .select('*')
        .eq('id', 1)
        .single();

    if (error) throw error;
    return data?.auth_data || null;
}

async function saveSession(authData) {
    const { error } = await supabase
        .from('wa_sessions')
        .upsert({ id: 1, auth_data: authData, updated_at: new Date() })
        .eq('id', 1);

    if (error) console.error('[DB] Failed to save session:', error);
}

// ---------- GROUP SETTINGS ----------
async function getGroupSettings(groupJid) {
    const { data, error } = await supabase
        .from('group_settings')
        .select('*')
        .eq('group_jid', groupJid)
        .single();

    if (error || !data) {
        // Default settings if not found
        return {
            bot_active: true,
            anti_link: true,
            anti_vulgar: true,
            locked: false
        };
    }
    return data;
}

async function updateGroupSettings(groupJid, settings) {
    const { error } = await supabase
        .from('group_settings')
        .upsert({ group_jid: groupJid, ...settings });
    if (error) console.error('[DB] Failed to update group settings:', error);
}

// ---------- STRIKES ----------
async function increaseStrike(groupJid, userJid) {
    const { data } = await supabase
        .from('group_strikes')
        .select('*')
        .eq('group_jid', groupJid)
        .eq('user_jid', userJid)
        .single();

    if (data) {
        const newStrikes = data.strikes + 1;
        await supabase
            .from('group_strikes')
            .update({ strikes: newStrikes, last_strike: new Date() })
            .eq('group_jid', groupJid)
            .eq('user_jid', userJid);
        return newStrikes;
    } else {
        await supabase
            .from('group_strikes')
            .insert({ group_jid: groupJid, user_jid: userJid, strikes: 1 });
        return 1;
    }
}

// ---------- SCHEDULED LOCKS ----------
async function getScheduledLocks() {
    const { data, error } = await supabase
        .from('group_scheduled_locks')
        .select('*');
    if (error) console.error('[DB] Failed to get scheduled locks:', error);
    return data || [];
}

async function updateScheduledLock(groupJid, lockTime, unlockTime) {
    const { error } = await supabase
        .from('group_scheduled_locks')
        .upsert({ group_jid: groupJid, lock_time: lockTime, unlock_time: unlockTime });
    if (error) console.error('[DB] Failed to update scheduled lock:', error);
}

module.exports = {
    supabase,
    initDB,
    getSession,
    saveSession,
    getGroupSettings,
    updateGroupSettings,
    increaseStrike,
    getScheduledLocks,
    updateScheduledLock
};
