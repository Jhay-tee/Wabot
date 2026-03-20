// commands.js
const { increaseStrike, getGroupSettings, updateGroupSettings } = require('./db');
const vulgarWords = ['bitch', 'doggystyle', 'pussy', 'shit', 'fuck', 'ass', 'cunt', 'bastard'];

module.exports = {
    handleMessage: async ({ client, message, isAdmin }) => {
        const from = message.key.remoteJid;
        const msgContent = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const groupSettings = await getGroupSettings(from);

        // Skip processing if bot is off in this group
        if (!groupSettings.bot_active) return;

        // Anti-link check
        if (groupSettings.anti_link && !isAdmin && /https?:\/\/\S+/i.test(msgContent)) {
            const strikes = await increaseStrike(from, message.key.participant);
            await client.sendMessage(from, { text: `⚠️ You sent a link! Strike ${strikes}/3` }, { quoted: message });
            if (strikes >= 3) {
                await client.groupParticipantsUpdate(from, [message.key.participant], 'remove');
                await client.sendMessage(from, { text: `❌ User removed for 3 strikes!` });
            }
            return;
        }

        // Anti-vulgar check
        if (groupSettings.anti_vulgar && !isAdmin) {
            const found = vulgarWords.find(word => msgContent.toLowerCase().includes(word));
            if (found) {
                await client.sendMessage(from, { text: `🚫 ${message.key.participant.split('@')[0]}, this message is not allowed in this group.` }, { quoted: message });
                await client.deleteMessage(from, { id: message.key.id, remoteJid: from, fromMe: false });
                console.log(`[ANTI-VULGAR] Deleted vulgar message from ${message.key.participant}`);
                return;
            }
        }

        if (!msgContent.startsWith('.')) return; // Not a command
        if (!isAdmin) return; // Only admin commands

        const args = msgContent.trim().split(/\s+/);
        const command = args[0].toLowerCase();

        // ----- HELP -----
        if (command === '.help' || command === '.helps') {
            console.log(`[COMMAND] Executing .help`);
            const helpText = `
📜 *Group Commands*:
.kick [@user or reply] - Remove a user immediately
.delete [message ID or reply] - Delete a message
.lock - Lock the group (admin only)
.unlock - Unlock the group
.bot on/off - Activate/deactivate bot
.link on/off - Toggle anti-link
.vulgar on/off - Toggle anti-vulgar
.help - Show this message
`;
            await client.sendMessage(from, { text: helpText });
            return;
        }

        // ----- KICK -----
        if (command === '.kick') {
            let targetJid;

            // Reply-based
            const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) targetJid = message.message.extendedTextMessage.contextInfo.participant;

            // Mention-based
            else if (args[1] && args[1].startsWith('@')) {
                targetJid = args[1].replace('@', '') + '@s.whatsapp.net';
            }

            if (!targetJid) return;

            console.log(`[COMMAND] Executing .kick -> ${targetJid}`);
            await client.groupParticipantsUpdate(from, [targetJid], 'remove');
            return;
        }

        // ----- DELETE -----
        if (command === '.delete') {
            let messageId;
            const quotedMsg = message.message?.extendedTextMessage?.contextInfo?.stanzaId;
            if (quotedMsg) messageId = quotedMsg;
            else if (args[1]) messageId = args[1]; // optional: message ID

            if (!messageId) return;

            console.log(`[COMMAND] Executing .delete -> ${messageId}`);
            await client.deleteMessage(from, { id: messageId, remoteJid: from, fromMe: false });
            return;
        }

        // ----- LOCK / UNLOCK -----
        if (command === '.lock' || command === '.unlock') {
            const lock = command === '.lock';
            await updateGroupSettings(from, { bot_active: groupSettings.bot_active, anti_link: groupSettings.anti_link, anti_vulgar: groupSettings.anti_vulgar, locked: lock });
            console.log(`[COMMAND] Executing ${command}`);
            await client.sendMessage(from, { text: `🔒 Group ${lock ? 'locked' : 'unlocked'}` });
            return;
        }

        // ----- BOT ON/OFF -----
        if (command === '.bot') {
            if (!args[1]) return;
            const active = args[1].toLowerCase() === 'on';
            await updateGroupSettings(from, { bot_active: active, anti_link: groupSettings.anti_link, anti_vulgar: groupSettings.anti_vulgar });
            console.log(`[COMMAND] Executing .bot -> ${active ? 'on' : 'off'}`);
            await client.sendMessage(from, { text: `🤖 Bot is now ${active ? 'active' : 'inactive'}` });
            return;
        }

        // ----- ANTI-LINK -----
        if (command === '.link') {
            if (!args[1]) return;
            const linkOn = args[1].toLowerCase() === 'on';
            await updateGroupSettings(from, { anti_link: linkOn, bot_active: groupSettings.bot_active, anti_vulgar: groupSettings.anti_vulgar });
            console.log(`[COMMAND] Executing .link -> ${linkOn ? 'on' : 'off'}`);
            await client.sendMessage(from, { text: `🔗 Anti-link is now ${linkOn ? 'on' : 'off'}` });
            return;
        }

        // ----- ANTI-VULGAR -----
        if (command === '.vulgar') {
            if (!args[1]) return;
            const vulgarOn = args[1].toLowerCase() === 'on';
            await updateGroupSettings(from, { anti_vulgar: vulgarOn, bot_active: groupSettings.bot_active, anti_link: groupSettings.anti_link });
            console.log(`[COMMAND] Executing .vulgar -> ${vulgarOn ? 'on' : 'off'}`);
            await client.sendMessage(from, { text: `🤬 Anti-vulgar is now ${vulgarOn ? 'on' : 'off'}` });
            return;
        }
    }
};
