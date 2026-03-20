// commands.js
import { getGroupSettings, setGroupSettings, addUserStrike, resetUserStrikes } from './db.js';

const VULGAR_WORDS = ['bitch', 'shit', 'fuck', 'ass', 'damn']; // Add more

export async function handleCommand(sock, message, sender, isAdmin) {
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
    const groupJid = message.key.remoteJid;

    if (!text || !isAdmin) return; // Only log/admin commands

    console.log(`Executing command from admin: ${text}`);

    const args = text.trim().split(/\s+/);
    const command = args[0].toLowerCase();

    switch(command) {
        case '.kick':
            if (args.length < 2 && !message.message?.extendedTextMessage?.contextInfo?.quotedMessage) return;
            let target = args[1] || message.message.extendedTextMessage.contextInfo.participant;
            await sock.groupRemove(groupJid, [target]);
            break;

        case '.delete':
            if (!message.message?.extendedTextMessage?.contextInfo?.stanzaId) return;
            await sock.sendMessage(groupJid, { delete: message.message.extendedTextMessage.contextInfo.stanzaId });
            break;

        case '.lock':
            await sock.groupSettingUpdate(groupJid, 'announcement'); // only admins can write
            break;

        case '.unlock':
            await sock.groupSettingUpdate(groupJid, 'not_announcement'); // all participants can write
            break;

        case '.bot':
            if (args[1] === 'on') await setGroupSettings(groupJid, { bot_active: true });
            if (args[1] === 'off') await setGroupSettings(groupJid, { bot_active: false });
            break;

        case '.link':
            await setGroupSettings(groupJid, { anti_link: args[1] === 'on' });
            break;

        case '.vulgar':
            await setGroupSettings(groupJid, { anti_vulgar: args[1] === 'on' });
            break;

        case '.help':
            await sock.sendMessage(groupJid, { text: `
Available commands:
.kick @user
.delete (reply)
.lock / .unlock
.bot on/off
.link on/off
.vulgar on/off
.help
`});
            break;

        default:
            break;
    }
}

export async function handleMessage(sock, message, groupSettings, sender, isAdmin) {
    const text = message.message?.conversation;
    const groupJid = message.key.remoteJid;
    if (!text || !groupSettings) return;

    // Anti-vulgar
    if (groupSettings.anti_vulgar && !isAdmin) {
        const found = VULGAR_WORDS.find(word => text.toLowerCase().includes(word));
        if (found) {
            await sock.sendMessage(groupJid, { text: `@${sender.split('@')[0]}, this kind of message is not allowed in this group.`, mentions: [sender] });
            await sock.sendMessage(groupJid, { delete: message.key.id });
        }
    }

    // Anti-link
    if (groupSettings.anti_link && !isAdmin) {
        const linkRegex = /(https?:\/\/[^\s]+)/gi;
        if (text.match(linkRegex)) {
            const strikes = await addUserStrike(groupJid, sender);
            if (strikes >= 3) {
                await sock.groupRemove(groupJid, [sender]);
                await resetUserStrikes(groupJid, sender);
            } else {
                await sock.sendMessage(groupJid, { text: `@${sender.split('@')[0]}, this is your strike ${strikes}/3.`, mentions: [sender] });
            }
        }
    }
}
