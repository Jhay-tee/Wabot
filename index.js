// index.js
import makeWASocket, { fetchLatestBaileysVersion, useSingleFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import P from 'pino';
import { config } from 'dotenv';
import { getSession, saveSession, getGroupSettings } from './db.js';
import { handleCommand, checkVulgar } from './commands.js';

config();
const logger = P({ level: 'info' });

async function startBot() {
    const [version] = await fetchLatestBaileysVersion();
    const { state, saveState } = useSingleFileAuthState('auth_info.json');

    const sock = makeWASocket({ logger, printQRInTerminal: true, auth: state, version });
    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) console.log('Scan QR:', qr);
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('Disconnected:', code);
            if (code !== DisconnectReason.loggedOut) startBot();
        }
        if (connection === 'open') console.log('✅ Connected to WhatsApp');
    });

    sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages;
        if (!messages || !messages.length) return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const groupSettings = await getGroupSettings(from);

        // Anti-vulgar enforcement
        await checkVulgar(sock, msg, groupSettings);

        // Only handle commands starting with .
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text?.startsWith('.')) await handleCommand(sock, msg, text, groupSettings);
    });
}

startBot().catch(console.error);
