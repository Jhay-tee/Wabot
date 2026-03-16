import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON
} from "@whiskeysockets/baileys"

import qrcode from "qrcode-terminal"
import express from "express"
import { createClient } from "@supabase/supabase-js"

let sock
let botActive = true
let isStarting = false

// ---------------- SUPABASE ----------------

const SUPABASE_URL = "https://utuncywcoapsqudpovdt.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0dW5jeXdjb2Fwc3F1ZHBvdmR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NjM2NzMsImV4cCI6MjA4OTIzOTY3M30._wk8kY0hlLlAot66LraBaamz4N7b7juVV1T_mJwYyAU"

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const TABLE = "WA_sessions"

// ---------------- EXPRESS SERVER ----------------

const app = express()

app.get("/", (req, res) => {
  res.send("WhatsApp bot running")
})

app.listen(3000, () => {
  console.log("Server running on port 3000")
})

// ---------------- SESSION ----------------

async function loadSession() {

  const { data } = await supabase
    .from(TABLE)
    .select("auth_data")
    .limit(1)
    .single()

  if (!data?.auth_data) return null

  try {
    return JSON.parse(data.auth_data, BufferJSON.reviver)
  } catch {
    return null
  }
}

async function saveSession(creds) {

  await supabase
    .from(TABLE)
    .upsert({
      id: 1,
      auth_data: JSON.stringify(creds, BufferJSON.replacer),
      updated_at: new Date().toISOString()
    })
}

// ---------------- BOT ----------------

async function startBot() {

  if (isStarting) return
  isStarting = true

  console.log("Starting bot...")

  const { version } = await fetchLatestBaileysVersion()

  const { state, saveCreds } = await useMultiFileAuthState("auth")

  const saved = await loadSession()

  if (saved) {
    state.creds = saved
    console.log("Session restored from Supabase")
  }

  sock = makeWASocket({
    version,
    auth: state
  })

  sock.ev.on("creds.update", async () => {

    saveCreds()

    await saveSession(state.creds)

    console.log("Session saved to Supabase")
  })

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {

    if (qr) {
      console.log("Scan QR Code")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {

      console.log("Bot connected successfully")

      isStarting = false
    }

    if (connection === "close") {

      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      console.log("Connection closed")

      if (shouldReconnect) {

        console.log("Reconnecting in 3 seconds...")

        setTimeout(() => {
          isStarting = false
          startBot()
        }, 3000)
      }
    }
  })

  // ---------------- MESSAGE HANDLER ----------------

  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]

    if (!msg.message) return

    const chat = msg.key.remoteJid
    const sender = msg.key.participant

    // ignore DM
    if (!chat.endsWith("@g.us")) return

    const metadata = await sock.groupMetadata(chat)

    const isAdmin =
      metadata.participants.find(p => p.id === sender)?.admin

    if (!isAdmin) return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    const command = text.trim().split(" ")[0].toLowerCase()

    const mentioned =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []

    const quoted =
      msg.message?.extendedTextMessage?.contextInfo?.participant

    // bot disabled
    if (!botActive && command !== ".activate") return

    // ---------------- ACTIVATE ----------------

    if (command === ".activate") {

      botActive = true

      await sock.sendMessage(chat, {
        text: "Bot is now active. Automation for admin users enabled."
      })
    }

    // ---------------- DEACTIVATE ----------------

    if (command === ".deactivate") {

      botActive = false

      await sock.sendMessage(chat, {
        text: "Bot has been turned off."
      })
    }

    // ---------------- TAGALL ----------------

    if (command === ".tagall") {

      const members = metadata.participants.map(p => p.id)

      await sock.sendMessage(chat, {
        text: members.map(m => `@${m.split("@")[0]}`).join(" "),
        mentions: members
      })
    }

    // ---------------- KICK ----------------

    if (command === ".kick") {

      let targets = []

      if (mentioned.length) targets = mentioned
      else if (quoted) targets = [quoted]

      for (const user of targets) {

        const isTargetAdmin =
          metadata.participants.find(p => p.id === user)?.admin

        if (isTargetAdmin) continue

        await sock.groupParticipantsUpdate(chat, [user], "remove")

        await sock.sendMessage(chat, {
          text: "User has been removed from the group."
        })
      }
    }

    // ---------------- WARN ----------------

    if (command === ".warn") {

      let targets = []

      if (mentioned.length) targets = mentioned
      else if (quoted) targets = [quoted]

      if (!targets.length) return

      await sock.sendMessage(chat, {
        text: "⚠️ Warning issued",
        mentions: targets
      })
    }

    // ---------------- DELETE ----------------

    if (command === ".delete") {

      const context =
        msg.message?.extendedTextMessage?.contextInfo

      if (!context) return

      await sock.sendMessage(chat, {
        delete: {
          remoteJid: chat,
          fromMe: false,
          id: context.stanzaId,
          participant: context.participant
        }
      })
    }

    // ---------------- LOCK ----------------

    if (command === ".lock") {

      await sock.groupSettingUpdate(chat, "announcement")

      await sock.sendMessage(chat, {
        text: "This group has been locked."
      })
    }

    // ---------------- UNLOCK ----------------

    if (command === ".unlock") {

      await sock.groupSettingUpdate(chat, "not_announcement")

      await sock.sendMessage(chat, {
        text: "This group has been unlocked."
      })
    }

  })
}

startBot()
