import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { delay, createMentions, isAdmin } from "./utils/helpers.js";

const app = express();

let currentQR = null;
let botStatus = "starting";
let botActive = true;
let isActionRunning = false;
let waVersion = null;

app.get("/", async (req, res) => {

let qrImageTag = "";

if (currentQR) {
const dataUrl = await QRCode.toDataURL(currentQR);

qrImageTag = `
<img src="${dataUrl}"
style="width:80%;max-width:300px;height:auto;border-radius:12px;border:8px solid white"/>
`;
}

res.send(`
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WhatsApp Bot</title>
<style>
body{
background:#0f172a;
color:white;
font-family:sans-serif;
display:flex;
align-items:center;
justify-content:center;
height:100vh;
margin:0
}
.card{
background:#1e293b;
padding:40px;
border-radius:20px;
text-align:center;
width:90%;
max-width:420px
}
</style>
</head>

<body>

<div class="card">

<h2>WhatsApp Bot</h2>

${
botStatus === "connected"
? "<h1>✅ Connected</h1>"
: currentQR
? qrImageTag
: "<p>Starting...</p>"
}

</div>

</body>
</html>
`);
});

app.listen(5000, "0.0.0.0", () => {
console.log("Server running");
});

async function startBot(){

if(!waVersion){
const { version } = await fetchLatestBaileysVersion();
waVersion = version;
}

const { state, saveCreds } = await useMultiFileAuthState("auth_info");

const sock = makeWASocket({
version: waVersion,
auth: state
});

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {

if(qr){
currentQR = qr;
botStatus = "waiting_qr";
qrcode.generate(qr,{small:true});
}

if(connection === "open"){
botStatus = "connected";
currentQR = null;
console.log("Bot connected");
}

if(connection === "close"){

botStatus = "disconnected";

const shouldReconnect =
lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

if(shouldReconnect){
setTimeout(startBot,3000);
}
}

});

sock.ev.on("messages.upsert", async ({ messages }) => {

const msg = messages[0];

if(!msg.message || msg.key.fromMe) return;

const groupId = msg.key.remoteJid;

// ignore DM
if(!groupId.endsWith("@g.us")) return;

try{

const sender = msg.key.participant || msg.key.remoteJid;

const text =
msg.message?.conversation ||
msg.message?.extendedTextMessage?.text ||
msg.message?.imageMessage?.caption ||
msg.message?.videoMessage?.caption ||
"";

const command = text.trim().toLowerCase();

const ext = msg.message?.extendedTextMessage || {};
const mentionedJid = ext.contextInfo?.mentionedJid || [];

if(!mentionedJid.includes(sock.user.id)) return;

const metadata = await sock.groupMetadata(groupId);

if(!isAdmin(sender, metadata.participants)) return;

if(!botActive && command !== ".activate") return;

const validCommands = [
".kick",
".warn",
".tagall",
".delete",
".activate",
".deactivate"
];

if(!validCommands.includes(command)) return;

if(isActionRunning){
await sock.sendMessage(groupId,{
text:"⚠️ Another command is running"
});
return;
}

isActionRunning = true;

switch(command){

case ".tagall":{

const users = metadata.participants;
const batchSize = 20;

for(let i=0;i<users.length;i+=batchSize){

const batch = users.slice(i,i+batchSize);

const mentions = batch.map(p=>p.id);

const tagText = batch
.map(p=>"@"+p.id.split("@")[0])
.join(" ");

await sock.sendMessage(groupId,{
text:tagText,
mentions
});

await delay(4000);
}

break;
}

case ".kick":{

const targets = mentionedJid.filter(j=>j!==sock.user.id);

if(!targets.length){
await sock.sendMessage(groupId,{text:"Tag a user"});
break;
}

for(const user of targets){

const isTargetAdmin =
metadata.participants.find(p=>p.id===user)?.admin;

if(isTargetAdmin){
await sock.sendMessage(groupId,{
text:"❌ Cannot remove admin"
});
continue;
}

await sock.groupParticipantsUpdate(
groupId,
[user],
"remove"
);

await delay(4000);
}

break;
}

case ".warn":{

const targets = mentionedJid.filter(j=>j!==sock.user.id);

if(!targets.length){
await sock.sendMessage(groupId,{text:"Tag user to warn"});
break;
}

await sock.sendMessage(groupId,{
text:"⚠️ Warning issued",
mentions:targets
});

break;
}

case ".delete":{

const quoted =
msg.message?.extendedTextMessage?.contextInfo;

if(!quoted){
await sock.sendMessage(groupId,{
text:"Reply to message to delete"
});
break;
}

await sock.sendMessage(groupId,{
delete:{
remoteJid:groupId,
fromMe:false,
id:quoted.stanzaId,
participant:quoted.participant
}
});

break;
}

case ".deactivate":{

botActive=false;

await sock.sendMessage(groupId,{
text:"Bot deactivated"
});

break;
}

case ".activate":{

botActive=true;

await sock.sendMessage(groupId,{
text:"Bot activated"
});

break;
}

}

}catch(err){

console.log(err);

}

finally{

isActionRunning=false;

}

});

}

startBot();
