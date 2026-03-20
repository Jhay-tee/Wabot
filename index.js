// index.js
import pkg from '@whiskeysockets/baileys';
const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = pkg;

import qrcode from 'qrcode-terminal';
import { getSession, saveSession, getGroupSettings, getScheduledLocks } from './db.js';
import { handleCommand } from './commands.js';

async function startBot() {
    try {
        // fetch latest WhatsApp version
        const [version] = await fetchLatestBaileysVersion();
        console.log('Using WhatsApp Web version:', version);

        // get session from Supabase
        let authState = await getSession();
        if (!authState || !authState.creds) {
            console.log('No valid session found. You need to scan QR code.');
            authState = { creds: null, keys: {} };
        }

        // initialize WhatsApp socket
        const sock = makeWASocket({
            version,
            auth: authState,
            printQRInTerminal: true,
        });

        // QR code event
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                console.log('Scan this QR code to log in:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log('Connection closed. Reason:', reason);
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('Reconnecting...');
                    startBot();
                } else {
                    console.log('Logged out. Clear session in DB.');
                    await saveSession({ creds: null, keys: {} });
                }
            }

            if (connection === 'open') {
                console.log('Connected to WhatsApp!');
            }
        });

        // update session on creds change
        sock.ev.on('creds.update', async (creds) => {
            if (!creds) return;
            console.log('Session updated, saving to DB...');
            await saveSession({ creds, keys: authState.keys });
        });

        // message handling
        sock.ev.on('messages.upsert', async (msgUpdate) => {
            try {
                const messages = msgUpdate.messages;
                if (!messages || !messages.length) return;

                for (const msg of messages) {
                    if (!msg.message || msg.key.fromMe) continue; // ignore bot messages

                    // pass the message to commands.js
                    await handleCommand(sock, msg);
                }
            } catch (err) {
                console.error('Error handling messages:', err);
            }
        });

        // periodic tasks: check group locks
        setInterval(async () => {
            const locks = await getScheduledLocks();
            // logic to auto lock/unlock groups based on locks
            // you can implement inside a helper function
        }, 30_000); // every 30 seconds
    } catch (err) {
        console.error('Failed to start bot:', err);
    }
}

startBot();
