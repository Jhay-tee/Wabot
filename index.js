// index.js
import makeWASocket, { useSingleFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import P from 'pino';
import { getSession, saveSession, getGroupSettings, getScheduledLocks } from './db.js';
import { handleCommand, handleMessage } from './commands.js';

const SESSION_DEBOUNCE_MS = 5000;

let saveSessionTimer;
function debouncedSaveSession(authData) {
    clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(() => saveSession(authData), SESSION_DEBOUNCE_MS);
}

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        version,
        auth: await getSession() ? { creds: await getSession() } : useSingleFileAuthState('./session.json')
    });

    // Connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) console.log('Scan this QR code to connect:', qr);
        if (connection === 'close') {
            console.log('Connection closed. Reason:', lastDisconnect?.error?.output?.statusCode);
        }
    });

    sock.ev.on('creds.update', debouncedSaveSession);

    // Message listener
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.participant || msg.key.remoteJid;
            const groupSettings = msg.key.remoteJid.includes('@g.us') ? await getGroupSettings(msg.key.remoteJid) : null;
            const isAdmin = true; // Placeholder: Replace with actual admin check logic
            const text = msg.message.conversation || msg.message?.extendedTextMessage?.text;

            if (text?.startsWith('.')) {
                await handleCommand(sock, msg, sender, isAdmin);
            } else if (groupSettings) {
                await handleMessage(sock, msg, groupSettings, sender, isAdmin);
            }
        }
    });

    // Automatic scheduled locks/unlocks
    setInterval(async () => {
        const locks = await getScheduledLocks();
        const now = new Date();
        for (let lock of locks) {
            const groupJid = lock.group_jid;
            if (lock.lock_time && new Date(lock.lock_time) <= now) {
                await sock.groupSettingUpdate(groupJid, 'announcement');
                await setScheduledLocks(groupJid, null, lock.unlock_time);
            }
            if (lock.unlock_time && new Date(lock.unlock_time) <= now) {
                await sock.groupSettingUpdate(groupJid, 'not_announcement');
                await setScheduledLocks(groupJid, lock.lock_time, null);
            }
        }
    }, 60 * 1000);
}

startBot().catch(console.error);
