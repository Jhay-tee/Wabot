// index.js
import pkg from '@whiskeysockets/baileys';
const { 
    default: makeWASocket, 
    fetchLatestBaileysVersion, 
    useSingleFileAuthState, 
    DisconnectReason, 
    makeCacheableSignalKeyStore
} = pkg;

import P from 'pino';
import qrcode from 'qrcode-terminal';
import { 
    getSession, 
    saveSession, 
    getGroupSettings, 
    setGroupSettings,
    getScheduledLocks, 
    setScheduledLocks,
    addUserStrike,
    resetUserStrikes
} from './db.js';
import { handleCommand } from './commands.js';

const logger = P({ level: 'info' });

async function startBot() {
    try {
        const { state, saveState } = await getSession();

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WhatsApp Web version: ${version.join('.')}, Latest: ${isLatest}`);

        const sock = makeWASocket({
            version,
            printQRInTerminal: true,
            auth: state,
            logger,
            generateHighQualityLinkPreview: true,
        });

        // Update auth state in memory -> save to DB on change
        sock.ev.on('creds.update', saveState);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR code received, scan with WhatsApp:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('Disconnected:', reason);
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('Reconnecting...');
                    startBot();
                } else {
                    console.log('Logged out. Clearing session in DB.');
                    await saveSession(null);
                }
            }

            if (connection === 'open') {
                console.log('✅ Connected to WhatsApp!');
            }
        });

        // Listen to messages
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            try {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                const sender = msg.key.participant || msg.key.remoteJid;

                // Fetch group settings if it's a group message
                const groupSettings = msg.key.remoteJid.includes('@g.us') ? await getGroupSettings(msg.key.remoteJid) : null;

                // Call command handler
                await handleCommand(sock, msg, text, sender, groupSettings);
            } catch (err) {
                console.error('Error handling message:', err);
            }
        });

        // Periodically check scheduled locks/unlocks
        setInterval(async () => {
            const locks = await getScheduledLocks();
            const now = new Date();

            for (let lock of locks) {
                const { group_jid, lock_time, unlock_time } = lock;
                if (lock_time && now >= new Date(lock_time)) {
                    await sock.groupSettingUpdate(group_jid, 'announcement');
                    await setScheduledLocks(group_jid, null, unlock_time);
                    console.log(`🔒 Group ${group_jid} locked automatically`);
                }
                if (unlock_time && now >= new Date(unlock_time)) {
                    await sock.groupSettingUpdate(group_jid, 'not_announcement');
                    await setScheduledLocks(group_jid, lock_time, null);
                    console.log(`🔓 Group ${group_jid} unlocked automatically`);
                }
            }
        }, 30 * 1000); // every 30 seconds

        return sock;
    } catch (err) {
        console.error('Failed to start bot:', err);
    }
}

startBot();
