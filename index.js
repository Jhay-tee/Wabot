// index.js
require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { handleMessage } = require('./commands');
const { initDB, getGroupSettings } = require('./database');

(async () => {
    await initDB();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const client = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    client.ev.on('creds.update', saveCreds);

    client.ev.on('messages.upsert', async ({ messages }) => {
        for (const message of messages) {
            if (!message.message || message.key.fromMe) continue;

            const from = message.key.remoteJid;
            const groupSettings = await getGroupSettings(from);

            // Admin check
            const isAdmin = message.key.participant ? true : false; // replace with proper admin detection

            await handleMessage({ client, message, isAdmin });
        }
    });

    console.log('✅ Bot is running...');
})();
