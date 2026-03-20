// commands.js
import { incrementUserStrike, resetUserStrikes, getGroupSettings, setGroupSettings } from './db.js';

const vulgarWords = ['bitch', 'shit', 'fuck', 'asshole', 'damn', 'dick'];

export async function handleCommand(sock, msg, text, groupSettings) {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const isAdmin = msg.key.participant && groupSettings?.admins?.includes(sender);

    const args = text.trim().split(' ');
    const cmd = args[0].slice(1).toLowerCase();

    // Only admin commands are executed
    if (!isAdmin && ['kick', 'delete', 'lock', 'unlock', 'bot', 'link', 'vulgar'].includes(cmd)) return;

    switch (cmd) {
        case 'kick':
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage) return;
            const targetKick = msg.message.extendedTextMessage.contextInfo.participant;
            await sock.groupRemove(from, [targetKick]);
            console.log(`Kicked ${targetKick} from ${from}`);
            break;

        case 'delete':
            if (!msg.message.extendedTextMessage?.contextInfo?.stanzaId) return;
            const targetDelete = msg.message.extendedTextMessage.contextInfo.stanzaId;
            await sock.sendMessage(from, { delete: { remoteJid: from, id: targetDelete, participant: sender } });
            console.log(`Deleted message ${targetDelete} in ${from}`);
            break;

        case 'lock':
            await sock.groupSettingUpdate(from, 'announcement');
            console.log(`Group ${from} locked by ${sender}`);
            break;

        case 'unlock':
            await sock.groupSettingUpdate(from, 'not_announcement');
            console.log(`Group ${from} unlocked by ${sender}`);
            break;

        case 'bot':
            if (args[1] === 'on') await setGroupSettings(from, { bot_active: true });
            else if (args[1] === 'off') await setGroupSettings(from, { bot_active: false });
            break;

        case 'help':
            await sock.sendMessage(from, { text: 'Commands:\n.kick @user\n.delete (reply)\n.lock\n.unlock\n.bot on/off\n.link on/off\n.vulgar on/off\n.help' });
            break;

        default:
            break;
    }
}

// Anti-vulgar check
export async function checkVulgar(sock, msg, groupSettings) {
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    if (groupSettings?.admins?.includes(sender)) return;

    const found = vulgarWords.find((w) => text.toLowerCase().includes(w));
    if (found) {
        await sock.sendMessage(from, { text: `@${sender.split('@')[0]}, this kind of message is not allowed!`, mentions: [sender] });
        await sock.sendMessage(from, { delete: { remoteJid: from, id: msg.key.id, participant: sender } });
        console.log(`Deleted vulgar message from ${sender}`);
    }
}
