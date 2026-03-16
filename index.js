import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
// import { supabase } from './supabaseClient.js'; // comment out if not configured yet
import { delay, createMentions, isAdmin } from './utils/helpers.js';

let isActionRunning = false;
let botActive = true;
let waVersion = null;

// Per-group auto-cleanup info
const autoCleanupGroups = {};
const AUTO_CLEANUP_HOURS = 12; // default 12 hours

async function startBot() {
    if (!waVersion) {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`Using WA v${waVersion.join('.')}`);
    }
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ version: waVersion, auth: state });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n📱 Scan the QR code below with your WhatsApp app:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('✅ Bot connected to WhatsApp!');
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startBot, 3000); // wait 3s before reconnecting
            } else {
                console.log('🔒 Logged out. Please delete the auth_info folder and restart to re-scan QR.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        try {
            const sender = msg.key.participant || msg.key.remoteJid;
            const groupId = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const command = text.trim().toLowerCase();

            const groupMetadata = await sock.groupMetadata(groupId);
            const ext = msg.message.extendedTextMessage;
            const mentionedJid = ext?.contextInfo?.mentionedJid ?? [];

            // Only respond if bot is mentioned
            if (!mentionedJid.includes(sock.user.id)) return;

            // Only admin commands
            if (!isAdmin(sender, groupMetadata.participants)) return;

            // Ignore commands if bot is deactivated (except .activate)
            if (!botActive && command !== '.activate') return;

            // Sequential safety
            if (isActionRunning) {
                await sock.sendMessage(groupId, { text: '⚠️ Another action is currently running. Please wait.' });
                return;
            }

            isActionRunning = true;

            switch(command) {

                // ---- Kick ----
                case '.kick': {
                    const targets = mentionedJid.filter(jid => jid !== sock.user.id);
                    if (!targets.length) {
                        await sock.sendMessage(groupId, { text: '⚠️ Please tag a member (not the bot) to kick.' });
                        break;
                    }

                    for (const target of targets) {
                        const targetInfo = groupMetadata.participants.find(p => p.id === target);
                        if (!targetInfo || targetInfo.admin || target === sock.user.id) {
                            await sock.sendMessage(groupId, { text: `❌ Cannot remove @${target.split('@')[0]} (admin or bot).`, mentions: [target] });
                            continue;
                        }
                        await sock.groupRemove(groupId, [target]);
                        await sock.sendMessage(groupId, { text: `✅ Member @${target.split('@')[0]} has been removed.`, mentions: [target] });
                    }
                    break;
                }

                // ---- Warn ----
                case '.warn': {
                    const targets = mentionedJid.filter(jid => jid !== sock.user.id);
                    if (!targets.length) {
                        await sock.sendMessage(groupId, { text: '⚠️ Please tag a member (not the bot) to warn.' });
                        break;
                    }

                    for (const target of targets) {
                        const targetInfo = groupMetadata.participants.find(p => p.id === target);
                        if (!targetInfo || targetInfo.admin || target === sock.user.id) {
                            await sock.sendMessage(groupId, { text: `❌ Cannot warn @${target.split('@')[0]} (admin or bot).`, mentions: [target] });
                            continue;
                        }
                        await sock.sendMessage(groupId, { text: `⚠️ Admin has sent @${target.split('@')[0]} a warning!`, mentions:[target] });
                    }
                    break;
                }

                // ---- Tagall ----
                case '.tagall': {
                    const mentions = createMentions(groupMetadata.participants.slice(0, 200));
                    await sock.sendMessage(groupId, { text: '📢 Tagging everyone!', mentions });
                    break;
                }

                // ---- Delete ----
                case '.delete': {
                    const targetDelete = ext?.contextInfo?.stanzaId;
                    if (!targetDelete) {
                        await sock.sendMessage(groupId, { text: '⚠️ Please reply to the message you want to delete.' });
                        break;
                    }
                    const key = { remoteJid: groupId, id: targetDelete, fromMe: false };
                    try { await sock.sendMessage(groupId, { delete: key }); } 
                    catch(e){ await sock.sendMessage(groupId, { text: '❌ Could not delete the message.' }); }
                    break;
                }

                // ---- Auto-cleanup ----
                case '.autocleanup': {
                    if (autoCleanupGroups[groupId]) {
                        await sock.sendMessage(groupId, { text: '⚠️ Auto-cleanup already running for this group!' });
                        break;
                    }

                    await sock.groupSettingUpdate(groupId, 'announcement'); // lock

                    autoCleanupGroups[groupId] = { countdown: AUTO_CLEANUP_HOURS, interval: null };
                    await sock.sendMessage(groupId, { text: `⏳ Auto-cleanup started: ${AUTO_CLEANUP_HOURS} hours remaining. Group is locked.` });

                    autoCleanupGroups[groupId].interval = setInterval(async () => {
                        const info = autoCleanupGroups[groupId];
                        if (!info) return;

                        info.countdown--;
                        const freshMetadata = await sock.groupMetadata(groupId);
                        const mentions = createMentions(freshMetadata.participants.slice(0, 200));
                        await sock.sendMessage(groupId, { text: `⏳ ${info.countdown} hours to auto cleanup! Please fill your registration form.`, mentions });

                        if (info.countdown <= 0) {
                            clearInterval(info.interval);
                            delete autoCleanupGroups[groupId];

                            await sock.sendMessage(groupId, { text: '✅ Auto-cleanup completed. Group has been cleaned.' });
                            await sock.groupSettingUpdate(groupId, 'not_announcement'); // unlock
                        }
                    }, 60 * 60 * 1000); // hourly
                    break;
                }

                // ---- Activate / Deactivate ----
                case '.deactivate':
                    botActive = false;
                    await sock.sendMessage(groupId, { text: '❌ Bot deactivated.' });
                    break;

                case '.activate':
                    botActive = true;
                    await sock.sendMessage(groupId, { text: '✅ Bot activated.' });
                    break;

                default: break;
            }

        } catch(error) {
            console.error(error);
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Error: ${error.message}` });
        } finally {
            isActionRunning = false;
        }
    });
}

startBot();
