import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} from "@whiskeysockets/baileys";

import express from "express";
import QRCode from "qrcode";
import qrcode from "qrcode-terminal";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import pino from "pino";

dotenv.config();

// ===== CONFIG =====
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const VULGAR = ["fuck", "nigga", "nigger", "bitch", "asshole", "shit"];

// ===== APP =====
const app = express();
let sock;
let currentQR = null;
let botStatus = "starting";

// ===== SUPABASE =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== HELPERS =====
const delay = (ms) => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  const u = participants.find(p => p.id === jid);
  return u && (u.admin === "admin" || u.admin === "superadmin");
};

const normalize = (s) => s.toLowerCase().replace(/\s+/g, "");

const getNigeriaTime = () => {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
};

// ===== AUTH STATE =====
function buildAuthState(session) {
  const creds = session?.creds
    ? JSON.parse(JSON.stringify(session.creds), BufferJSON.reviver)
    : initAuthCreds();

  let keyStore = session?.keys
    ? JSON.parse(JSON.stringify(session.keys), BufferJSON.reviver)
    : {};

  return {
    creds,
    keys: {
      get: (type, ids) => {
        const data = {};
        ids.forEach(id => {
          if (keyStore[type]?.[id]) data[id] = keyStore[type][id];
        });
        return data;
      },
      set: (data) => {
        Object.keys(data).forEach(cat => {
          keyStore[cat] = keyStore[cat] || {};
          Object.assign(keyStore[cat], data[cat]);
        });
      }
    },
    getSnapshot: () => ({
      creds,
      keys: JSON.parse(JSON.stringify(keyStore, BufferJSON.replacer))
    })
  };
}

// ===== SESSION =====
async function loadSession() {
  const { data } = await supabase
    .from("wa_sessions")
    .select("auth_data")
    .eq("id", SESSION_ID)
    .maybeSingle();

  return data?.auth_data || null;
}

async function saveSession(state) {
  const snap = state.getSnapshot();
  await supabase.from("wa_sessions").upsert({
    id: SESSION_ID,
    auth_data: snap
  });
}

// ===== SETTINGS =====
async function getSettings(jid) {
  const { data } = await supabase
    .from("group_settings")
    .select("*")
    .eq("group_jid", jid)
    .maybeSingle();

  return data || {
    group_jid: jid,
    bot_active: true,
    anti_link: true,
    anti_vulgar: true
  };
}

async function updateSettings(jid, obj) {
  await supabase.from("group_settings").upsert({
    group_jid: jid,
    ...obj
  });
}

// ===== STRIKES =====
async function getStrikes(jid, user) {
  const { data } = await supabase
    .from("group_strikes")
    .select("strikes")
    .eq("group_jid", jid)
    .eq("user_jid", user)
    .maybeSingle();

  return data?.strikes || 0;
}

async function addStrike(jid, user) {
  const count = (await getStrikes(jid, user)) + 1;

  await supabase.from("group_strikes").upsert({
    group_jid: jid,
    user_jid: user,
    strikes: count,
    last_strike: new Date().toISOString()
  });

  return count;
}

async function resetStrike(jid, user) {
  await supabase.from("group_strikes")
    .delete()
    .eq("group_jid", jid)
    .eq("user_jid", user);
}

// ===== STRIKE ACTION =====
async function handleStrike(jid, user, reason) {
  const strikes = await addStrike(jid, user);

  if (strikes >= 3) {
    await sock.sendMessage(jid, {
      text: `🚫 @${user.split("@")[0]} removed (3/3 strikes: ${reason})`,
      mentions: [user]
    });

    await sock.groupParticipantsUpdate(jid, [user], "remove");
    await resetStrike(jid, user);
  } else {
    await sock.sendMessage(jid, {
      text: `⚠️ @${user.split("@")[0]} ${reason} (${strikes}/3)`,
      mentions: [user]
    });
  }
}

// ===== SCHEDULER =====
const fired = new Set();

setInterval(() => fired.clear(), 60000);

setInterval(async () => {
  if (!sock || botStatus !== "connected") return;

  const { data } = await supabase
    .from("group_scheduled_locks")
    .select("*");

  const now = getNigeriaTime();
  const hh = now.getHours();
  const mm = now.getMinutes();

  for (const row of data || []) {
    if (row.lock_time) {
      const [h, m] = row.lock_time.split(":").map(Number);
      const key = `${row.group_jid}_${h}_${m}`;

      if (h === hh && m === mm && !fired.has(key)) {
        fired.add(key);

        await sock.groupSettingUpdate(row.group_jid, "announcement");
        await sock.sendMessage(row.group_jid, {
          text: "🔒 Auto locked"
        });

        await supabase.from("group_scheduled_locks")
          .update({ lock_time: null })
          .eq("group_jid", row.group_jid);
      }
    }
  }
}, 60000);

// ===== BOT =====
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const session = await loadSession();

  const state = buildAuthState(session);

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: state.keys },
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", () => saveSession(state));

  sock.ev.on("connection.update", async ({ connection, qr }) => {
    if (qr) {
      currentQR = qr;
      botStatus = "qr";
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      currentQR = null;
      botStatus = "connected";
    }

    if (connection === "close") {
      setTimeout(startBot, 5000);
    }
  });

  // ===== CLEAN DB WHEN BOT REMOVED =====
  sock.ev.on("group-participants.update", async (u) => {
    if (u.action === "remove" && u.participants.includes(sock.user.id)) {
      await supabase.from("group_settings").delete().eq("group_jid", u.id);
      await supabase.from("group_strikes").delete().eq("group_jid", u.id);
      await supabase.from("group_scheduled_locks").delete().eq("group_jid", u.id);
    }
  });

  // ===== MESSAGES =====
  const cooldown = {};

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid.endsWith("@g.us")) return;

    const sender = msg.key.participant;
    const metadata = await sock.groupMetadata(jid);
    const admin = isAdmin(sender, metadata.participants);

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text || "";

    if (!text) return;

    const settings = await getSettings(jid);
    const cmd = text.toLowerCase().trim();

    // BOT CONTROL
    if (cmd === ".bot on" && admin) {
      await updateSettings(jid, { bot_active: true });
      return sock.sendMessage(jid, { text: "🤖 Bot ON" });
    }

    if (cmd === ".bot off" && admin) {
      await updateSettings(jid, { bot_active: false });
      return sock.sendMessage(jid, { text: "🤖 Bot OFF" });
    }

    if (!settings.bot_active && cmd !== ".bot on") {
      return;
    }

    // ANTI LINK
    if (!admin && settings.anti_link && /(https?:\/\/|wa\.me)/i.test(text)) {
      await sock.sendMessage(jid, { delete: msg.key });
      return handleStrike(jid, sender, "sent link");
    }

    // VULGAR
    if (!admin && settings.anti_vulgar) {
      if (VULGAR.some(w => normalize(text).includes(w))) {
        await sock.sendMessage(jid, { delete: msg.key });
        return handleStrike(jid, sender, "used vulgar word");
      }
    }

    // COMMAND COOLDOWN
    if (cooldown[sender] && Date.now() - cooldown[sender] < 3000) return;
    cooldown[sender] = Date.now();

    // COMMANDS
    if (!cmd.startsWith(".") || !admin) return;

    if (cmd === ".tagall") {
      const all = metadata.participants.map(p => p.id);
      await sock.sendMessage(jid, {
        text: "@all",
        mentions: all
      });
    }

    if (cmd.startsWith(".kick")) {
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      if (!ctx?.participant) return;

      await sock.groupParticipantsUpdate(jid, [ctx.participant], "remove");
    }
  });
}

// ===== WEB =====
app.get("/", async (req, res) => {
  let html = "";

  if (botStatus === "connected") {
    html = "<h1>✅ Connected</h1>";
  } else if (currentQR) {
    const qr = await QRCode.toDataURL(currentQR);
    html = `<img src="${qr}" width="250"/>`;
  } else {
    html = "<p>Loading QR...</p>";
  }

  res.send(`<html><body>${html}</body></html>`);
});

// ===== START =====
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  startBot();
});
