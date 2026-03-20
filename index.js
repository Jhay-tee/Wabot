// index.js
import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, useSingleFileAuthState, fetchLatestBaileysVersion, DisconnectReason, makeInMemoryStore } = pkg;

import P from 'pino';
import { getSession, saveSession, getGroupSettings, getScheduledLocks, setScheduledLocks } from './db.js';
import { handleCommand, handleMessage } from './commands.js';

import * as fs from 'fs';
import * as path from 'path';

// -------------------
// Setup Auth & Store
// -------------------
const { state, saveState } = useSingleFileAuthState('session.json');
const store = makeInMemoryStore({ logger: P().child({ level: 'info', stream: 'store' }) });

// -------------------
// Connect to WhatsApp
// -------------------
async function startBot() {
    const [version] = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger: P({ level: 'info' }),
        printQRInTerminal: true,
        auth: state
    });

    store.bind(sock.ev);

    // -------------------
    // Connection Updates
    // -------------------
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan the QR code to connect WhatsApp!');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Connection closed, reconnecting?', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
        }

        // Always save auth data when it changes
        saveState();
        await saveSession(state);
    });

    // -------------------
    // Incoming Messages
    // -------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            // Handle commands
            const isCommand = await handleCommand(sock, msg);
            if (!isCommand) {
                // Non-command messages
                await handleMessage(sock, msg);
            }
        }
    });

    // -------------------
    // Scheduled locks
    // -------------------
    setInterval(async () => {
        const locks = await getScheduledLocks();
        const now = new Date();

        for (const lock of locks) {
            const { group_jid, lock_time, unlock_time } = lock;
            if (lock_time) {
                const lockDate = new Date(lock_time);
                if (now >= lockDate) {
                    await sock.groupSettingUpdate(group_jid, 'announcement'); // lock group
                    await setScheduledLocks(group_jid, null, unlock_time); // remove lock_time
                    console.log(`🔒 Group ${group_jid} locked automatically`);
                }
            }
            if (unlock_time) {
                const unlockDate = new Date(unlock_time);
                if (now >= unlockDate) {
                    await sock.groupSettingUpdate(group_jid, 'not_announcement'); // unlock group
                    await setScheduledLocks(group_jid, lock_time, null); // remove unlock_time
                    console.log(`🔓 Group ${group_jid} unlocked automatically`);
                }
            }
        }
    }, 60000); // check every minute
}

startBot();
