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

// -------- ENVIRONMENT VALIDATION --------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

// -------- CONFIG --------
const PORT = process.env.PORT || 5000;
const SESSION_ID = 1;
const WA_TABLE = "wa_sessions";
const VULGAR_WORDS = ["fuck", "nigga", "nigger", "bitch", "asshole", "shit"];

// -------- TRACKERS --------
const spamTracker = {};
const commandCooldown = {};

// -------- SUPABASE WITH TIMEOUT & RETRY --------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false },
    global: {
      fetch: (url, options) => {
        // Increase timeout to 30 seconds
        return fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      }
    }
  }
);

// Helper to retry Supabase operations
async function supabaseRetry(operation, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err) {
      console.log(`Supabase retry ${i + 1}/${maxRetries} failed:`, err?.message);
      if (i === maxRetries - 1) throw err;
      await new Promise(res => setTimeout(res, 1000 * (i + 1))); // exponential backoff
    }
  }
}

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

// -------- DB HELPERS (with retry) --------

async function getGroupSettings(groupJid) {
  try {
    const { data } = await supabaseRetry(() =>
      supabase
        .from("group_settings")
        .select("*")
        .eq("group_jid", groupJid)
        .maybeSingle()
    );
    return data || { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  } catch (e) {
    console.log("getGroupSettings error:", e?.message);
    return { group_jid: groupJid, bot_active: true, anti_link: true, anti_vulgar: true };
  }
}

async function updateGroupSettings(groupJid, updates) {
  try {
    await supabaseRetry(() =>
      supabase.from("group_settings").upsert({ group_jid: groupJid, ...updates })
    );
  } catch (e) {
    console.log("updateGroupSettings error:", e?.message);
  }
}

// Insert default settings for a group only if no row exists yet (ignoreDuplicates = no overwrite)
async function ensureGroupSettings(groupJid, botJid) {
  try {
    await supabaseRetry(() =>
      supabase.from("group_settings").upsert(
        {
          group_jid: groupJid,
          bot_jid: botJid || null,
          bot_active: true,
          anti_link: true,
          anti_vulgar: true
        },
        { onConflict: "group_jid", ignoreDuplicates: true }
      )
    );
    console.log("✅ group_settings ensured for:", groupJid);
  } catch (e) {
    console.log("ensureGroupSettings error:", e?.message);
  }
}

// Ensure a row exists in group_scheduled_locks for the group (null times = nothing scheduled)
async function ensureGroupScheduledLocks(groupJid) {
  try {
    await supabaseRetry(() =>
      supabase.from("group_scheduled_locks").upsert(
        { group_jid: groupJid, lock_time: null, unlock_time: null },
        { onConflict: "group_jid", ignoreDuplicates: true }
      )
    );
    console.log("✅ group_scheduled_locks ensured for:", groupJid);
  } catch (e) {
    console.log("ensureGroupScheduledLocks error:", e?.message);
  }
}

// Provision default rows in all tables for every group the bot is currently admin in
async function provisionAllGroups() {
  try {
    if (!sock) return;
    const groups = await sock.groupFetchAllParticipating();
    const botJid = sock.user?.id;
    if (!botJid || !groups) return;
    const botNumber = botJid.split(":")[0]?.split("@")[0];
    let count = 0;
    for (const [groupJid, meta] of Object.entries(groups)) {
      const self = meta.participants?.find(p =>
        p.id.split("@")[0] === botNumber || p.id === botJid
      );
      if (self && (self.admin === "admin" || self.admin === "superadmin")) {
        await ensureGroupSettings(groupJid, botJid);
        await ensureGroupScheduledLocks(groupJid);
        count++;
      }
    }
    console.log(`✅ Provisioned ${count} group(s) across all tables`);
  } catch (e) {
    console.log("provisionAllGroups error:", e?.message);
  }
}

async function getStrikes(groupJid, userJid) {
  try {
    const { data } = await supabaseRetry(() =>
      supabase
        .from("group_strikes")
        .select("strikes")
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
        .maybeSingle()
    );
    return data?.strikes || 0;
  } catch (e) {
    console.log("getStrikes error:", e?.message);
    return 0;
  }
}

async function incrementStrike(groupJid, userJid) {
  try {
    // Get current strikes
    const { data, error } = await supabase
      .from("group_strikes")
      .select("strikes")
      .eq("group_jid", groupJid)
      .eq("user_jid", userJid)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error; // ignore "no rows found" error
    }

    let current = data?.strikes || 0;
    const newCount = current + 1;

    // Upsert with conflict target so it updates instead of inserting
    await supabaseRetry(() =>
      supabase.from("group_strikes").upsert({
        group_jid: groupJid,
        user_jid: userJid,
        strikes: newCount,
        last_strike: new Date().toISOString()
      }, { onConflict: ["group_jid", "user_jid"] })   // <-- important
    );

    console.log(`Strikes for ${userJid} in ${groupJid}: ${newCount}`);
    return newCount;
  } catch (e) {
    console.error("incrementStrike error:", e);
    return 1;
  }
}


async function resetUserStrikes(groupJid, userJid) {
  try {
    await supabaseRetry(() =>
      supabase
        .from("group_strikes")
        .delete()
        .eq("group_jid", groupJid)
        .eq("user_jid", userJid)
    );
  } catch (e) {
    console.log("resetUserStrikes error:", e?.message);
  }
}

async function getScheduledLock(groupJid) {
  try {
    const { data } = await supabaseRetry(() =>
      supabase
        .from("group_scheduled_locks")
        .select("*")
        .eq("group_jid", groupJid)
        .maybeSingle()
    );
    return data;
  } catch (e) {
    console.log("getScheduledLock error:", e?.message);
    return null;
  }
}

async function setScheduledLockTime(groupJid, lockTime) {
  try {
    await supabaseRetry(() =>
      supabase.from("group_scheduled_locks").upsert({
        group_jid: groupJid,
        lock_time: lockTime
      })
    );
  } catch (e) {
    console.log("setScheduledLockTime error:", e?.message);
  }
}

async function setScheduledUnlockTime(groupJid, unlockTime) {
  try {
    await supabaseRetry(() =>
      supabase.from("group_scheduled_locks").upsert({
        group_jid: groupJid,
        unlock_time: unlockTime
      })
    );
  } catch (e) {
    console.log("setScheduledUnlockTime error:", e?.message);
  }
}

async function clearLockTime(groupJid) {
  try {
    await supabaseRetry(() =>
      supabase
        .from("group_scheduled_locks")
        .update({ lock_time: null })
        .eq("group_jid", groupJid)
    );
  } catch (e) {
    console.log("clearLockTime error:", e?.message);
  }
}

async function clearUnlockTime(groupJid) {
  try {
    await supabaseRetry(() =>
      supabase
        .from("group_scheduled_locks")
        .update({ unlock_time: null })
        .eq("group_jid", groupJid)
    );
  } catch (e) {
    console.log("clearUnlockTime error:", e?.message);
  }
}

// -------- STRIKE HANDLER --------
async function handleStrike(jid, sender, reason) {
  try {
    // Increment strike count in Supabase (or your DB)
    const strikes = await incrementStrike(jid, sender);
    const tag = `@${sender.split("@")[0]}`;

    if (strikes >= 3) {
      // Final strike: remove user
      try {
        await sock.sendMessage(jid, {
          text: `⛔ ${tag} has received *3/3 strikes* for ${reason} and has been *removed* from the group.`,
          mentions: [sender]
        });
      } catch (e) {
        console.error("Strike message error:", e);
      }

      try {
        await sock.groupParticipantsUpdate(jid, [sender], "remove");
      } catch (e) {
        console.error("Auto-kick error:", e?.message);
      }

      // Reset strikes after removal
      await resetUserStrikes(jid, sender);

    } else {
      // Warning message for strike 1 or 2
      try {
        await sock.sendMessage(jid, {
          text: `⚠️ Warning ${tag}: ${reason}.\nStrike *${strikes}/3* — at 3 strikes you will be removed.`,
          mentions: [sender]
        });
      } catch (e) {
        console.error("Warning message error:", e);
      }
    }
  } catch (e) {
    console.error("handleStrike error:", e);
  }
}


// -------- WELCOME BATCH (5-second window) --------
const welcomeBuffers = {};

function scheduleWelcome(groupJid, participants, groupName) {
  try {
    // Ensure participants is an array of valid JIDs
    if (!Array.isArray(participants)) {
      console.log("scheduleWelcome: participants is not an array", participants);
      return;
    }

    const validParticipants = participants.filter(
      p => typeof p === "string" && p.includes("@s.whatsapp.net")
    );
    if (validParticipants.length === 0) return;

    // Initialize buffer if not present
    if (!welcomeBuffers[groupJid]) {
      welcomeBuffers[groupJid] = { participants: [], timer: null };
    }

    // Add new participants to buffer
    welcomeBuffers[groupJid].participants.push(...validParticipants);

    // Reset timer for batching
    if (welcomeBuffers[groupJid].timer) {
      clearTimeout(welcomeBuffers[groupJid].timer);
    }

    welcomeBuffers[groupJid].timer = setTimeout(async () => {
      try {
        const members = welcomeBuffers[groupJid]?.participants || [];
        delete welcomeBuffers[groupJid]; // clear buffer

        if (!members.length || !sock) return;

        const mentionText = members.map(u => `@${u.split("@")[0]}`).join(", ");
        await sock.sendMessage(groupJid, {
          text: `👋 Welcome ${mentionText} to *${groupName}*! \n\n📜 *Group Rules:*\n• No spam\n• No links (unless admin)\n• No vulgar language\n\nEnjoy your stay and be respectful! ✨`,
          mentions: members
        });

        console.log("✅ Welcome message sent to:", members);
      } catch (e) {
        console.error("Welcome send error:", e);
      }
    }, 5000);
  } catch (e) {
    console.error("scheduleWelcome error:", e);
  }
}


// -------- SCHEDULED LOCK / UNLOCK CHECKER --------
const firedThisMinute = new Set();

function startScheduledLockChecker() {
  setInterval(async () => {
    try {
      if (!sock || botStatus !== "connected") return;

      const { data: rows, error } = await supabaseRetry(() =>
        supabase
          .from("group_scheduled_locks")
          .select("group_jid, lock_time, unlock_time")
      );

      if (error || !rows || rows.length === 0) return;

      const now = new Date();
      const currentHH = now.getHours();
      const currentMM = now.getMinutes();

      for (const row of rows) {
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

              await clearLockTime(row.group_jid);
            }
          }
        }

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

// -------- MEMORY CLEANUP --------
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of Object.entries(spamTracker)) {
    if (now - value.time > 24 * 60 * 60 * 1000) delete spamTracker[key];
  }
  for (const [key, time] of Object.entries(commandCooldown)) {
    if (now - time > 60 * 60 * 1000) delete commandCooldown[key];
  }
}, 60 * 60 * 1000);

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
// Returns: { session: <data> } | { session: null, notFound: true } | { session: null, dbError: true }
async function loadSession() {
  try {
    console.log("🔍 Checking Supabase for existing session...");
    const { data, error } = await supabaseRetry(() =>
      supabase
        .from(WA_TABLE)
        .select("auth_data")
        .eq("id", SESSION_ID)
        .maybeSingle()
    );

    if (error) {
      console.log("❌ Supabase error:", error.message);
      return { session: null, dbError: true };
    }
    if (!data?.auth_data) {
      console.log("📱 No session found — QR will generate");
      return { session: null, notFound: true };
    }

    console.log("📦 Session found, validating...");
    if (isValidSession(data.auth_data)) return { session: data.auth_data };
    console.log("⚠️ Session corrupted — QR will generate");
    return { session: null, notFound: true };
  } catch (err) {
    console.log("❌ Load session error:", err?.message);
    return { session: null, dbError: true };
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
        await supabaseRetry(() =>
          supabase.from(WA_TABLE).upsert({
            id: SESSION_ID,
            auth_data: serialized,
            updated_at: new Date().toISOString()
          })
        );
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
    await supabaseRetry(() =>
      supabase.from(WA_TABLE).upsert({
        id: SESSION_ID,
        auth_data: null,
        updated_at: new Date().toISOString()
      })
    );
    console.log("🗑️ Session cleared");
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

          <div class="qr-container" id="qrContainer">
            ${botStatus === "connected"
              ? '<div class="connected-icon">✅</div>'
              : qrImage
                ? `<img src="${qrImage}" class="qr-image" alt="QR Code">`
                : '<div class="loading">⏳ Generating QR Code...</div>'
            }
          </div>

          ${botStatus !== "connected" ? `
          <div class="steps" id="steps">
            <h3>📱 How to connect:</h3>
            <ol>
              <li>Open WhatsApp on your phone</li>
              <li>Tap Menu (3 dots) or Settings</li>
              <li>Select "Linked Devices"</li>
              <li>Tap "Link a Device"</li>
              <li>Scan this QR code</li>
            </ol>
          </div>` : ""}

          <div class="status ${botStatus === "connected" ? "ok" : "waiting"}" id="statusText">
            ${botStatus === "connected" ? "✅ Bot is active and connected" : "⏳ Waiting for QR scan..."}
          </div>

          <a href="/force-qr" class="force-btn">🔄 Force New QR Code</a>
        </div>
      </body>
      <script>
        (function() {
          var pollInterval = null;
          function poll() {
            fetch('/qr-status')
              .then(function(r) { return r.json(); })
              .then(function(d) {
                var container = document.getElementById('qrContainer');
                var statusEl = document.getElementById('statusText');
                var steps = document.getElementById('steps');
                if (d.connected) {
                  container.innerHTML = '<div class="connected-icon">✅</div>';
                  statusEl.textContent = '✅ Bot is active and connected';
                  statusEl.className = 'status ok';
                  if (steps) steps.style.display = 'none';
                  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                } else if (d.qrImage) {
                  container.innerHTML = '<img src="' + d.qrImage + '" class="qr-image" alt="QR Code">';
                  statusEl.textContent = '⏳ Waiting for QR scan...';
                  statusEl.className = 'status waiting';
                } else {
                  container.innerHTML = '<div class="loading">⏳ Generating QR Code...</div>';
                  statusEl.textContent = '⏳ Generating QR Code...';
                  statusEl.className = 'status waiting';
                }
              })
              .catch(function() {});
          }
          pollInterval = setInterval(poll, 3000);
          poll();
        })();
      </script>
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
    scheduleReconnect(1000);
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
    res.json({
      botStatus,
      hasQR: !!currentQR,
      uptime: Math.floor(process.uptime())
    });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  }
});

app.get("/qr-status", async (req, res) => {
  try {
    const connected = botStatus === "connected";
    let qrImage = null;
    if (!connected && currentQR && currentQR !== "Loading...") {
      try { qrImage = await QRCode.toDataURL(currentQR); } catch {}
    }
    res.json({ connected, qrImage });
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
let isStarting = false;
let reconnectTimer = null;

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, delayMs);
}

async function startBot() {
  if (isStarting) {
    console.log("⏳ Bot already starting, skipping...");
    return;
  }
  isStarting = true;

  try {
    console.log("\n🚀 STARTING BOT 🚀\n");

    if (!waVersion) {
      console.log("📱 Fetching latest Baileys version...");
      const { version } = await fetchLatestBaileysVersion();
      waVersion = version;
      console.log("✅ Using version:", waVersion);
    }

    const result = await loadSession();

    if (result.dbError) {
      console.log("⚠️ Supabase unavailable — retrying in 10s...");
      scheduleReconnect(10000);
      return;
    }

    const loadedSession = result.session;
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

    sock.ev.on("error", (err) => {
      console.log("💥 Socket error:", err?.message);
    });

    sock.ev.on("creds.update", () => {
      try { scheduleSave(authState.getSnapshot()); } catch {}
    });

    sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      try {
        console.log("📡 Connection update:", { connection, hasQR: !!qr });

        if (qr) {
          console.log("\n✅✅✅ QR CODE GENERATED — scan with WhatsApp\n");
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
          // Provision default settings for all groups bot is admin in
          setTimeout(() => provisionAllGroups(), 3000);
          return;
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message;
          console.log("🔌 Connection closed:", code, errMsg);

          if (botStatus === "connected") {
            botStatus = "reconnecting";
          }

          if (code === DisconnectReason.loggedOut) {
            console.log("🚫 Logged out — clearing session");
            await clearSession();
            currentQR = null;
            botStatus = "starting";
            scheduleReconnect(2000);
            return;
          }

          console.log("🔄 Reconnecting in 5s...");
          scheduleReconnect(5000);
        }
      } catch (e) {
        console.log("connection.update error:", e?.message);
      }
    });

    sock.ev.on("group-participants.update", async (update) => {
      try {
        const { action, participants, id: groupJid } = update;
        const botJid = sock.user?.id;
        const botNumber = botJid?.split(":")[0]?.split("@")[0];

        const joinActions = ["add", "invite", "linked_group_join", "promote"];

        // If the bot itself was added or promoted to admin in a group, provision settings
        if (joinActions.includes(action) && participants?.some(p => {
          const pNum = p.split ? p.split("@")[0] : p?.id?.split("@")[0];
          return pNum === botNumber;
        })) {
          try {
            // Small delay to let WhatsApp register the bot's role
            await new Promise(res => setTimeout(res, 2000));
            const meta = await sock.groupMetadata(groupJid);
            const self = meta.participants?.find(p => p.id.split("@")[0] === botNumber);
            if (self && (self.admin === "admin" || self.admin === "superadmin")) {
              await ensureGroupSettings(groupJid, botJid);
              await ensureGroupScheduledLocks(groupJid);
              console.log("✅ Auto-provisioned all tables for new group:", groupJid);
            }
          } catch (e) {
            console.log("Auto-provision error:", e?.message);
          }
        }

        // Welcome new human members
        const memberJoinActions = ["add", "invite", "linked_group_join"];
        const humanParticipants = (participants || []).filter(p => {
          const pNum = (p.split ? p.split("@")[0] : p?.id?.split("@")[0]) || "";
          return pNum !== botNumber;
        });

        if (memberJoinActions.includes(action) && humanParticipants.length > 0) {
          try {
            const settings = await getGroupSettings(groupJid);
            if (settings.bot_active) {
              let groupName = "the group";
              try {
                const meta = await sock.groupMetadata(groupJid);
                groupName = meta.subject || "the group";
              } catch {}
              scheduleWelcome(groupJid, humanParticipants, groupName);
              console.log("👋 Welcome queued for", humanParticipants.length, "member(s)");
            }
          } catch (e) {
            console.log("Welcome queue error:", e?.message);
          }
        }

        if (action === "remove" || action === "leave") {
          for (const user of (participants || [])) {
            try { await resetUserStrikes(groupJid, user); } catch {}
          }
        }
      } catch (e) {
        console.log("group-participants.update error:", e?.message);
      }
    });

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

        // Safely extract text
        let text = "";
        try {
          text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            ""
          ).trim();
        } catch {
          text = "";
        }
        if (!text) return;

        const settings = await getGroupSettings(jid);
        const command = text.toLowerCase().trim();
        const isCommand = command.startsWith(".");

        // .bot on / .bot off (even when inactive)
        if (isCommand && isUserAdmin) {
          if (command === ".bot on") {
            await updateGroupSettings(jid, { bot_active: true });
            try { await sock.sendMessage(jid, { text: "✅ Bot is now *active*. Automations are enabled." }); } catch {}
            return;
          }
          if (command === ".bot off") {
            await updateGroupSettings(jid, { bot_active: false });
            try { await sock.sendMessage(jid, { text: "⏸️ Bot is now *inactive*. Automations are disabled." }); } catch {}
            return;
          }
        }

        // If bot inactive and command (but not .bot on) → warn
        if (!settings.bot_active && isCommand && isUserAdmin && command !== ".bot on") {
          try {
            await sock.sendMessage(jid, { text: "⚠️ Bot is currently deactivated. Use `.bot on` to activate." });
          } catch {}
          return;
        }

        // Skip non-commands when bot off
        if (!settings.bot_active && !isCommand) return;

        // Anti-vulgar (delete + warning only, no strike)
        if (settings.bot_active && settings.anti_vulgar) {
          const normalizedText = normalize(text);
          const hasVulgar = VULGAR_WORDS.some(word => normalizedText.includes(normalize(word)));
          if (hasVulgar) {
            try {
              await sock.sendMessage(jid, {
                delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: sender }
              });
            } catch {}
            try {
              await sock.sendMessage(jid, {
                text: `⚠️ @${sender.split("@")[0]}, vulgar language is not allowed in this group. Please be respectful.`,
                mentions: [sender]
              });
            } catch {}
            return;
          }
        }

        // Anti-link
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

        // Admin commands only beyond this point
        if (!isCommand || !isUserAdmin) return;

        const ctx = msg.message?.extendedTextMessage?.contextInfo || {};
        const mentioned = ctx.mentionedJid || [];
        const replyTarget = ctx.participant;

        // .lock
        if (command === ".lock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (meta.announce) {
              // Already locked – do nothing
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
            await sock.sendMessage(jid, { text: "🔓 Scheduled lock time has been cleared. Group will not auto-lock." });
          } catch (e) {
            console.log(".lock clear error:", e?.message);
          }
        } else if (command.startsWith(".lock ")) {
          try {
            const timeArg = text.slice(6).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, {
                text: `❌ *"${timeArg}"* is not a valid time.\n\nUse format: HH:MMAM/PM\nExamples: \`.lock 8:30PM\`, \`.lock 10AM\`, \`.lock 6:00AM\``
              });
              return;
            }
            await setScheduledLockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `🔒 Group will automatically lock once at *${formatTime24to12(parsed)}*.\nUse \`.lock clear\` to cancel.`
            });
          } catch (e) {
            console.log(".lock [time] error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to set scheduled lock. Please try again." }); } catch {}
          }

        // .unlock
        } else if (command === ".unlock") {
          try {
            const meta = await sock.groupMetadata(jid);
            if (!meta.announce) {
              return; // already unlocked, no reply
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
            await sock.sendMessage(jid, { text: "🔒 Scheduled unlock time has been cleared. Group will not auto-unlock." });
          } catch (e) {
            console.log(".unlock clear error:", e?.message);
          }
        } else if (command.startsWith(".unlock ")) {
          try {
            const timeArg = text.slice(8).trim();
            const parsed = parseTimeTo24h(timeArg);
            if (!parsed) {
              await sock.sendMessage(jid, {
                text: `❌ *"${timeArg}"* is not a valid time.\n\nUse format: HH:MMAM/PM\nExamples: \`.unlock 6:00AM\`, \`.unlock 7AM\`, \`.unlock 8:30AM\``
              });
              return;
            }
            await setScheduledUnlockTime(jid, parsed);
            await sock.sendMessage(jid, {
              text: `🔓 Group will automatically unlock once at *${formatTime24to12(parsed)}*.\nUse \`.unlock clear\` to cancel.`
            });
          } catch (e) {
            console.log(".unlock [time] error:", e?.message);
            try { await sock.sendMessage(jid, { text: "❌ Failed to set scheduled unlock. Please try again." }); } catch {}
          }

        // .kick
        } else if (command.startsWith(".kick")) {
          try {
            const targets = mentioned.length ? mentioned : replyTarget ? [replyTarget] : [];
            if (!targets.length) {
              await sock.sendMessage(jid, { text: "❌ Tag someone or reply to their message with .kick" });
              return;
            }
            for (const user of targets) {
              const userExists = metadata.participants.some(p => p.id === user);
              if (!userExists) {
                await sock.sendMessage(jid, {
                  text: `❌ User @${user.split("@")[0]} is not in this group.`,
                  mentions: [user]
                });
                continue;
              }
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

        // .strike reset
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

        // .tagall
        } else if (command === ".tagall") {
          try {
            const allMembers = metadata.participants.map(p => p.id);
            const mentionText = allMembers.map(m => `@${m.split("@")[0]}`).join(" ");
            await sock.sendMessage(jid, { text: `📢 ${mentionText}`, mentions: allMembers });
          } catch (e) {
            console.log(".tagall error:", e?.message);
          }

        // .delete
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

        // .antilink on/off
        } else if (command === ".antilink on") {
          try {
            await updateGroupSettings(jid, { anti_link: true });
            await sock.sendMessage(jid, { text: "🔗 Anti-link is now *enabled*." });
          } catch (e) { console.log(".antilink on error:", e?.message); }
        } else if (command === ".antilink off") {
          try {
            await updateGroupSettings(jid, { anti_link: false });
            await sock.sendMessage(jid, { text: "🔗 Anti-link is now *disabled*." });
          } catch (e) { console.log(".antilink off error:", e?.message); }

        // .antivulgar on/off
        } else if (command === ".antivulgar on") {
          try {
            await updateGroupSettings(jid, { anti_vulgar: true });
            await sock.sendMessage(jid, { text: "🔞 Anti-vulgar is now *enabled*." });
          } catch (e) { console.log(".antivulgar on error:", e?.message); }
        } else if (command === ".antivulgar off") {
          try {
            await updateGroupSettings(jid, { anti_vulgar: false });
            await sock.sendMessage(jid, { text: "🔞 Anti-vulgar is now *disabled*." });
          } catch (e) { console.log(".antivulgar off error:", e?.message); }

        // .help
        } else if (command === ".help") {
          try {
            const sched = await getScheduledLock(jid);
            const lockInfo = sched?.lock_time ? `\n🔒 Lock scheduled: ${formatTime24to12(sched.lock_time)}` : "";
            const unlockInfo = sched?.unlock_time ? `\n🔓 Unlock scheduled: ${formatTime24to12(sched.unlock_time)}` : "";

            await sock.sendMessage(jid, {
              text:
                `📋 *Bot Commands (Admins Only)*\n\n` +
                `🔒 *Group Lock*\n` +
                `.lock — Lock group now & clear lock schedule\n` +
                `.lock 9:00PM — Schedule one-time auto-lock\n` +
                `.lock clear — Cancel scheduled lock\n` +
                `.unlock — Unlock group now & clear unlock schedule\n` +
                `.unlock 6:00AM — Schedule one-time auto-unlock\n` +
                `.unlock clear — Cancel scheduled unlock\n\n` +
                `👥 *Members*\n` +
                `.tagall — Mention all members\n` +
                `.kick @user — Remove user from group\n` +
                `.delete — Delete replied message\n\n` +
                `⚡ *Strikes*\n` +
                `.strike reset @user — Clear a user's strikes\n\n` +
                `⚙️ *Automations*\n` +
                `.bot on / .bot off — Enable or disable bot\n` +
                `.antilink on / .antilink off — Toggle anti-link\n` +
                `.antivulgar on / .antivulgar off — Toggle anti-vulgar\n\n` +
                `📊 *Current Status*\n` +
                `Bot: ${settings.bot_active ? "✅ Active" : "⏸️ Inactive"}\n` +
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
    scheduleReconnect(5000);
  } finally {
    isStarting = false;
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
    console.log(`⚠️ Port ${PORT} is already in use. Exiting...`);
    process.exit(1);
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

  server.close((err) => {
    if (err) console.log("Server close error:", err?.message);
    else console.log("✅ HTTP server closed");
  });

  if (sock) {
    try {
      sock.end();
      console.log("✅ WhatsApp socket closed");
    } catch (e) {
      console.log("Socket close error:", e?.message);
    }
  }

  setTimeout(() => {
    console.log("⏱️ Forcing exit after timeout");
    process.exit(0);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
