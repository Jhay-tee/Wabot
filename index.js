import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

// -------- PROCESS-LEVEL ERROR GUARDS (prevent crashes) --------
process.on("uncaughtException", (err) => {
  console.log("❌ Uncaught Exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.log("❌ Unhandled Rejection:", reason?.message || reason);
});

// -------- CONFIG --------
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const VULGAR_WORDS = ["fuck", "nigga", "nigger", "bitch", "asshole", "shit"];

// -------- HELPERS --------
const delay = ms => new Promise(res => setTimeout(res, ms));

const isAdmin = (jid, participants) => {
  try {
    const user = participants.find(p => p.id === jid);
    return user && (user.admin === "admin" || user.admin === "superadmin");
  } catch {
    return false;
  }
};

const normalize = str => {
  try { return str.replace(/\s+/g, "").toLowerCase(); } catch { return ""; }
};

// Parse time strings like "8:00PM", "7:30AM", "8PM" → "HH:MM" (24h)
// Returns null for anything that doesn't match the strict pattern
function parseTimeTo24h(timeStr) {
  try {
    const cleaned = String(timeStr).trim();
    const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const period = match[3].toUpperCase();
    if (period === "PM" && hours !== 12) hours += 12;
    if (period === "AM" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

// Format "HH:MM" → "8:00 PM" for display
function formatTime24to12(hhmm) {
  try {
    const [hh, mm] = String(hhmm).split(":").map(Number);
    const period = hh >= 12 ? "PM" : "AM";
    const h = hh % 12 || 12;
    return `${h}:${String(mm).padStart(2, "0")} ${period}`;
  } catch {
    return hhmm;
  }
}

// -------- APP --------
const app = express();
let currentQR = null;
let botStatus = "starting";
let waVersion = null;
let sock = null;

// -------- SUPABASE --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// -------- DB HELPERS --------

async function getGroupSettings(groupJid) {
  try {
    const { data } = await supabase
      .from("group_settings")
      .select("*")
      .eq("group_jid", groupJid)
      .maybeSingle();
    return data || { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  } catch (e) {
    console.log("getGroupSettings error:", e?.message);
    return { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    await supabase.from("group_settings").upsert({ group_jid: groupJid, ...updates });
  } catch (e) {
    console.log("updateGroupSettings error:", e?.message);
  }
}

async function getStrikes(groupJid, userJid) {
  try {
    const { data } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .maybeSingle();
    return data?.strikes || 0;
  } catch (e) {
    console.log("getStrikes error:", e?.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  try {
    const current = await getStrikes(groupJid, userJid);
    const newCount = current + 1;
    await supabase.from("group_strikes").upsert({
      group_jid: groupJid,
      user_jid: userJid,
      strikes: newCount,
      last_strike: new Date().toISOString()
    });
    return newCount;
  } catch (e) {
    console.log("incrementStrike error:", e?.message);
    return 1;
  }
}

async function resetUserStrikes(groupJid, userJid) {
  try {
    await supabase.from("group_strikes")
      .delete()
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid);
  } catch (e) {
    console.log("resetUserStrikes error:", e?.message);
  }
}

async function getScheduledLock(groupJid) {
  try {
    const { data } = await supabase
      .from("group_scheduled_locks")
      .select("*")
      .eq("group_jid", groupJid)
      .maybeSingle();
    return data;
  } catch (e) {
    console.log("getScheduledLock error:", e?.message);
    return null;
  }
}

// Save lock_time — keeps unlock_time unchanged via upsert
async function setScheduledLockTime(groupJid, lockTime) {
  try {
    await supabase.from("group_scheduled_locks").upsert({
      group_jid: groupJid,
      lock_time: lockTime
    });
  } catch (e) {
    console.log("setScheduledLockTime error:", e?.message);
  }
}

// Save unlock_time — keeps lock_time unchanged via upsert
async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    await supabase.from("group_scheduled_locks").upsert({
      group_jid: groupJid,
      unlock_time: unlockTime
    });
  } catch (e) {
    console.log("setScheduledUnlockTime error:", e?.message);
  }
}

// Null out lock_time only (preserves unlock_time row)
async function clearLockTime(groupJid) {
  try {
    await supabase.from("group_scheduled_locks")
      .update({ lock_time: null })
      .eq("group_jid", groupJid);
  } catch (e) {
    console.log("clearLockTime error:", e?.message);
  }
}

// Null out unlock_time only (preserves lock_time row)
async function clearUnlockTime(groupJid) {
  try {
    await supabase.from("group_scheduled_locks")
      .update({ unlock_time: null })
      .eq("group_jid", groupJid);
  } catch (e) {
    console.log("clearUnlockTime error:", e?.message);
  }
}

// -------- STRIKE HANDLER --------
async function handleStrike(jid, sender, reason) {
  try {
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split("@")[0]}`;

    if (strikes >= 3) {
      try {
        await sock.sendMessage(jid, {
          text: `🚫 ${tag} has received *3/3 strikes* for ${reason} and has been *removed* from the group.`,
          mentions: [sender]
        });
      } catch {}
      try {
        await sock.groupParticipantsUpdate(jid, [sender], "remove");
      } catch (e) {
        console.log("Auto-kick error:", e?.message);
      }
      await resetUserStrikes(jid, sender);
    } else {
      try {
        await sock.sendMessage(jid, {
          text: `⚠️ Warning ${tag}: ${reason}.\nStrike *${strikes}/3* — at 3 strikes you will be removed.`,
          mentions: [sender]
        });
      } catch {}
    }
  } catch (e) {
    console.log("handleStrike error:", e?.message);
  }
}

// -------- WELCOME BATCH (5-second window) --------
const welcomeBuffers = {};

function scheduleWelcome(groupJid, participants, groupName) {
  try {
    if (!welcomeBuffers[groupJid]) {
      welcomeBuffers[groupJid] = { participants: [] };
    }
    welcomeBuffers[groupJid].participants.push(...participants);

    clearTimeout(welcomeBuffers[groupJid].timer);
    welcomeBuffers[groupJid].timer = setTimeout(async () => {
      try {
        const members = welcomeBuffers[groupJid]?.participants || [];
        delete welcomeBuffers[groupJid];
        if (!members.length || !sock) return;

        const mentionText = members.map(u => `@${u.split("@")[0]}`).join(", ");
        await sock.sendMessage(groupJid, {
          text: `👋 Welcome ${mentionText} to *${groupName}*! 🎉\n\n📋 *Group Rules:*\n• No spam\n• No links (unless admin)\n• No vulgar language\n\nEnjoy your stay and be respectful! 😊`,
          mentions: members
        });
      } catch (e) {
        console.log("Welcome send error:", e?.message);
      }
    }, 5000);
  } catch (e) {
    console.log("scheduleWelcome error:", e?.message);
  }
}

// -------- SCHEDULED LOCK / UNLOCK CHECKER --------
// Runs every 60 seconds. When a time fires it nulls out that column (one-time trigger).
const firedThisMinute = new Set();

function startScheduledLockChecker() {
  setInterval(async () => {
    try {
      if (!sock || botStatus !== "connected") return;

      const { data: rows, error } = await supabase
        .from("group_scheduled_locks")
        .select("group_jid, lock_time, unlock_time");

      if (error || !rows || rows.length === 0) return;

      const now = new Date();
      const currentHH = now.getHours();
      const currentMM = now.getMinutes();

      for (const row of rows) {
        // ---- Check lock_time ----
        if (row.lock_time) {
          const [lHH, lMM] = row.lock_time.split(":").map(Number);
          if (lHH === currentHH && lMM === currentMM) {
            const key = `lock_${row.group_jid}_${currentHH}_${currentMM}`;
            if (!firedThisMinute.has(key)) {
              firedThisMinute.add(key);
              setTimeout(() => firedThisMinute.delete(key), 65000);

              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (!meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔒 Group has been automatically locked at ${formatTime24to12(row.lock_time)}.`
                  });
                  console.log("✅ Scheduled lock fired for", row.group_jid);
                }
              } catch (e) {
                console.log("Scheduled lock execute error:", e?.message);
              }

              // Clear lock_time after firing (one-time)
              await clearLockTime(row.group_jid);
            }
          }
        }

        // ---- Check unlock_time ----
        if (row.unlock_time) {
          const [uHH, uMM] = row.unlock_time.split(":").map(Number);
          if (uHH === currentHH && uMM === currentMM) {
            const key = `unlock_${row.group_jid}_${currentHH}_${currentMM}`;
            if (!firedThisMinute.has(key)) {
              firedThisMinute.add(key);
              setTimeout(() => firedThisMinute.delete(key), 65000);

              try {
                const meta = await sock.groupMetadata(row.group_jid);
                if (meta.announce) {
                  await sock.groupSettingUpdate(row.group_jid, "not_announcement");
                  await sock.sendMessage(row.group_jid, {
                    text: `🔓 Group has been automatically unlocked at ${formatTime24to12(row.unlock_time)}.`
                  });
                  console.log("✅ Scheduled unlock fired for", row.group_jid);
                }
              } catch (e) {
                console.log("Scheduled unlock execute error:", e?.message);
              }

              // Clear unlock_time after firing (one-time)
              await clearUnlockTime(row.group_jid);
            }
          }
        }
      }
    } catch (e) {
      console.log("Scheduler error:", e?.message);
    }
  }, 60000);
}

// -------- SESSION VALIDATION --------
function isValidSession(session) {
  try {
    if (!session || !session.creds) return false;
    const hasRequired = !!(
      session.creds.me &&
      session.creds.noiseKey &&
      session.creds.signedIdentityKey &&
      session.creds.signedPreKey &&
      session.creds.advSecretKey
    );
    if (hasRequired) {
      console.log("✅ Session valid — connected as:", session.creds.me?.name || session.creds.me?.jid || "Unknown");
    } else {
      console.log("❌ Session missing required fields");
    }
    return hasRequired;
  } catch (e) {
    console.log("isValidSession error:", e?.message);
    return false;
  }
}

// -------- LOAD SESSION --------
async function loadSession() {
  try {
    console.log("🔍 Checking Supabase for existing session...");
    const { data, error } = await supabase
      .from(WA_TABLE)
      .select("auth_data")
      .eq("id", SESSION_ID)
      .maybeSingle();

    if (error) { console.log("❌ Supabase error:", error.message); return null; }
    if (!data?.auth_data) { console.log("📱 No session found — QR will generate"); return null; }

    console.log("📦 Session found, validating...");
    if (isValidSession(data.auth_data)) return data.auth_data;
    console.log("⚠️ Session corrupted — QR will generate");
    return null;
  } catch (err) {
    console.log("❌ Load session error:", err?.message);
    return null;
  }
}

// -------- SAVE SESSION --------
let saveTimer;
async function scheduleSave(snapshot) {
  try {
    if (!snapshot?.creds) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const serialized = JSON.parse(JSON.stringify(snapshot, BufferJSON.replacer));
        const { error } = await supabase.from(WA_TABLE).upsert({
          id: SESSION_ID,
          auth_data: serialized,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;
        console.log("💾 Session saved — as:", snapshot.creds.me?.name || "Unknown");
      } catch (err) {
        console.log("❌ Save error:", err?.message);
      }
    }, 1000);
  } catch (e) {
    console.log("scheduleSave error:", e?.message);
  }
}

// -------- CLEAR SESSION --------
async function clearSession() {
  try {
    const { error } = await supabase.from(WA_TABLE).upsert({
      id: SESSION_ID,
      auth_data: null,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    console.log("✅ Session cleared");
  } catch (err) {
    console.log("❌ Clear session error:", err?.message);
  }
}

// -------- WEB SERVER --------
app.get("/", async (req, res) => {
  try {
    let qrImage = "";
    if (currentQR && currentQR !== "Loading...") {
      try { qrImage = await QRCode.toDataURL(currentQR); } catch {}
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            min-height: 100vh; display: flex; justify-content: center;
            align-items: center; padding: 20px;
          }
          .card {
            background: white; border-radius: 20px; padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; width: 100%; text-align: center;
          }
          h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
          .subtitle { color: #666; margin-bottom: 30px; font-size: 16px; }
          .qr-container {
            background: #f5f5f5; border-radius: 15px; padding: 30px; margin-bottom: 20px;
            min-height: 200px; display: flex; justify-content: center; align-items: center;
          }
          .qr-image { max-width: 300px; width: 100%; height: auto; border-radius: 10px; }
          .loading { color: #666; font-size: 18px; }
          .connected-icon { font-size: 64px; }
          .steps { text-align: left; background: #f8f9fa; border-radius: 10px; padding: 20px; margin-top: 20px; }
          .steps h3 { color: #333; margin-bottom: 10px; }
          .steps ol { color: #555; padding-left: 20px; }
          .steps li { margin: 8px 0; }
          .status { margin-top: 15px; font-weight: 500; }
          .status.ok { color: #28a745; }
          .status.waiting { color: #f59e0b; }
          .force-btn {
            display: inline-block; background: #dc2626; color: white;
            text-decoration: none; padding: 10px 20px; border-radius: 5px;
            margin-top: 15px; font-size: 14px; border: none; cursor: pointer;
          }
          .force-btn:hover { background: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 WhatsApp Bot</h1>
          <p class="subtitle">${botStatus === "connected" ? "Bot is live and monitoring your groups" : "Scan QR code to connect your WhatsApp"}</p>

          <div class="qr-container">
            ${botStatus === "connected"
              ? '<div class="connected-icon">✅</div>'
              : qrImage
                ? `<img src="${qrImage}" class="qr-image" alt="QR Code">`
                : '<div class="loading">⏳ Generating QR Code...</div>'
            }
          </div>

          ${botStatus !== "connected" ? `
          <div class="steps">
            <h3>📱 How to connect:</h3>
            <ol>
              <li>Open WhatsApp on your phone</li>
              <li>Tap Menu (3 dots) or Settings</li>
              <li>Select "Linked Devices"</li>
              <li>Tap "Link a Device"</li>
              <li>Scan this QR code</li>
            </ol>
          </div>` : ""}

          <div class="status ${botStatus === "connected" ? "ok" : "waiting"}">
            ${botStatus === "connected" ? "✅ Bot is active and connected" : "⏳ Waiting for QR scan..."}
          </div>

          <a href="/force-qr" class="force-btn">🔄 Force New QR Code</a>
        </div>

        <script>
          // Only poll when not yet connected — stops automatically once connected
          const STATUS = '${botStatus}';
          if (STATUS !== 'connected') {
            let interval = setInterval(async () => {
              try {
                const res = await fetch('/status');
                const data = await res.json();
                // Reload only when something meaningful changes
                if (data.botStatus !== STATUS) {
                  clearInterval(interval);
                  location.reload();
                }
              } catch (e) {
                // Network hiccup — just wait for next tick
              }
            }, 3000);
          }
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    console.log("/ route error:", e?.message);
    res.status(500).send("Server error");
  }
});

app.get("/force-qr", async (req, res) => {
  try {
    console.log("\n🔄 FORCING NEW QR CODE\n");
    await clearSession();
    currentQR = null;
    botStatus = "starting";
    if (sock) { try { sock.end(); sock = null; } catch {} }
    setTimeout(() => startBot(), 1000);
    res.redirect("/");
  } catch (e) {
    console.log("/force-qr error:", e?.message);
    res.redirect("/");
  }
});

app.get("/health", (req, res) => {
  try {
    res.status(200).json({
      status: "ok",
      botStatus,
      uptime: Math.floor(process.uptime()),
      connected: botStatus === "connected"
    });
  } catch (e) {
    res.status(500).json({ status: "error" });
  }
});

app.get("/status", async (req, res) => {
  try {
    const session = await loadSession();
    res.json({
      botStatus,
      hasQR: !!currentQR,
      hasValidSession: !!session,
      uptime: Math.floor(process.uptime())
    });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

// -------- BUILD AUTH STATE --------
function buildAuthState(savedSession) {
  try {
    const creds = savedSession?.creds
      ? JSON.parse(JSON.stringify(savedSession.creds), BufferJSON.reviver)
      : initAuthCreds();

    let keyStore = {};
    if (savedSession?.keys) {
      try { keyStore = JSON.parse(JSON.stringify(savedSession.keys), BufferJSON.reviver); } catch {}
    }

    const keys = {
      get: (type, ids) => {
        try {
          const data = {};
          for (const id of ids) {
            const val = keyStore[type]?.[id];
            if (val !== undefined) data[id] = val;
          }
          return data;
        } catch { return {}; }
      },
      set: (data) => {
        try {
          for (const category of Object.keys(data)) {
            keyStore[category] = keyStore[category] || {};
            for (const id of Object.keys(data[category])) {
              const val = data[category][id];
              if (val == null) delete keyStore[category][id];
              else keyStore[category][id] = val;
            }
          }
        } catch {}
      }
    };

    const getSnapshot = () => ({
      creds,
      keys: JSON.parse(JSON.stringify(keyStore, BufferJSON.replacer))
    });

    return { creds, keys, getSnapshot };
  } catch (e) {
    console.log("buildAuthState error:", e?.message);
    const creds = initAuthCreds();
    const keys = { get: () => ({}), set: () => {} };
    return { creds, keys, getSnapshot: () => ({ creds, keys: {} }) };
  }
}

// -------- START BOT --------
async function startBot() {
  try {
    console.log("\n🚀🚀🚀 STARTING BOT 🚀🚀🚀\n");

    if (!waVersion) {
      console.log("📱 Fetching latest Baileys version...");
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version;
      console.log("✅ Using version:", waVersion);
    }

    const loadedSession = await loadSession();
    console.log(loadedSession ? "✅ Using existing session" : "🆕 Fresh start — QR will generate");

    const authState = buildAuthState(loadedSession);
    currentQR = "Loading...";

    if (sock) { try { sock.end(); sock = null; } catch {} }

    sock = makeWASocket({
      version: waVersion,
      auth: { creds: authState.creds, keys: authState.keys },
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on("creds.update", () => {
      try { scheduleSave(authState.getSnapshot()); } catch {}
    });

    // -------- CONNECTION UPDATES --------
    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      try {
        console.log("📡 Connection update:", { connection, hasQR: !!qr });

        if (qr) {
          console.log("\n✅ QR CODE GENERATED — scan with WhatsApp\n");
          currentQR = qr;
          botStatus = "awaiting_scan";
          try { qrcode.generate(qr, { small: true }); } catch {}
          return;
        }

        if (connection === "open") {
          console.log("\n✅✅✅ CONNECTED TO WHATSAPP ✅✅✅\n");
          currentQR = null;
          botStatus = "connected";
          try { await sock.sendPresenceUpdate("available"); } catch {}
          return;
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message;
          console.log("🔌 Connection closed:", code, errMsg);

          if (botStatus === "connected") { console.log("ℹ️ Ignoring close — already connected"); return; }

          if (code === DisconnectReason.loggedOut) {
            console.log("🚫 Logged out — clearing session");
            await clearSession();
            currentQR = null;
            setTimeout(() => startBot(), 2000);
            return;
          }

          console.log("🔄 Reconnecting in 5s...");
          setTimeout(() => startBot(), 5000);
        }
      } catch (e) {
        console.log("connection.update error:", e?.message);
      }
    });

    // -------- GROUP PARTICIPANTS UPDATE --------
    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { action, participants, id: groupJid } = update;

        // Welcome new members (batched, 5s window)
        const joinActions = ["add", "invite", "linked_group_join"];
        if (joinActions.includes(action) && participants?.length > 0) {
          try {
            const settings = await getGroupSettings(groupJid);
            if (settings.bot_active) {
              let groupName = "the group";
              try {
                const meta = await sock.groupMetadata(groupJid);
                groupName = meta.subject || "the group";
              } catch {}
              scheduleWelcome(groupJid, participants, groupName);
              console.log("👋 Welcome queued for", participants.length, "member(s)");
            }
          } catch (e) {
            console.log("Welcome queue error:", e?.message);
          }
        }

        // Reset strikes when user leaves or is removed
        if (action === "remove" || action === "leave") {
          for (const user of (participants || [])) {
            try { await resetUserStrikes(groupJid, user); } catch {}
          }
        }
      } catch (e) {
        console.log("group-participants.update error:", e?.message);
      }
    });

    // -------- MESSAGES & COMMANDS --------
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || !jid.endsWith("@g.us")) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;

        let metadata;
        try { metadata = await sock.groupMetadata(jid); } catch { return; }
        if (!metadata) return;

        const isUserAdmin = isAdmin(sender, metadata.participants);

        const text = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          ""
        ).trim();

        if (!text) return;

        const settings = await getGroupSettings(jid);
        const command = text.toLowerCase().trim();
        const isCommand = command.startsWith(".");

        // ---- .bot on / .bot off (admin-only, works even when bot is inactive) ----
        if (isCommand && isUserAdmin) {
          if (command === ".bot on") {
            await updateGroupSettings(jid, { bot_active: true });
            try { await sock.sendMessage(jid, { text: "🤖 Bot is now *active*. Automations are enabled." }); } catch {}
            return;
          }
          if (command === ".bot off") {
            await updateGroupSettings(jid, { bot_active: false });
            try { await sock.sendMessage(jid, { text: "🤖 Bot is now *inactive*. Automations are disabled." }); } catch {}
            return;
          }
        }

        // ---- Skip everything if bot is off and it's not a command ----
        if (!settings.bot_active && !isCommand) return;

        // ---- ANTI-VULGAR (non-admins only, when enabled) ----
        if (!isUserAdmin && settings.bot_active && settings.anti_vulgar) {
          const normalizedText = normalize(text);
          const hasVulgar = VULGAR_WORDS.some(word => normalizedText.includes(normalize(word)));
          if (hasVulgar) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
            } catch {}
            await handleStrike(jid, sender, "using vulgar language");
            return;
          }
        }

        // ---- ANTI-LINK (non-admins only, when enabled) ----
        if (!isUserAdmin && settings.bot_active && settings.anti_link) {
          const linkRegex = /(https?:\/\/\S+|wa\.me\/\S+|chat\.whatsapp\.com\/\S+)/i;
          if (linkRegex.test(text)) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
            } catch {}
            await handleStrike(jid, sender, "sending a link");
            return;
          }
        }

        // ---- All other commands: admins only ----
        if (!isCommand || !isUserAdmin) return;

        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;

        // =========================================================
        // .lock
        // =========================================================
        if (command === ".lock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (meta.announce) {
              await sock.sendMessage(jid, { text: "🔒 Group is already locked." });
              return;
            }
            await sock.groupSettingUpdate(jid, "announcement");
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: "🔒 Group has been locked. Any scheduled lock time has been cleared." });
          } catch (e) {
            console.log(".lock error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to lock the group. Please try again." }); } catch {}
          }

        } else if (command === ".lock clear") {
          try {
            await clearLockTime(jid);
            await sock.sendMessage(jid, { text: "🗑️ Scheduled lock time has been cleared. Group will not auto-lock." });
          } catch (e) {
            console.log(".lock clear error:", e?.message);
          }

        } else if (command.startsWith(".lock ")) {
          try {
            const timeArg = text.slice(6).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, {
                text: `❌ *"${timeArg}"* is not a valid time.\n\nPlease use the format: HH:MMAM/PM\nExamples: \`.lock 8:30PM\`, \`.lock 10AM\`, \`.lock 6:00AM\``
              });
              return;
            }
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `⏰ Group will automatically lock once at *${formatTime24to12(parsed)}*.\nUse \`.lock clear\` to cancel.`
            });
          } catch (e) {
            console.log(".lock [time] error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to set scheduled lock. Please try again." }); } catch {}
          }

        // =========================================================
        // .unlock
        // =========================================================
        } else if (command === ".unlock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (!meta.announce) {
              await sock.sendMessage(jid, { text: "🔓 Group is already unlocked." });
              return;
            }
            await sock.groupSettingUpdate(jid, "not_announcement");
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: "🔓 Group has been unlocked. Any scheduled unlock time has been cleared." });
          } catch (e) {
            console.log(".unlock error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to unlock the group. Please try again." }); } catch {}
          }

        } else if (command === ".unlock clear") {
          try {
            await clearUnlockTime(jid);
            await sock.sendMessage(jid, { text: "🗑️ Scheduled unlock time has been cleared. Group will not auto-unlock." });
          } catch (e) {
            console.log(".unlock clear error:", e?.message);
          }

        } else if (command.startsWith(".unlock ")) {
          try {
            const timeArg = text.slice(8).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, {
                text: `❌ *"${timeArg}"* is not a valid time.\n\nPlease use the format: HH:MMAM/PM\nExamples: \`.unlock 6:00AM\`, \`.unlock 7AM\`, \`.unlock 8:30AM\``
              });
              return;
            }
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `⏰ Group will automatically unlock once at *${formatTime24to12(parsed)}*.\nUse \`.unlock clear\` to cancel.`
            });
          } catch (e) {
            console.log(".unlock [time] error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to set scheduled unlock. Please try again." }); } catch {}
          }

        // =========================================================
        // .kick
        // =========================================================
        } else if (command.startsWith(".kick")) {
          try {
            const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
            if (!targets.length) {
              await sock.sendMessage(jid, { text: "❌ Tag someone or reply to their message with .kick" });
              return;
            }
            for (const user of targets) {
              try {
                const isTargetAdmin = metadata.participants.find(p => p.id === user)?.admin;
                if (isTargetAdmin) {
                  await sock.sendMessage(jid, { text: "❌ Cannot remove an admin." });
                  continue;
                }
                await sock.groupParticipantsUpdate(jid, [user], "remove");
                await sock.sendMessage(jid, {
                  text: `✅ @${user.split("@")[0]} has been removed.`,
                  mentions: [user]
                });
                await delay(500);
              } catch (e) {
                console.log(".kick user error:", e?.message);
                try {
                  await sock.sendMessage(jid, {
                    text: `❌ Failed to remove @${user.split("@")[0]}.`,
                    mentions: [user]
                  });
                } catch {}
              }
            }
          } catch (e) {
            console.log(".kick error:", e?.message);
          }

        // =========================================================
        // .strike reset @user
        // =========================================================
        } else if (command.startsWith(".strike reset")) {
          try {
            const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
            if (!targets.length) {
              await sock.sendMessage(jid, { text: "❌ Tag a user or reply to reset their strikes.\nUsage: `.strike reset @user`" });
              return;
            }
            for (const user of targets) {
              try {
                await resetUserStrikes(jid, user);
                await sock.sendMessage(jid, {
                  text: `✅ Strikes cleared for @${user.split("@")[0]}.`,
                  mentions: [user]
                });
              } catch (e) {
                console.log(".strike reset user error:", e?.message);
              }
            }
          } catch (e) {
            console.log(".strike reset error:", e?.message);
          }

        // =========================================================
        // .tagall
        // =========================================================
        } else if (command === ".tagall") {
          try {
            const allMembers = metadata.participants.map(p => p.id);
            const mentionText = allMembers.map(m => `@${m.split("@")[0]}`).join(" ");
            await sock.sendMessage(jid, { text: `📢 ${mentionText}`, mentions: allMembers });
          } catch (e) {
            console.log(".tagall error:", e?.message);
          }

        // =========================================================
        // .delete
        // =========================================================
        } else if (command === ".delete") {
          try {
            if (!ctx?.stanzaId) {
              await sock.sendMessage(jid, { text: "❌ Please reply to the message you want to delete." });
              return;
            }
            await sock.sendMessage(jid, {
              delete: { remoteJid: jid, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }
            });
          } catch (e) {
            console.log(".delete error:", e?.message);
          }

        // =========================================================
        // .antilink on/off
        // =========================================================
        } else if (command === ".antilink on") {
          try {
            await updateGroupSettings(jid, { anti_link: true });
            await sock.sendMessage(jid, { text: "✅ Anti-link is now *enabled*." });
          } catch (e) { console.log(".antilink on error:", e?.message); }

        } else if (command === ".antilink off") {
          try {
            await updateGroupSettings(jid, { anti_link: false });
            await sock.sendMessage(jid, { text: "✅ Anti-link is now *disabled*." });
          } catch (e) { console.log(".antilink off error:", e?.message); }

        // =========================================================
        // .antivulgar on/off
        // =========================================================
        } else if (command === ".antivulgar on") {
          try {
            await updateGroupSettings(jid, { anti_vulgar: true });
            await sock.sendMessage(jid, { text: "✅ Anti-vulgar is now *enabled*." });
          } catch (e) { console.log(".antivulgar on error:", e?.message); }

        } else if (command === ".antivulgar off") {
          try {
            await updateGroupSettings(jid, { anti_vulgar: false });
            await sock.sendMessage(jid, { text: "✅ Anti-vulgar is now *disabled*." });
          } catch (e) { console.log(".antivulgar off error:", e?.message); }

        // =========================================================
        // .help
        // =========================================================
        } else if (command === ".help") {
          try {
            const sched = await getScheduledLock(jid);
            const lockInfo = sched?.lock_time ? `\n⏰ Lock scheduled: ${formatTime24to12(sched.lock_time)}` : "";
            const unlockInfo = sched?.unlock_time ? `\n⏰ Unlock scheduled: ${formatTime24to12(sched.unlock_time)}` : "";

            await sock.sendMessage(jid, {
              text:
                `🤖 *Bot Commands (Admins Only)*\n\n` +
                `*🔒 Group Lock*\n` +
                `.lock — Lock group now & clear lock schedule\n` +
                `.lock 9:00PM — Schedule one-time auto-lock\n` +
                `.lock clear — Cancel scheduled lock\n` +
                `.unlock — Unlock group now & clear unlock schedule\n` +
                `.unlock 6:00AM — Schedule one-time auto-unlock\n` +
                `.unlock clear — Cancel scheduled unlock\n\n` +
                `*👥 Members*\n` +
                `.tagall — Mention all members\n` +
                `.kick @user — Remove user from group\n` +
                `.delete — Delete replied message\n\n` +
                `*⚠️ Strikes*\n` +
                `.strike reset @user — Clear a user's strikes\n\n` +
                `*⚙️ Automations*\n` +
                `.bot on / .bot off — Enable or disable bot\n` +
                `.antilink on / .antilink off — Toggle anti-link\n` +
                `.antivulgar on / .antivulgar off — Toggle anti-vulgar\n\n` +
                `*📊 Current Status*\n` +
                `Bot: ${settings.bot_active ? "🟢 Active" : "🔴 Inactive"}\n` +
                `Anti-Link: ${settings.anti_link ? "✅ On" : "❌ Off"}\n` +
                `Anti-Vulgar: ${settings.anti_vulgar ? "✅ On" : "❌ Off"}` +
                lockInfo + unlockInfo
            });
          } catch (e) {
            console.log(".help error:", e?.message);
          }
        }

      } catch (e) {
        console.log("messages.upsert error:", e?.message);
      }
    });

  } catch (err) {
    console.log("❌ startBot error:", err?.message);
    setTimeout(startBot, 5000);
  }
}
// -------- START SERVER --------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  console.log(`📱 Visit the URL to see the QR code\n`);
  startBot();
  startScheduledLockChecker();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`❌ Port ${PORT} is already in use. Retrying in 3 seconds...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT, "0.0.0.0");
    }, 3000);
  } else {
    console.log("❌ Server error:", err?.message);
  }
});

// -------- GRACEFUL SHUTDOWN --------
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received — shutting down gracefully...`);

  // 1. Stop accepting new HTTP connections
  server.close((err) => {
    if (err) console.log("Server close error:", err?.message);
    else console.log("✅ HTTP server closed");
  });

  // 2. Close the WhatsApp socket
  if (sock) {
    try {
      sock.end();
      console.log("✅ WhatsApp socket closed");
    } catch (e) {
      console.log("Socket close error:", e?.message);
    }
  }

  // 3. Give everything up to 5 seconds to finish, then force exit
  setTimeout(() => {
    console.log("⏱️ Forcing exit after timeout");
    process.exit(0);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
