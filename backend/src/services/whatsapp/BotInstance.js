/**
 * BotInstance — manages a single WhatsApp bot via @whiskeysockets/baileys.
 *
 * Features:
 *  - Bot type routing: dm | group | all
 *  - All WhatsApp message format extraction
 *  - Default commands (/help /catalog /price /contact /stop /agent /hours /order)
 *  - Group management commands (.help .kick .ban .lock .unlock .promote .demote
 *    .warn .warnings .clearwarn .tagall) — require bot + sender to be admin
 *  - Group moderation: anti-link, anti-spam, anti-vulgar (word filter)
 *  - 3-strike auto-removal system
 *  - First-DM auto-help (send /help menu on first contact)
 *  - Keyword triggers with exact/partial/regex match
 *  - Sales agent: product catalog, greeting, "not available" fallback
 *  - AI integration: OpenAI, Gemini
 *  - Webhook forwarding with HMAC signature
 *  - Auto-reconnect on transient disconnects
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
} from "@whiskeysockets/baileys";
import { Boom }          from "@hapi/boom";
import QRCode            from "qrcode";
// ✅ FIX: top-level import instead of dynamic import inside _sendWebhook (performance)
import { createHmac }    from "node:crypto";
import { createSupabaseAuthState, clearSupabaseSession, flushSupabaseAuthState } from "./SupabaseStore.js";
import { MessageQueue }  from "./MessageQueue.js";
import { normalizeRuntimeBotConfig, normalizeRuntimeBotConfigPatch } from "./configNormalization.js";
import { supabase }      from "../../lib/supabase.js";
import { logger }        from "../../utils/logger.js";
import { env }           from "../../config/env.js";
import { getAiCompletion, decryptApiKey } from "../ai/AiService.js";
import { sanitizeUserPrompt, buildSystemBlock, redactForLogs } from "../ai/PromptCompiler.js";
import { compilePrompt } from "../ai/PromptEngine.js";

const PLAN_MSG_LIMITS = { free: 1_000, paid: 100_000 };

/* ── Default built-in DM commands ───────────────────────────── */
const DEFAULT_COMMANDS = {
  help:    { trigger: "/help",    proOnly: false },
  catalog: { trigger: "/catalog", proOnly: false },
  price:   { trigger: "/price",   proOnly: false },
  contact: { trigger: "/contact", proOnly: false },
  stop:    { trigger: "/stop",    proOnly: false },
  agent:   { trigger: "/agent",   proOnly: false },
  hours:   { trigger: "/hours",   proOnly: false },
  order:   { trigger: "/order",   proOnly: false }
};

/* ── Group management commands (dot-prefix) ─────────────────── */
const GROUP_COMMANDS = [
  ".help", ".kick", ".ban", ".lock", ".unlock",
  ".promote", ".demote", ".warn", ".warnings", ".clearwarn",
  ".tagall", ".rules", ".admins"
];

/* ── Link / invite detection regex ─────────────────────────── */
const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+|bit\.ly\/[^\s]+)/i;

/* ── Group metadata cache TTL (ms) ─────────────────────────── */
const META_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/* ── Reconnect / QR lifecycle constants ─────────────────────── */
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS      = 2_000;
const RECONNECT_MAX_MS       = 30_000;
const QR_TIMEOUT_MS          = 2 * 60_000; // 2 minutes — then stop to avoid ban
const DEFAULT_REPLY_DELAY_WINDOW_MS = { min: 1_000, max: 12_000 };
const RECENT_MESSAGE_TTL_MS = 10 * 60_000;
const RECENT_AI_JOB_TTL_MS = 10 * 60_000;
const AI_JOB_STALE_MS = 2 * 60_000;
const AI_JOB_MAX_QUEUE_SIZE = 100;
const AI_MAX_CONCURRENCY = 1;
const AI_TYPING_REFRESH_MS = 4_500;
const AI_MEMORY_FETCH_LIMIT = 24;
const AI_MEMORY_LINE_MAX_CHARS = 240;
const AI_RECENT_TURNS_LIMIT = 8;
const AI_SUMMARY_MAX_CHARS = 1_800;
const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 1_250;
const QR_AUTH_STATUSES = new Set(["awaiting_qr", "awaiting_qr_scan", "qr_generated"]);
const PAIRING_AUTH_STATUSES = new Set(["awaiting_code", "awaiting_pairing", "code_generated", "awaiting_link"]);

/* ── Normalise device-scoped JID to plain user JID ─────────── */
function normalizeJid(jid = "") {
  return jid.replace(/:\d+@/, "@").toLowerCase();
}

function isGroupJid(jid = "") {
  return normalizeJid(jid).endsWith("@g.us");
}

function isBroadcastJid(jid = "") {
  const normalized = normalizeJid(jid);
  return normalized.endsWith("@broadcast") || normalized === "status@broadcast";
}

function isDirectJid(jid = "") {
  const normalized = normalizeJid(jid);
  return normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@lid");
}

function isSameWhatsAppAccount(a = "", b = "") {
  const left = normalizeJid(a);
  const right = normalizeJid(b);
  if (!left || !right) return false;
  return left === right || left.split("@")[0] === right.split("@")[0];
}

function toTargetJid(value = "") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return normalizeJid(raw);
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}

function buildConversationId({ botId, chatJid, senderJid, isGroup }) {
  const scope = isGroup ? normalizeJid(chatJid) : normalizeJid(senderJid || chatJid);
  return `${botId}:${scope}`;
}

function extractPreview(payload) {
  if (typeof payload === "string") return payload;
  if (payload?.text) return payload.text;
  if (payload?.caption) return payload.caption;
  if (payload?.image?.caption) return payload.image.caption;
  if (payload?.video?.caption) return payload.video.caption;
  if (payload?.document?.caption) return payload.document.caption;
  if (payload?.contacts?.displayName) return payload.contacts.displayName;
  if (payload?.location?.name) return payload.location.name;
  if (payload?.location?.address) return payload.location.address;
  if (payload?.reaction?.text) return payload.reaction.text;
  return "";
}

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function compactWhitespace(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value = "", max = 240) {
  return compactWhitespace(value).slice(0, max);
}

function normalizePhoneDigits(value = "") {
  return String(value ?? "").replace(/[^\d+]/g, "").trim();
}

function extractPhoneFromJid(jid = "") {
  return normalizeJid(jid).split("@")[0]?.replace(/[^\d]/g, "") ?? "";
}

function looksLikeImageGenerationPrompt(text = "") {
  const normalized = compactWhitespace(text).toLowerCase();
  if (!normalized) return false;
  return /(generate|create|draw|make|design)\b.*\b(image|photo|picture|poster|logo|flyer|art|illustration|banner|cover)/i.test(normalized)
    || /\b(image|photo|picture|poster|logo|flyer|art|illustration|banner|cover)\b.*\b(generate|create|draw|make|design)/i.test(normalized);
}

function buildVCard({ name = "", phone = "" } = {}) {
  const safeName = String(name ?? "").trim() || "Contact";
  const safePhone = normalizePhoneDigits(phone);
  if (!safePhone) throw new Error("Contact phone number is required.");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${safeName}`,
    `TEL;type=CELL;type=VOICE;waid=${safePhone.replace(/^\+/, "")}:${safePhone}`,
    "END:VCARD",
  ].join("\n");
}

function describeOutboundPayload(payload) {
  if (payload?.image) return "image";
  if (payload?.video) return "video";
  if (payload?.document) return "document";
  if (payload?.audio) return payload.ptt ? "voice_note" : "audio";
  if (payload?.sticker) return "sticker";
  if (payload?.location) return "location";
  if (payload?.contacts) return Array.isArray(payload.contacts?.contacts) && payload.contacts.contacts.length > 1 ? "contacts" : "contact";
  if (payload?.reaction) return "reaction";
  return "text";
}

function outboundPayloadMetadata(payload) {
  const payloadType = describeOutboundPayload(payload);
  const metadata = { payload_type: payloadType };
  if (payloadType === "document") {
    metadata.fileName = payload.fileName ?? undefined;
    metadata.mimetype = payload.mimetype ?? undefined;
  } else if (["image", "video", "audio", "voice_note"].includes(payloadType)) {
    metadata.mimetype = payload.mimetype ?? undefined;
  } else if (payloadType === "location") {
    metadata.location = {
      lat: payload.location.degreesLatitude,
      lng: payload.location.degreesLongitude,
      name: payload.location.name ?? null,
      address: payload.location.address ?? null,
    };
  } else if (payloadType === "contact" || payloadType === "contacts") {
    metadata.contacts_count = payload.contacts?.contacts?.length ?? 0;
    metadata.displayName = payload.contacts?.displayName ?? null;
  }
  return metadata;
}

function isRetriableSendError(err) {
  const message = String(err?.message ?? err ?? "").toLowerCase();
  return [
    "timed out",
    "timeout",
    "econnreset",
    "etimedout",
    "network",
    "connection",
    "stream errored",
    "unavailable",
    "503",
    "500",
    "fetch failed",
    "socket closed",
    "connection closed",
  ].some((token) => message.includes(token));
}

function resolveMediaSource(url) {
  const value = String(url ?? "").trim();
  if (!value) throw new Error("Media URL is required.");

  const match = value.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (match) {
    return {
      buffer: Buffer.from(match[2], "base64"),
      mimetype: match[1] || undefined,
    };
  }

  return { url: value };
}

/* ── Extract readable text from any WhatsApp message type ───── */
function extractMessageBody(msg) {
  const m = msg.message;
  if (!m) return { text: "", type: "unknown", extra: {} };

  const inner = m.viewOnceMessage?.message
    ?? m.viewOnceMessageV2?.message
    ?? m.ephemeralMessage?.message
    ?? m;

  if (inner.conversation)
    return { text: inner.conversation.trim(), type: "text", extra: {} };

  if (inner.extendedTextMessage)
    return { text: (inner.extendedTextMessage.text ?? "").trim(), type: "text", extra: {
      quotedMsg:         inner.extendedTextMessage.contextInfo?.quotedMessage ?? null,
      mentionedJid:      inner.extendedTextMessage.contextInfo?.mentionedJid ?? [],
      quotedParticipant: inner.extendedTextMessage.contextInfo?.participant ?? null
    }};

  if (inner.imageMessage)
    return { text: (inner.imageMessage.caption ?? "").trim(), type: "image", extra: {
      caption: inner.imageMessage.caption,
      mimetype: inner.imageMessage.mimetype,
      width: inner.imageMessage.width ?? null,
      height: inner.imageMessage.height ?? null,
      mediaKeyTimestamp: inner.imageMessage.mediaKeyTimestamp ?? null,
    }};

  if (inner.videoMessage)
    return { text: (inner.videoMessage.caption ?? "").trim(), type: "video", extra: {
      caption: inner.videoMessage.caption,
      mimetype: inner.videoMessage.mimetype ?? null,
      seconds: inner.videoMessage.seconds ?? null,
      gifPlayback: inner.videoMessage.gifPlayback ?? false,
    }};

  if (inner.documentMessage)
    return { text: (inner.documentMessage.caption ?? inner.documentMessage.fileName ?? "").trim(), type: "document", extra: {
      fileName: inner.documentMessage.fileName,
      mimetype: inner.documentMessage.mimetype,
      fileLength: inner.documentMessage.fileLength ?? null,
      pageCount: inner.documentMessage.pageCount ?? null,
    }};

  if (inner.audioMessage)
    return { text: "", type: inner.audioMessage.ptt ? "voice_note" : "audio", extra: {
      mimetype: inner.audioMessage.mimetype ?? null,
      seconds: inner.audioMessage.seconds ?? null,
      ptt: Boolean(inner.audioMessage.ptt),
    } };

  if (inner.stickerMessage)
    return { text: "", type: "sticker", extra: {
      isAnimated: Boolean(inner.stickerMessage.isAnimated),
      isAvatar: Boolean(inner.stickerMessage.isAvatar),
    } };

  if (inner.locationMessage)
    return { text: "📍 Location shared", type: "location", extra: {
      lat:  inner.locationMessage.degreesLatitude,
      lng:  inner.locationMessage.degreesLongitude,
      name: inner.locationMessage.name
    }};

  if (inner.contactMessage)
    return { text: inner.contactMessage.displayName ?? "Contact shared", type: "contact", extra: {
      displayName: inner.contactMessage.displayName ?? null,
      vcard: inner.contactMessage.vcard ?? null,
    } };

  if (inner.contactsArrayMessage)
    return { text: `${inner.contactsArrayMessage.contacts?.length ?? 0} contacts shared`, type: "contacts", extra: {
      count: inner.contactsArrayMessage.contacts?.length ?? 0,
      contacts: (inner.contactsArrayMessage.contacts ?? []).map((contact) => ({
        displayName: contact.displayName ?? null,
        vcard: contact.vcard ?? null,
      })),
    } };

  if (inner.reactionMessage)
    return { text: inner.reactionMessage.text ?? "👍", type: "reaction", extra: {} };

  if (inner.listResponseMessage)
    return { text: inner.listResponseMessage.singleSelectReply?.selectedRowId ?? "", type: "list_reply", extra: {
      title: inner.listResponseMessage.title
    }};

  if (inner.buttonsResponseMessage)
    return { text: inner.buttonsResponseMessage.selectedButtonId ?? "", type: "button_reply", extra: {
      displayText: inner.buttonsResponseMessage.selectedDisplayText
    }};

  if (inner.templateButtonReplyMessage)
    return { text: inner.templateButtonReplyMessage.selectedId ?? "", type: "template_reply", extra: {} };

  if (inner.orderMessage)
    return { text: "🛒 Order received", type: "order", extra: {
      itemCount: inner.orderMessage.itemCount
    }};

  if (inner.pollUpdateMessage || inner.pollCreationMessage)
    return { text: "📊 Poll", type: "poll", extra: {} };

  return { text: "", type: "unknown", extra: {} };
}

/* ── Format product catalog as text ─────────────────────────── */
function formatCatalog(products = []) {
  if (!products.length) return null;
  const lines = ["📦 *Our Products:*\n"];
  products.forEach((p, i) => {
    lines.push(`${i + 1}. *${p.name}*`);
    if (p.price)       lines.push(`   💰 ₦${p.price}`);
    if (p.description) lines.push(`   ${p.description}`);
  });
  lines.push("\nSend a product name or number to enquire.");
  return lines.join("\n");
}

export class BotInstance {
  constructor(botId, userId, config = {}) {
    this.botId   = botId;
    this.userId  = userId;
    this.config  = normalizeRuntimeBotConfig({
      plan_tier:               "free",
      bot_type:                "dm",
      keyword_triggers:        [],
      sales_agent_config:      {},
      commands_config:         {},
      ai_config:               {},
      group_management_config: {},
      website_url:             null,
      catalog_unavail_msg:     null,
      ...config
    });
    this.socket  = null;
    this.status  = "idle";
    this.qrCode  = null;
    this._destroyed           = false;
    this._reconnectTimer      = null;
    this._reconnectAttempts   = 0;
    this._qrTimeoutTimer      = null;
    this._queue               = new MessageQueue(botId);
    this._flushTimer          = null;
    this._logFlushTimer       = null;
    this._usageFlushInFlight  = false;
    this._logFlushInFlight    = false;
    this._startPromise        = null;
    this._socketListeners     = null;
    this._authStateLoaded     = false;
    this._aiJobs              = [];
    this._activeAiJobs        = 0;
    this._recentInboundIds    = new Map();
    this._recentAiJobs        = new Map();
    this._recentChatActivity  = new Map();
    this._typingSessions      = new Map();
    this._onQR     = new Set();
    this._onStatus = new Set();
    this._onPair   = new Set();
    this._pendingUsage = { messagesThisMonth: 0, totalMessages: 0, lastActivity: null };
    this._pendingLogs  = [];
    this._authMode              = "qr";
    this._isPairingMode         = false;
    this._socketReadyForPairing = false;
    this._pairingPhone          = null;
    this._pairingCodeResolve    = null;
    this._pairingCodeReject     = null;
    this._pairingRequestPromise = null;
    this._pairingCodeInFlight   = false;
    this._lastPairingCode       = null;
    this._lastPairingCodeExpiresAt = null;
    this._socketStartedAt       = Date.now();

    /* ── Group management in-memory state ─────────────────── */
    this._strikes            = new Map(); // `${groupJid}:${userJid}` → count
    this._warnCount          = new Map(); // `${groupJid}:${userJid}` → count
    this._spamTracker        = new Map(); // `${groupJid}:${userJid}` → [timestamps]
    this._metaCache          = new Map(); // groupJid → { meta, cachedAt }
    this._seenDmContacts     = new Set();
    this._welcomedDmContacts = new Set();
  }

  onQR(cb)       { this._onQR.add(cb);     return () => this._onQR.delete(cb); }
  onPairCode(cb) { this._onPair.add(cb);   return () => this._onPair.delete(cb); }
  onStatus(cb)   { this._onStatus.add(cb); return () => this._onStatus.delete(cb); }
  updateConfig(patch) {
    const normalizedPatch = normalizeRuntimeBotConfigPatch(patch);
    const nextConfig = {
      ...this.config,
      ...normalizedPatch,
      sales_agent_config: normalizedPatch.sales_agent_config
        ? { ...this.config.sales_agent_config, ...normalizedPatch.sales_agent_config }
        : this.config.sales_agent_config,
      commands_config: normalizedPatch.commands_config
        ? { ...this.config.commands_config, ...normalizedPatch.commands_config }
        : this.config.commands_config,
      ai_config: normalizedPatch.ai_config
        ? { ...this.config.ai_config, ...normalizedPatch.ai_config }
        : this.config.ai_config,
      group_management_config: normalizedPatch.group_management_config
        ? { ...this.config.group_management_config, ...normalizedPatch.group_management_config }
        : this.config.group_management_config,
    };

    this.config = normalizeRuntimeBotConfig(nextConfig);
    logger.info({ botId: this.botId, keys: Object.keys(normalizedPatch) }, "Runtime config updated");
  }

  /* ── Helper: Increment user's monthly counter in DB ───────── */
  async _incrementUserMonthlyCounter() {
    try {
      await supabase.rpc("increment_user_messages", { uid: this.userId });
    } catch {
      const { data: user } = await supabase
        .from("users")
        .select("messages_this_month")
        .eq("id", this.userId)
        .single();
      if (user) {
        await supabase
          .from("users")
          .update({ messages_this_month: (user.messages_this_month ?? 0) + 1 })
          .eq("id", this.userId);
      }
    }
  }

  /* ── Start / stop ─────────────────────────────────────────── */

  async start() {
    if (this._destroyed) this._destroyed = false;
    if (this._startPromise) return this._startPromise;

    this._socketReadyForPairing = false;
    this._pairingCodeInFlight   = false;
    this._startPromise = (async () => {
      try {
        await this._setStatus("connecting");
        logger.info({
          botId: this.botId,
          status: this.status,
          authMode: this._authMode,
          reconnectAttempts: this._reconnectAttempts,
        }, "Starting WhatsApp socket");

        await this._teardownSocket();

        let version;
        try {
          ({ version } = await fetchLatestBaileysVersion());
        } catch {
          version = [2, 3000, 1035194821];
          logger.warn({ botId: this.botId }, "fetchLatestBaileysVersion failed — using fallback version");
        }
        const { state, saveCreds, flushNow, hasValidSession } = await createSupabaseAuthState(this.botId);
        this._socketStartedAt = Date.now();
        this._authStateLoaded = hasValidSession;

        if (!hasValidSession) {
          logger.warn({ botId: this.botId }, "Stored WhatsApp auth state is incomplete; forcing fresh authentication");
          await clearSupabaseSession(this.botId);
        }

        this.socket = makeWASocket({
          version,
          auth:                           hasValidSession ? state : { creds: initAuthCreds(), keys: state.keys },
          printQRInTerminal:              false,
          mobile:                         false,
          browser:                        ["WaBot", "Chrome", "1.0.0"],
          syncFullHistory:                false,
          generateHighQualityLinkPreview: false
        });

        const rawSendMessage = this.socket.sendMessage.bind(this.socket);
        this.socket.sendMessage = (...args) => this._queue.send(() => rawSendMessage(...args));

        this._socketListeners = {
          saveCreds,
          flushNow,
          onConnectionUpdate: (u) => this._onConnectionUpdate(u),
          onMessages: (u) => this._onMessages(u),
          onGroupParticipants: (u) => this._onGroupParticipants(u),
        };

        this.socket.ev.on("creds.update", this._socketListeners.saveCreds);
        this.socket.ev.on("connection.update", this._socketListeners.onConnectionUpdate);
        this.socket.ev.on("messages.upsert", this._socketListeners.onMessages);
        this.socket.ev.on("group-participants.update", this._socketListeners.onGroupParticipants);
      } catch (err) {
        logger.error({ err, botId: this.botId }, "BotInstance.start failed");
        if (!this._destroyed) this._scheduleReconnect();
      } finally {
        this._startPromise = null;
      }
    })();

    return this._startPromise;
  }

  async stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._qrTimeoutTimer);
    this._clearPairingState({ clearLastCode: true });
    this._clearAllTypingSessions();
    this._queue.destroy();
    await this._flushPendingUsage();
    await this._flushLogs();
    if (this._flushTimer)    clearTimeout(this._flushTimer);
    if (this._logFlushTimer) clearTimeout(this._logFlushTimer);
    await this._flushAuthState("bot_stop");
    await this._teardownSocket();
  }

  async sendMessage(to, text, options = { persist: true }) {
    if (!this.socket)              throw new Error("Bot is not connected.");
    if (this.status !== "connected") throw new Error("Bot is not connected. Check bot status and try again.");
    const jid = toTargetJid(to);
    if (!jid) throw new Error("Invalid WhatsApp recipient.");
    const botType = this.config.bot_type ?? "dm";
    const targetIsGroup = isGroupJid(jid);

    if (botType === "dm" && targetIsGroup) {
      throw new Error("This bot is deployed as a DM bot and can only work in direct messages.");
    }
    if (botType === "group" && !targetIsGroup) {
      throw new Error("This bot is deployed as a group bot and can only work in WhatsApp groups.");
    }

    try {
      if (typeof text === "string") {
        await this._sendTrackedMessage(jid, { text }, {
          eventType: "message_sent",
          details: `Message sent to ${jid}`,
          metadata: { to: jid, direction: "outbound", channel: "direct_send" },
          countUsage: options.persist !== false || options.countOnly === true,
        });
      } else {
        const normalized = this._normalizeOutboundMessagePayload(text);
        await this._sendTrackedMessage(jid, normalized.payload, {
          eventType: "message_sent",
          details: `${normalized.label} sent to ${jid}`,
          metadata: { to: jid, direction: "outbound", channel: "direct_send", ...normalized.metadata },
          countUsage: options.persist !== false || options.countOnly === true,
        });
      }
    } catch (err) {
      logger.error({ err, botId: this.botId, to }, "sendMessage failed");
      throw err;
    }
  }

  /* ── Connection update ────────────────────────────────────── */

  async _onConnectionUpdate({ connection, lastDisconnect, qr }) {
    logger.info({
      botId: this.botId,
      connection: connection ?? "update",
      hasQr: Boolean(qr),
      authMode: this._authMode,
      socketReadyForPairing: this._socketReadyForPairing,
      reconnectAttempts: this._reconnectAttempts,
    }, "WhatsApp connection.update");

    if (qr) {
      this._socketReadyForPairing = true;

      // Display gate: decide BEFORE doing any heavy QR work or emitting to UI.
      const shouldRenderQR = this._shouldShowQR(qr);
      if (!shouldRenderQR) {
        // Suppress QR entirely when pairing flow is active or a code exists.
        // NOTE: do NOT emit pairing code here — emission must be controlled
        // exclusively by _doPairingCodeRequest / _emitPairingCode to avoid
        // double-emission races during reconnect storms.
        this.qrCode = null;
        this._clearQrTimeout();
        await this._setStatus(this._lastPairingCodeExpiresAt ? "awaiting_link" : "awaiting_code");
        logger.info({ botId: this.botId }, "QR suppressed by display gate — pairing_code or pairing_mode active");
        // If pairing-mode active, kick off the deferred pairing request if not already running.
        if (this._isPairingMode && this._pairingPhone && !this._pairingCodeInFlight) {
          this._doPairingCodeRequest().catch((err) => {
            logger.error({ err, botId: this.botId }, "Deferred pairing code request failed");
          });
        }
        return;
      }

      try {
        // Double-check before expensive rendering to avoid a race where a code arrives
        // between the initial gate check and QR generation.
        if (!this._shouldShowQR(qr)) {
          // Same as above: avoid emitting here. Let pairing logic emit when ready.
          this.qrCode = null;
          this._clearQrTimeout();
          await this._setStatus(this._lastPairingCodeExpiresAt ? "awaiting_link" : "awaiting_code");
          logger.info({ botId: this.botId }, "QR suppressed by display gate (post-check)");
          return;
        }

        this.qrCode = await QRCode.toDataURL(qr);
        this._emitPairingCode(null, null);
        for (const cb of this._onQR) cb(this.qrCode);
        await this._setStatus("qr_generated");
        this._startQrTimeout();
      } catch (err) {
        logger.error({ err, botId: this.botId }, "QR generation failed");
      }
    }

    if (connection === "open") {
      this._clearQrTimeout();
      this._reconnectAttempts     = 0;
      this.qrCode                 = null;
      this._clearPairingState({ clearLastCode: true });
      await this._setStatus("connected");
      await this._log("bot_connected", "WhatsApp connection established");
    }

    if (connection === "close") {
      this._clearQrTimeout();
      this._socketReadyForPairing = false;
      await this._flushAuthState("connection_close");

      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        this._rejectPairing(new Error("WhatsApp logged out. Please scan QR to reconnect."));
        await clearSupabaseSession(this.botId);
        await this._setStatus("disconnected");
        await this._log("bot_disconnected", "Logged out — QR scan required to reconnect");
        return;
      }

      try {
        const raw  = lastDisconnect?.error ?? null;
        const text = raw ? JSON.stringify(raw) : "";
        if (text.includes("device_removed") || text.includes("conflict") || text.includes("device_revoked")) {
          logger.error({ botId: this.botId, lastDisconnect }, "Detected device_removed/conflict — clearing session");
          this._rejectPairing(new Error("Session conflict detected. Please reconnect."));
          await clearSupabaseSession(this.botId);
          await this._setStatus("disconnected");
          await this._log("bot_disconnected", "Session removed by WhatsApp — QR scan required");
          return;
        }
      } catch {}

      if (this._isPairingMode) {
        logger.warn({ botId: this.botId, code }, "Socket closed during pairing; not auto-reconnecting");
        this._rejectPairing(new Error("WhatsApp closed the pairing session. Request a fresh pairing code."));
        await this._setStatus("disconnected");
        await this._log("pairing_failed", "Socket closed during pairing");
        return;
      }

      if (!this._destroyed) this._scheduleReconnect();
    }
  }

  /* ── requestPairingCode — event-driven, waits for socket ready ─ */
  async requestPairingCode(phone) {
    if (!this.socket)                   throw new Error("Bot socket not started. Please wait a moment and try again.");
    if (!this.socket.requestPairingCode) throw new Error("This Baileys version does not support pairing codes.");
    if (this.status === "connected")     throw new Error("Bot is already connected. Pairing code is no longer needed.");
    if (QR_AUTH_STATUSES.has(this.status) && this.qrCode) {
      logger.info({ botId: this.botId }, "Switching auth flow to pairing-code mode before authentication completes");
    }

    const cleanPhone = String(phone).replace(/[^\d]/g, "");
    if (!/^\d{10,15}$/.test(cleanPhone)) {
      throw new Error("Invalid phone number — include country code (e.g. 2348012345678).");
    }

    if (this._pairingRequestPromise && this._pairingPhone === cleanPhone) {
      logger.info({ botId: this.botId, phone: cleanPhone }, "Reusing in-flight pairing request");
      return this._pairingRequestPromise;
    }

    logger.info({
      botId: this.botId,
      phone: cleanPhone,
      status: this.status,
      socketReadyForPairing: this._socketReadyForPairing,
    }, "Preparing pairing code request");

    this._clearPairingState({ clearLastCode: true, clearMode: false });
    this._setAuthMode("pairing_code");
    this._pairingPhone  = cleanPhone;
    this.qrCode         = null;
    this._clearQrTimeout();
    for (const cb of this._onQR) {
      try { cb(null); } catch {}
    }
    await this._setStatus("awaiting_code");
    this._pairingRequestPromise = new Promise((resolve, reject) => {
      const tid = setTimeout(() => {
        logger.warn({ botId: this.botId, phone: cleanPhone }, "Pairing code request timed out");
        this._pairingCodeResolve = null;
        this._pairingCodeReject  = null;
        this._pairingRequestPromise = null;
        this._clearPairingState({ clearLastCode: true });
        reject(new Error("Pairing code request timed out (30 s). Reconnect the bot and try again."));
      }, 30_000);

      this._pairingCodeResolve = (code) => {
        clearTimeout(tid);
        this._pairingCodeResolve = null;
        this._pairingCodeReject  = null;
        this._pairingRequestPromise = null;
        resolve(code);
      };
      this._pairingCodeReject = (err) => {
        clearTimeout(tid);
        this._pairingCodeResolve = null;
        this._pairingCodeReject  = null;
        this._pairingRequestPromise = null;
        this._clearPairingState({ clearLastCode: true });
        reject(err);
      };

      if (this._socketReadyForPairing && !this._pairingCodeInFlight) {
        this._doPairingCodeRequest();
      }
    });

    return this._pairingRequestPromise;
  }

  /* ── Internal: call Baileys and emit the pairing code ─────── */
  async _doPairingCodeRequest() {
    if (this._pairingCodeInFlight) return;
    const phone = this._pairingPhone;
    if (!phone || !this.socket?.requestPairingCode) return;

    this._pairingCodeInFlight = true;

    // ✅ FIX: 1500 ms stabilisation delay — Baileys emits the QR event at the
    //         moment the WebSocket handshake finishes, but WhatsApp's server
    //         needs a short window before it accepts a pairing-code request.
    //         Calling requestPairingCode() too quickly causes an immediate
    //         disconnect / "bad request" rejection from WhatsApp.
    await new Promise(r => setTimeout(r, 1500));

    // ✅ FIX: the mode may have been cancelled or the socket may have closed
    //         during the delay — bail out rather than sending a stale request
    if (!this._isPairingMode || !this._pairingPhone || !this.socket) {
      this._pairingCodeInFlight = false;
      return;
    }

    try {
      logger.info({ botId: this.botId, phone, socketReadyForPairing: this._socketReadyForPairing }, "Calling requestPairingCode()");
      const code = await this.socket.requestPairingCode(phone);
      if (!code) throw new Error("Baileys returned an empty pairing code.");
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      this._emitPairingCode(code, expiresAt);
      await this._setStatus("code_generated");
      if (this._pairingCodeResolve) this._pairingCodeResolve(code);
      await this._setStatus("awaiting_link");
    } catch (err) {
      logger.error({ err, botId: this.botId, phone }, "Pairing code request failed");
      if (this._pairingCodeReject) {
        this._pairingCodeReject(err);
      } else {
        this._clearPairingState({ clearLastCode: true });
      }
    } finally {
      this._pairingCodeInFlight = false;
    }
  }

  _emitPairingCode(code, expiresAt = null) {
    this._lastPairingCode = code ?? null;
    this._lastPairingCodeExpiresAt = code ? expiresAt : null;
    for (const cb of this._onPair) {
      try {
        cb(code ? { code, expiresAt } : null);
      } catch {}
    }
  }

  _setAuthMode(mode = "qr") {
    this._authMode = mode === "pairing_code" ? "pairing_code" : "qr";
    this._isPairingMode = this._authMode === "pairing_code";
  }

  _clearPairingState({ clearLastCode = false, clearMode = true } = {}) {
    if (clearMode) this._setAuthMode("qr");
    this._socketReadyForPairing = false;
    this._pairingPhone = null;
    if (clearLastCode) this._emitPairingCode(null, null);
  }

  /* ── Display gate for QR rendering ────────────────────── */
  _shouldShowQR(qr) {
    if (!qr) return false;
    const hasPairingCode = typeof this._lastPairingCode === "string" && this._lastPairingCode.trim().length > 0;
    const isPairingMode = this._isPairingMode === true;
    // NEVER show QR if pairing is active or a pairing code exists
    if (hasPairingCode || isPairingMode) return false;
    return true;
  }

  _rejectPairing(err) {
    if (this._pairingCodeReject) {
      this._pairingCodeReject(err);
      return;
    }
    this._pairingRequestPromise = null;
    this._clearPairingState({ clearLastCode: true });
  }

  _getReplyDelayWindow() {
    const configured = this.config.commands_config?.reply_timing ?? {};
    const min = clampNumber(configured.min_ms, {
      min: 0,
      max: 120_000,
      fallback: DEFAULT_REPLY_DELAY_WINDOW_MS.min,
    });
    const max = clampNumber(configured.max_ms, {
      min: 0,
      max: 120_000,
      fallback: DEFAULT_REPLY_DELAY_WINDOW_MS.max,
    });

    return min <= max ? { min, max } : { min: max, max: min };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _sampleDelay(min, max) {
    if (min >= max) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async _getAiConversationState(conversationId) {
    if (!conversationId) return null;
    const { data, error } = await supabase
      .from("ai_conversations")
      .select("id, summary_text, recent_turns, contact_profile, message_count, last_message_at, last_ai_response_at")
      .eq("user_id", this.userId)
      .eq("bot_id", this.botId)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (error) throw error;
    return data ?? null;
  }

  _compressConversationSummary(summary, olderTurns, summaryCharLimit) {
    const lines = olderTurns
      .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${truncateText(turn.text ?? "", 180)}`)
      .filter(Boolean);
    if (lines.length === 0) return truncateText(summary, summaryCharLimit);
    return truncateText([summary, ...lines].filter(Boolean).join("\n"), summaryCharLimit);
  }

  async _appendConversationTurn({
    conversationId,
    contactJid,
    isGroup = false,
    role = "user",
    text = "",
    profilePatch = null,
    markAiResponse = false,
  } = {}) {
    const trimmed = truncateText(text, AI_MEMORY_LINE_MAX_CHARS);
    if (!conversationId || !trimmed) return;

    const ai = this.config.ai_config ?? {};
    const summaryCharLimit = clampNumber(ai.summary_char_limit, {
      min: 300,
      max: 4000,
      fallback: 1200,
    });

    try {
      const existing = await this._getAiConversationState(conversationId);
      const recentTurns = Array.isArray(existing?.recent_turns) ? existing.recent_turns : [];
      const nextTurns = [...recentTurns, { role, text: trimmed, at: new Date().toISOString() }];
      let nextSummary = String(existing?.summary_text ?? "");
      let boundedTurns = nextTurns;

      if (nextTurns.length > AI_RECENT_TURNS_LIMIT) {
        const overflowCount = nextTurns.length - AI_RECENT_TURNS_LIMIT;
        nextSummary = this._compressConversationSummary(nextSummary, nextTurns.slice(0, overflowCount), summaryCharLimit);
        boundedTurns = nextTurns.slice(-AI_RECENT_TURNS_LIMIT);
      }

      const nextProfile = {
        ...(existing?.contact_profile && typeof existing.contact_profile === "object" ? existing.contact_profile : {}),
        ...(profilePatch && typeof profilePatch === "object" ? profilePatch : {}),
      };

      const payload = {
        user_id: this.userId,
        bot_id: this.botId,
        conversation_id: conversationId,
        contact_jid: normalizeJid(contactJid),
        is_group: Boolean(isGroup),
        summary_text: truncateText(nextSummary, Math.min(summaryCharLimit, AI_SUMMARY_MAX_CHARS)),
        recent_turns: boundedTurns,
        contact_profile: nextProfile,
        message_count: Number(existing?.message_count ?? 0) + 1,
        last_message_at: new Date().toISOString(),
        last_ai_response_at: markAiResponse ? new Date().toISOString() : (existing?.last_ai_response_at ?? null),
      };

      await supabase.from("ai_conversations").upsert(payload, {
        onConflict: "bot_id,conversation_id",
      });
    } catch (err) {
      logger.warn({ err, botId: this.botId, conversationId }, "Failed to persist rolling AI conversation state");
    }
  }

  async _markConversationAiResponse(conversationId) {
    if (!conversationId) return;
    try {
      await supabase
        .from("ai_conversations")
        .update({ last_ai_response_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", this.userId)
        .eq("bot_id", this.botId)
        .eq("conversation_id", conversationId);
    } catch (err) {
      logger.warn({ err, botId: this.botId, conversationId }, "Failed to mark AI response timestamp");
    }
  }

  async _buildAiConversationMemory(conversationId, currentMessageId = null) {
    const ai = this.config.ai_config ?? {};
    if (!ai.conversation_memory_enabled || !conversationId) return "";

    const messageLimit = clampNumber(ai.memory_message_limit, {
      min: 0,
      max: 12,
      fallback: 6,
    });
    const charLimit = clampNumber(ai.memory_char_limit, {
      min: 0,
      max: 6000,
      fallback: 1200,
    });

    if (messageLimit <= 0 || charLimit <= 0) return "";

    try {
      const state = await this._getAiConversationState(conversationId);
      const summary = compactWhitespace(state?.summary_text ?? "");
      const recentTurns = Array.isArray(state?.recent_turns) ? state.recent_turns : [];
      const recentLines = recentTurns
        .filter((turn) => compactWhitespace(turn?.text ?? ""))
        .slice(-messageLimit)
        .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${truncateText(turn.text ?? "", AI_MEMORY_LINE_MAX_CHARS)}`);

      const blocks = [];
      if (summary) blocks.push(`Summary:\n${truncateText(summary, Math.min(charLimit, AI_SUMMARY_MAX_CHARS))}`);
      if (recentLines.length > 0) blocks.push(`Recent turns:\n${recentLines.join("\n")}`);

      let assembled = blocks.join("\n\n").trim();
      if (assembled.length > charLimit) {
        assembled = assembled.slice(assembled.length - charLimit);
      }

      if (assembled) return assembled;

      const { data, error } = await supabase
        .from("bot_activity")
        .select("event_type, details, metadata, created_at")
        .eq("user_id", this.userId)
        .eq("bot_id", this.botId)
        .in("event_type", ["message_received", "message_sent", "api_message_sent"])
        .order("created_at", { ascending: false })
        .limit(AI_MEMORY_FETCH_LIMIT);

      if (error) throw error;

      const relevantRows = (data ?? [])
        .filter((row) => row?.metadata?.conversation_id === conversationId)
        .filter((row) => row?.metadata?.message_id !== currentMessageId)
        .filter((row) => compactWhitespace(row?.metadata?.body ?? row?.details ?? ""))
        .reverse();

      return relevantRows
        .slice(-messageLimit)
        .map((row) => {
          const direction = row?.metadata?.direction || (row?.event_type === "message_received" ? "inbound" : "outbound");
          return `${direction === "inbound" ? "User" : "Assistant"}: ${truncateText(row?.metadata?.body ?? row?.details ?? "", AI_MEMORY_LINE_MAX_CHARS)}`;
        })
        .join("\n")
        .slice(0, charLimit);
    } catch (err) {
      logger.warn({ err, botId: this.botId, conversationId }, "Failed to build AI conversation memory");
      return "";
    }
  }

  _extractProfilePatch({ senderJid, body, extra = {} } = {}) {
    const patch = {};
    const senderPhone = extractPhoneFromJid(senderJid);
    if (senderPhone) patch.phone = senderPhone;

    const contactName = compactWhitespace(extra?.displayName ?? "");
    if (contactName) patch.name = contactName;

    const nameMatch = String(body ?? "").match(/\bmy name is\s+([a-z][a-z\s'-]{1,60})/i);
    if (nameMatch?.[1]) patch.name = truncateText(nameMatch[1], 80);

    const phoneMatch = String(body ?? "").replace(/\s+/g, "").match(/(?:\+?\d[\d()-]{7,15}\d)/);
    if (phoneMatch?.[0]) patch.phone = phoneMatch[0].replace(/[^\d+]/g, "");

    return patch;
  }

  async _touchContact({ jid, displayName = "", lastMessageAt = null, metadata = {}, archiveOverride = false } = {}) {
    const normalizedJid = normalizeJid(jid);
    if (!normalizedJid || isGroupJid(normalizedJid) || isBroadcastJid(normalizedJid)) return;

    const payload = {
      user_id: this.userId,
      bot_id: this.botId,
      contact_jid: normalizedJid,
      phone_number: extractPhoneFromJid(normalizedJid) || null,
      display_name: truncateText(displayName, 120) || null,
      last_message_at: lastMessageAt ?? new Date().toISOString(),
      archived_at: archiveOverride ? new Date().toISOString() : null,
      deleted_at: null,
      metadata,
    };

    try {
      await supabase.from("bot_contacts").upsert(payload, {
        onConflict: "bot_id,contact_jid",
      });
    } catch (err) {
      logger.warn({ err, botId: this.botId, jid: normalizedJid }, "Failed to upsert bot contact");
    }
  }

  async _getConversationProfile(conversationId) {
    try {
      const state = await this._getAiConversationState(conversationId);
      return state?.contact_profile && typeof state.contact_profile === "object"
        ? state.contact_profile
        : {};
    } catch {
      return {};
    }
  }

  _isAssistantAdmin(senderJid) {
    const ai = this.config.ai_config ?? {};
    const senderPhone = extractPhoneFromJid(senderJid);
    return Array.isArray(ai.assistant_admin_numbers) && ai.assistant_admin_numbers.includes(senderPhone);
  }

  async _storeAssistantLead({ conversationId, senderJid, profile = {} } = {}) {
    const phone = compactWhitespace(profile.phone ?? extractPhoneFromJid(senderJid));
    const name = compactWhitespace(profile.name ?? "");
    const message = compactWhitespace(profile.lead_message ?? profile.message ?? "");
    if (!conversationId || !message) return false;

    try {
      await supabase.from("assistant_leads").insert({
        user_id: this.userId,
        bot_id: this.botId,
        conversation_id: conversationId,
        contact_jid: normalizeJid(senderJid),
        name: name || null,
        phone: phone || null,
        message,
        metadata: {
          source: "assistant_mode",
        },
      });
      return true;
    } catch (err) {
      logger.warn({ err, botId: this.botId, conversationId }, "Failed to store assistant lead");
      return false;
    }
  }

  async _handleAssistantMode(jid, body, context = {}) {
    const ai = this.config.ai_config ?? {};
    if (!ai.enabled || !ai.assistant_enabled || this.config.plan_tier !== "paid") return false;
    if (context.isGroup) return false;

    const senderJid = normalizeJid(context.senderJid ?? jid);
    const trimmedBody = compactWhitespace(body);
    if (!trimmedBody) return false;

    if (trimmedBody.toLowerCase() === "/leads") {
      if (!this._isAssistantAdmin(senderJid)) return false;
      const { data, error } = await supabase
        .from("assistant_leads")
        .select("name, phone, message, created_at")
        .eq("user_id", this.userId)
        .eq("bot_id", this.botId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;

      const lines = (data ?? []).length
        ? ["*Recent leads:*", ...data.map((lead, index) => `${index + 1}. ${lead.name || "Unknown"} | ${lead.phone || "No phone"} | ${truncateText(lead.message, 80)} | ${new Date(lead.created_at).toLocaleString()}`)]
        : ["No leads captured yet."];
      await this._sendTrackedMessage(jid, { text: lines.join("\n") }, {
        eventType: "assistant_leads_sent",
        details: "Assistant leads summary sent",
        metadata: { channel: "assistant_mode" },
      });
      return true;
    }

    // Admin-only: retrieve recent bot activity/logs for this conversation
    if (trimmedBody.toLowerCase() === "/logs" || trimmedBody.toLowerCase() === "/ai logs") {
      if (!this._isAssistantAdmin(senderJid)) return false;
      try {
        const { data, error } = await supabase
          .from("bot_activity")
          .select("event_type, details, metadata, created_at")
          .eq("user_id", this.userId)
          .eq("bot_id", this.botId)
          .order("created_at", { ascending: false })
          .limit(60);
        if (error) throw error;
        const rows = (data ?? []).slice(0, 50).map((r, i) => {
          const when = new Date(r.created_at).toLocaleString();
          const meta = r.metadata ?? {};
          const who = meta.sender_jid ? (meta.sender_number ? `${meta.sender_number}` : meta.sender_jid.replace(/@.*/, "")) : (meta.from || meta.to || "-");
          const preview = String(meta.body ?? r.details ?? "").slice(0, 120).replace(/\n/g, " ");
          return `${i + 1}. [${r.event_type}] ${when} — ${who}: ${preview}`;
        });
        const payloadText = rows.length ? ["Recent activity (most recent first):", ...rows].join("\n") : "No recent activity found.";
        await this._sendTrackedMessage(jid, { text: payloadText }, {
          eventType: "assistant_logs_sent",
          details: "Assistant delivered recent logs to admin",
          metadata: { channel: "assistant_mode" },
        });
        return true;
      } catch (err) {
        logger.warn({ err, botId: this.botId }, "Failed to fetch logs for admin");
        await this._sendTrackedMessage(jid, { text: "Could not retrieve logs — try again later." }, {
          eventType: "assistant_logs_failed",
          details: "Failed to deliver logs to admin",
          metadata: { channel: "assistant_mode" },
        });
        return true;
      }
    }

    if (this._isAssistantAdmin(senderJid)) {
      return false;
    }

    const profile = await this._getConversationProfile(context.conversationId);
    const mergedProfile = {
      ...profile,
      ...this._extractProfilePatch({ senderJid, body: trimmedBody, extra: context.extra }),
    };
    const looksLikeNameOnly = /^[a-z][a-z\s'-]{1,60}$/i.test(trimmedBody) || /\bmy name is\b/i.test(trimmedBody);

    if (!mergedProfile.name) {
      await this._sendTrackedMessage(jid, { text: "Welcome. Please share your name so I can log your request properly." }, {
        eventType: "assistant_prompt_sent",
        details: "Assistant asked for lead name",
        metadata: { channel: "assistant_mode" },
      });
      return true;
    }

    if (!mergedProfile.lead_message) {
      if (!looksLikeNameOnly) {
        mergedProfile.lead_message = trimmedBody;
      }
      if (!mergedProfile.lead_message) {
        await this._appendConversationTurn({
          conversationId: context.conversationId,
          contactJid: senderJid,
          role: "assistant",
          text: "Lead message capture requested.",
          profilePatch: mergedProfile,
        });
        await this._sendTrackedMessage(jid, { text: `Thanks ${mergedProfile.name}. Please share the message you want passed to the team, or add any important details.` }, {
          eventType: "assistant_prompt_sent",
          details: "Assistant asked for lead message",
          metadata: { channel: "assistant_mode" },
        });
        return true;
      }
    }

    if (!mergedProfile.phone) {
      await this._appendConversationTurn({
        conversationId: context.conversationId,
        contactJid: senderJid,
        role: "assistant",
        text: "Lead phone capture requested.",
        profilePatch: mergedProfile,
      });
      await this._sendTrackedMessage(jid, { text: "Please share the best phone number for a callback." }, {
        eventType: "assistant_prompt_sent",
        details: "Assistant asked for lead phone",
        metadata: { channel: "assistant_mode" },
      });
      return true;
    }

    const stored = await this._storeAssistantLead({
      conversationId: context.conversationId,
      senderJid,
      profile: mergedProfile,
    });

    if (stored) {
      await this._appendConversationTurn({
        conversationId: context.conversationId,
        contactJid: senderJid,
        role: "assistant",
        text: "Lead captured and handed off.",
        profilePatch: { ...mergedProfile, lead_captured_at: new Date().toISOString() },
      });
      await this._sendTrackedMessage(jid, { text: `Thanks ${mergedProfile.name}. Your details have been passed to the team and someone will follow up shortly.` }, {
        eventType: "assistant_lead_captured",
        details: "Assistant captured a lead",
        metadata: { channel: "assistant_mode" },
      });
      return true;
    }

    return false;
  }

  _pruneTransientState() {
    const now = Date.now();

    for (const [messageId, seenAt] of this._recentInboundIds.entries()) {
      if (now - seenAt > RECENT_MESSAGE_TTL_MS) this._recentInboundIds.delete(messageId);
    }

    for (const [jobId, state] of this._recentAiJobs.entries()) {
      if (now - state.updatedAt > RECENT_AI_JOB_TTL_MS) this._recentAiJobs.delete(jobId);
    }

    for (const [jid, activityAt] of this._recentChatActivity.entries()) {
      if (now - activityAt > RECENT_MESSAGE_TTL_MS) this._recentChatActivity.delete(jid);
    }

    const freshJobs = [];
    for (const job of this._aiJobs) {
      if (now - job.createdAt <= AI_JOB_STALE_MS) {
        freshJobs.push(job);
        continue;
      }

      this._recentAiJobs.delete(job.id);
      job.reject(new Error("AI job expired before execution."));
      logger.warn({ botId: this.botId, jobId: job.id }, "Dropped stale AI job");
    }
    this._aiJobs = freshJobs;
  }

  _markInboundMessageSeen(messageId) {
    if (!messageId) return true;
    this._pruneTransientState();
    if (this._recentInboundIds.has(messageId)) return false;
    this._recentInboundIds.set(messageId, Date.now());
    return true;
  }

  _calculateResponseDelayMs({ text = "", generationMs = 0, queueDepth = 0, jid = null, channel = "auto_reply" } = {}) {
    const { min, max } = this._getReplyDelayWindow();
    const textLength = String(text ?? "").trim().length;
    const baseProfile = textLength <= 80
      ? { min: 1_000, max: 3_000 }
      : textLength <= 240
        ? { min: 3_000, max: 6_000 }
        : { min: 6_000, max: 12_000 };

    const boundedMin = Math.max(min, baseProfile.min);
    const boundedMax = Math.min(max, Math.max(boundedMin, baseProfile.max));
    const recentActivityAt = jid ? this._recentChatActivity.get(jid) ?? 0 : 0;
    const recentlyActive = recentActivityAt && (Date.now() - recentActivityAt) < 20_000;
    const queuePenaltyMs = Math.min(4_000, queueDepth * 300);
    const activityReductionMs = recentlyActive ? 700 : 0;
    const generationReductionMs = Math.min(4_000, Math.floor(generationMs * 0.6));
    const jitterMs = this._sampleDelay(120, 1_350);

    const sampledTarget = this._sampleDelay(boundedMin, boundedMax) + queuePenaltyMs + jitterMs - activityReductionMs;
    const remainingDelay = Math.max(900, sampledTarget - generationReductionMs);

    logger.debug({
      botId: this.botId,
      channel,
      queueDepth,
      textLength,
      generationMs,
      recentlyActive,
      remainingDelay,
    }, "Calculated automated response delay");

    return remainingDelay;
  }

  async _waitForReplyWindow(channel, options = {}) {
    const delayMs = this._calculateResponseDelayMs({ channel, ...options });

    logger.debug({ botId: this.botId, channel, delayMs }, "Delaying automated reply");
    if (delayMs <= 0) return;
    await this._sleep(delayMs);
  }

  async _setTypingPresence(jid, state) {
    if (!this.socket || !jid) return;
    try {
      if (typeof this.socket.presenceSubscribe === "function") {
        await this.socket.presenceSubscribe(jid);
      }
      if (typeof this.socket.sendPresenceUpdate === "function") {
        await this.socket.sendPresenceUpdate(state, jid);
      }
    } catch (err) {
      logger.debug({ botId: this.botId, jid, state, err: err.message }, "Presence update failed");
    }
  }

  async _startTypingPresence(jid) {
    if (!jid) return null;
    const sessionKey = normalizeJid(jid);
    const existing = this._typingSessions.get(sessionKey);
    if (existing) return existing;

    const session = {
      key: sessionKey,
      interval: null,
      stopped: false,
    };
    this._typingSessions.set(sessionKey, session);

    await this._setTypingPresence(sessionKey, "composing");
    session.interval = setInterval(() => {
      if (session.stopped) return;
      this._setTypingPresence(sessionKey, "composing").catch(() => {});
    }, AI_TYPING_REFRESH_MS);

    return session;
  }

  async _stopTypingPresence(jidOrSession) {
    const sessionKey = typeof jidOrSession === "string"
      ? normalizeJid(jidOrSession)
      : jidOrSession?.key;
    if (!sessionKey) return;

    const session = this._typingSessions.get(sessionKey);
    if (!session) return;

    session.stopped = true;
    if (session.interval) clearInterval(session.interval);
    this._typingSessions.delete(sessionKey);
    await this._setTypingPresence(sessionKey, "paused");
  }

  _clearAllTypingSessions() {
    for (const session of this._typingSessions.values()) {
      session.stopped = true;
      if (session.interval) clearInterval(session.interval);
    }
    this._typingSessions.clear();
  }

  _normalizeOutboundMessagePayload(message) {
    if (!message || typeof message !== "object") {
      throw new Error("Invalid message payload.");
    }

    if (typeof message.text === "string" && message.text.trim()) {
      return {
        payload: { text: message.text.trim() },
        label: "Text message",
        metadata: { payload_type: "text" },
      };
    }

    if (message.media) {
      const m = message.media;
      const mediaType = String(m.type ?? "").trim().toLowerCase();
      const source = resolveMediaSource(m.url);
      switch (mediaType) {
        case "image":
          return {
            payload: {
              image: source.buffer ?? { url: source.url },
              caption: m.caption ?? undefined,
              mimetype: m.mimetype ?? source.mimetype ?? undefined,
            },
            label: "Image",
            metadata: { payload_type: "image", mimetype: m.mimetype ?? source.mimetype ?? undefined },
          };
        case "video":
          return {
            payload: {
              video: source.buffer ?? { url: source.url },
              caption: m.caption ?? undefined,
              mimetype: m.mimetype ?? source.mimetype ?? undefined,
            },
            label: "Video",
            metadata: { payload_type: "video", mimetype: m.mimetype ?? source.mimetype ?? undefined },
          };
        case "document":
          return {
            payload: {
              document: source.buffer ?? { url: source.url },
              fileName: m.fileName ?? undefined,
              mimetype: m.mimetype ?? source.mimetype ?? undefined,
              caption: m.caption ?? undefined,
            },
            label: "Document",
            metadata: { payload_type: "document", fileName: m.fileName ?? null, mimetype: m.mimetype ?? source.mimetype ?? undefined },
          };
        case "audio":
        case "voice_note":
          return {
            payload: {
              audio: source.buffer ?? { url: source.url },
              mimetype: m.mimetype ?? source.mimetype ?? undefined,
              ptt: mediaType === "voice_note" || m.ptt === true,
            },
            label: mediaType === "voice_note" ? "Voice note" : "Audio",
            metadata: { payload_type: mediaType, mimetype: m.mimetype ?? source.mimetype ?? undefined },
          };
        case "sticker":
          return {
            payload: {
              sticker: source.buffer ?? { url: source.url },
              mimetype: m.mimetype ?? source.mimetype ?? undefined,
            },
            label: "Sticker",
            metadata: { payload_type: "sticker", mimetype: m.mimetype ?? source.mimetype ?? undefined },
          };
        default:
          throw new Error(`Unsupported media type "${mediaType}".`);
      }
    }

    if (message.location && typeof message.location === "object") {
      const location = message.location;
      const lat = Number(location.lat ?? location.latitude ?? location.degreesLatitude);
      const lng = Number(location.lng ?? location.longitude ?? location.degreesLongitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error("Location messages require numeric lat/lng values.");
      }
      const payload = {
        location: {
          degreesLatitude: lat,
          degreesLongitude: lng,
          name: location.name ?? undefined,
          address: location.address ?? undefined,
        },
      };
      return {
        payload,
        label: "Location",
        metadata: outboundPayloadMetadata(payload),
      };
    }

    if (message.contact && typeof message.contact === "object") {
      const contact = message.contact;
      const displayName = String(contact.name ?? contact.displayName ?? "").trim() || "Contact";
      const payload = {
        contacts: {
          displayName,
          contacts: [{
            displayName,
            vcard: contact.vcard ?? buildVCard({ name: displayName, phone: contact.phone }),
          }],
        },
      };
      return {
        payload,
        label: "Contact",
        metadata: outboundPayloadMetadata(payload),
      };
    }

    if (Array.isArray(message.contacts) && message.contacts.length > 0) {
      const contacts = message.contacts.map((contact, index) => {
        const displayName = String(contact?.name ?? contact?.displayName ?? "").trim() || `Contact ${index + 1}`;
        return {
          displayName,
          vcard: contact?.vcard ?? buildVCard({ name: displayName, phone: contact?.phone }),
        };
      });
      const payload = {
        contacts: {
          displayName: contacts[0]?.displayName ?? "Contacts",
          contacts,
        },
      };
      return {
        payload,
        label: "Contacts",
        metadata: outboundPayloadMetadata(payload),
      };
    }

    throw new Error("Invalid message payload.");
  }

  async _sendWithRetry(jid, payload) {
    let lastError = null;

    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await this.socket.sendMessage(jid, payload);
        return;
      } catch (err) {
        lastError = err;
        if (attempt >= SEND_RETRY_ATTEMPTS || !isRetriableSendError(err)) break;
        const delayMs = SEND_RETRY_BASE_DELAY_MS * attempt;
        logger.warn({ err, botId: this.botId, jid, attempt, delayMs }, "Outgoing send failed transiently, retrying");
        await this._sleep(delayMs);
      }
    }

    throw lastError ?? new Error("Message send failed.");
  }

  async _sendTrackedMessage(jid, payload, { eventType = "message_sent", details = "Message sent", metadata = {}, countUsage = true } = {}) {
    if (!this.socket) throw new Error("Bot socket is unavailable.");
    const normalizedJid = normalizeJid(jid);
    const isGroup = isGroupJid(normalizedJid);
    const conversationId = buildConversationId({
      botId: this.botId,
      chatJid: normalizedJid,
      senderJid: normalizedJid,
      isGroup,
    });

    await this._sendWithRetry(normalizedJid, payload);

    if (countUsage) {
      this._queueUsage({ totalMessages: 1, lastActivity: new Date().toISOString() });
    }

    await this._log(eventType, details, {
      direction: "outbound",
      conversation_id: conversationId,
      chat_jid: normalizedJid,
      to: normalizedJid,
      body: extractPreview(payload).slice(0, 2000),
      isGroup,
      ...outboundPayloadMetadata(payload),
      ...metadata,
    });

    if (!isGroup) {
      await this._touchContact({
        jid: normalizedJid,
        lastMessageAt: new Date().toISOString(),
        metadata: { last_direction: "outbound" },
      });
      const preview = extractPreview(payload);
      if (preview) {
        await this._appendConversationTurn({
          conversationId,
          contactJid: normalizedJid,
          isGroup: false,
          role: "assistant",
          text: preview,
          markAiResponse: eventType === "ai_reply_sent",
        });
      }
    }
  }

  /* ── Exponential backoff reconnect ───────────────────────── */

  _scheduleReconnect() {
    if (this._destroyed) return;
    this._reconnectAttempts++;

    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error({ botId: this.botId, attempts: this._reconnectAttempts }, "Max reconnect attempts reached");
      this._setStatus("failed").catch(() => {});
      this._log("bot_error", `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Open bot settings → QR tab to manually reconnect.`).catch(() => {});
      return;
    }

    const jitter  = Math.random() * 1_000;
    const backoff = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1);
    const delayMs = Math.min(RECONNECT_MAX_MS, backoff) + jitter;

    logger.info({ botId: this.botId, attempt: this._reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS, delayMs: Math.round(delayMs) }, "Scheduling reconnect");
    this._setStatus("reconnecting").catch(() => {});
    this._log("bot_reconnecting", `Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} — retrying in ${(delayMs / 1000).toFixed(1)}s`).catch(() => {});

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._destroyed) this.start();
    }, delayMs);
  }

  /* ── QR timeout ───────────────────────────────────────────── */

  _startQrTimeout() {
    this._clearQrTimeout();
    this._qrTimeoutTimer = setTimeout(async () => {
      if (this._destroyed || !QR_AUTH_STATUSES.has(this.status)) return;
      logger.warn({ botId: this.botId }, "QR scan timeout (2 min) — stopping socket");
      await this._teardownSocket();
      await this._setStatus("disconnected").catch(() => {});
      await this._log("bot_qr_timeout", "QR code was not scanned within 2 minutes. Open bot settings → QR tab and click Reconnect to try again.").catch(() => {});
    }, QR_TIMEOUT_MS);
  }

  _clearQrTimeout() {
    if (this._qrTimeoutTimer) {
      clearTimeout(this._qrTimeoutTimer);
      this._qrTimeoutTimer = null;
    }
  }

  /* ── Group participant events ─────────────────────────────── */

  async _onGroupParticipants({ id, participants, action }) {
    if (this.config.bot_type === "dm") return;
    const sac = this.config.sales_agent_config ?? {};
    for (const jid of participants) {
      if (action === "add" && sac.group_welcome && this.socket) {
        try {
          await this._sendTrackedMessage(id, {
            text: sac.group_welcome.replace("{name}", jid.replace("@s.whatsapp.net", ""))
          }, {
            eventType: "message_sent",
            details: `Group welcome sent in ${id}`,
            metadata: { channel: "group_welcome" }
          });
        } catch {}
      }
    }
  }

  /* ── Message routing ──────────────────────────────────────── */

  async _onMessages({ messages, type }) {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const messageTimestampMs = Number(msg.messageTimestamp ?? 0) * 1000;
      if (messageTimestampMs && messageTimestampMs < (this._socketStartedAt - 60_000)) {
        logger.debug({ botId: this.botId, msgId: msg.key?.id }, "Skipping replayed historical message after reconnect");
        continue;
      }
      if (!this._markInboundMessageSeen(msg.key?.id ?? null)) {
        logger.debug({ botId: this.botId, msgId: msg.key?.id }, "Skipping duplicate inbound message event");
        continue;
      }
      try {
        await this._handleInbound(msg);
      } catch (err) {
        logger.warn({ err, botId: this.botId, msgId: msg.key?.id }, "Failed to process inbound message — skipping");
      }
    }
  }

  async _handleInbound(msg) {
    const jid     = msg.key.remoteJid ?? "";
    const isGroup = isGroupJid(jid);
    const isDM    = !isGroup && !isBroadcastJid(jid);
    const botType = this.config.bot_type ?? "dm";
    const messageId = msg.key?.id ?? null;

    /* ── Route by bot type ─────────────────────────────────── */
    if (botType === "dm"    && !isDM)    return;
    if (botType === "group" && !isGroup) return;

    /* ── Sender JID ────────────────────────────────────────── */
    // ✅ FIX: always normalizeJid — device-scoped JIDs (12345:6@s.whatsapp.net)
    //         cause silent admin-check mismatches if not stripped
    const rawSenderJid = isGroup
      ? (msg.key.participant || msg.participant || "")
      : jid;
    const senderJid = normalizeJid(rawSenderJid);
    const botJid = normalizeJid(this.socket?.user?.id ?? "");

    if (botJid && (isSameWhatsAppAccount(senderJid, botJid) || (!isGroup && isSameWhatsAppAccount(jid, botJid)))) {
      logger.debug({
        botId: this.botId,
        jid: normalizeJid(jid),
        senderJid,
        botJid,
        messageId,
      }, "Skipping self message to avoid command/AI loop");
      return;
    }

    if (isGroup) {
      if (!botJid || !senderJid) return;
    }

    /* ── Extract message body ──────────────────────────────── */
    const { text: body, type: msgType, extra } = extractMessageBody(msg);
    const conversationId = buildConversationId({
      botId: this.botId,
      chatJid: jid,
      senderJid,
      isGroup,
    });
    const mediaAwareBody = this._buildMediaAiInput({ body, msgType, extra });
    const normalizedBody = compactWhitespace(mediaAwareBody || body);
    this._recentChatActivity.set(normalizeJid(jid), Date.now());

    logger.debug({
      botId: this.botId,
      jid: normalizeJid(jid),
      senderJid,
      messageId,
      msgType,
      isGroup,
    }, "Inbound message parsed");

    /* ── Plan limit check (fast in-memory, then DB) ─────────── */
    const limit = PLAN_MSG_LIMITS[this.config.plan_tier] ?? PLAN_MSG_LIMITS.free;

    // ✅ FIX: in-memory fast-reject to avoid a DB round-trip on every message
    //         when the bot is already known to be over limit
    const localUsage = this.config.messages_this_month ?? 0;
    if (localUsage >= limit) return;

    // DB authoritative check (prevents multi-bot over-counting)
    const { data: user } = await supabase
      .from("users")
      .select("messages_this_month, plan_tier")
      .eq("id", this.userId)
      .single();
    const dbUsage = user?.messages_this_month ?? 0;
    if (dbUsage >= limit) {
      logger.warn({ botId: this.botId, userId: this.userId, dbUsage, limit }, "Monthly message limit reached");
      return;
    }

    /* ── Increment counters ────────────────────────────────── */
    // ✅ FIX: counters now increment AFTER the limit check (were before it previously)
    await this._incrementUserMonthlyCounter();
    this.config.messages_this_month = (this.config.messages_this_month ?? 0) + 1;
    this._queueUsage({ messagesThisMonth: 1, totalMessages: 1, lastActivity: new Date().toISOString() });

    const fromDisplay = isGroup ? jid : jid.replace("@s.whatsapp.net", "");
    await this._log("message_received", `[${msgType}] from ${fromDisplay}`, {
      from: jid,
      body: body.slice(0, 200),
      type: msgType,
      extra,
      direction: "inbound",
      conversation_id: conversationId,
      chat_jid: normalizeJid(jid),
      sender_jid: senderJid,
      message_id: msg.key?.id ?? null,
      isGroup,
    });

    if (!isGroup) {
      await this._touchContact({
        jid: senderJid,
        displayName: extra?.displayName ?? "",
        lastMessageAt: new Date().toISOString(),
        metadata: { last_direction: "inbound" },
      });
      if (normalizedBody) {
        await this._appendConversationTurn({
          conversationId,
          contactJid: senderJid,
          isGroup: false,
          role: "user",
          text: normalizedBody,
          profilePatch: this._extractProfilePatch({ senderJid, body: normalizedBody, extra }),
        });
      }
    }

    /* ── Webhook ────────────────────────────────────────────── */
    if (this.config.webhook_url) {
      this._dispatchWebhook({
        event: "message_received",
        botId: this.botId,
        from: fromDisplay,
        body,
        type: msgType,
        isGroup,
        extra,
        message: {
          id: messageId,
          type: msgType,
          text: body || null,
          summary: body || null,
          metadata: extra,
        },
        timestamp: Date.now(),
        messageId,
        conversationId,
      }).catch(() => {});
    }

    if (!normalizedBody && !["list_reply", "button_reply", "template_reply"].includes(msgType)) {
      if (["voice_note", "audio", "image", "video", "document"].includes(msgType)) {
        await this._sendMediaProcessingFallback(jid, msgType);
      }
      return;
    }

    /* ── GROUP FLOW ─────────────────────────────────────────── */
    if (isGroup) {
      const moderationEnabled = Boolean(
        this.config.group_management_config?.anti_link?.enabled ||
        this.config.group_management_config?.anti_spam?.enabled ||
        this.config.group_management_config?.anti_vulgar?.enabled
      );
      const looksLikeGroupCommand = body.trim().startsWith(".");
      const botIsAdmin = (moderationEnabled || looksLikeGroupCommand)
        ? await this._isBotAdmin(jid)
        : false;

      if (moderationEnabled && botIsAdmin) {
        const moderated = await this._handleGroupModeration(msg, jid, senderJid, body);
        if (moderated) return;
      }
      if (await this._handleGroupCommand(msg, jid, senderJid, normalizedBody, extra)) return;

      if (await this._handleCommand(jid, normalizedBody)) return;
      if (await this._handleKeywordTrigger(jid, normalizedBody)) return;
      if (await this._handleSalesAgent(jid, normalizedBody)) return;
      if (await this._handleAiResponse(jid, normalizedBody, extra, true, { messageId, conversationId, msgType })) return;
      return;
    }

    /* ── DM FLOW ────────────────────────────────────────────── */
    await this._handleWelcomeMessage(jid);
    await this._handleFirstDmHelp(jid);

    if (await this._handleCommand(jid, normalizedBody)) return;
    if (await this._handleKeywordTrigger(jid, normalizedBody)) return;
    if (await this._handleSalesAgent(jid, normalizedBody)) return;
    if (await this._handleAssistantMode(jid, normalizedBody, { conversationId, senderJid, extra, isGroup: false })) return;
    if (await this._handleAiResponse(jid, normalizedBody, extra, false, { messageId, conversationId, msgType })) return;

    if (this.config.auto_reply_enabled && this.config.auto_reply_message && this.socket) {
      try {
        await this._waitForReplyWindow("auto_reply");
        await this._sendTrackedMessage(jid, { text: this.config.auto_reply_message }, {
          eventType: "message_sent",
          details: `Auto-reply sent to ${fromDisplay}`,
          metadata: { channel: "auto_reply" }
        });
        await this._log("auto_reply_sent", `Auto-reply sent to ${fromDisplay}`);
      } catch (err) {
        logger.error({ err, botId: this.botId }, "Auto-reply failed");
      }
    }
  }

  _buildMediaAiInput({ body = "", msgType = "", extra = {} } = {}) {
    if (body?.trim()) return body.trim();

    switch (msgType) {
      case "image":
        return compactWhitespace(`The user sent an image.${extra?.caption ? ` Caption: ${extra.caption}` : ""} Tell them the image was received and ask for a short description if needed.`);
      case "video":
        return compactWhitespace(`The user sent a video.${extra?.caption ? ` Caption: ${extra.caption}` : ""} Duration: ${extra?.seconds ?? "unknown"} seconds. Reply naturally and request a summary if analysis is needed.`);
      case "document":
        return compactWhitespace(`The user sent a document named ${extra?.fileName ?? "a file"} with type ${extra?.mimetype ?? "unknown"}. If you cannot inspect the content, say the document was received and ask what they need from it.`);
      case "voice_note":
      case "audio":
        return "The user sent a voice note or audio file. We could not transcribe it yet. Acknowledge receipt and ask them to resend as text if they need a detailed answer.";
      default:
        return "";
    }
  }

  async _sendMediaProcessingFallback(jid, msgType) {
    try {
      await this._sendTrackedMessage(jid, { text: "Media received but cannot be processed right now." }, {
        eventType: "message_sent",
        details: `Media fallback sent for ${msgType}`,
        metadata: { channel: "media_fallback", media_type: msgType },
      });
    } catch (err) {
      logger.warn({ err, botId: this.botId, jid, msgType }, "Failed to send media processing fallback");
    }
  }

  /* ── First-DM auto-help ───────────────────────────────────── */

  async _handleFirstDmHelp(jid) {
    const gmc = this.config.group_management_config ?? {};
    if (!gmc.auto_help_on_first_dm) return;
    if (this._seenDmContacts.has(jid)) return;
    this._seenDmContacts.add(jid);

    const enabledCmds = Object.entries(DEFAULT_COMMANDS)
      .filter(([k]) => (this.config.commands_config?.[k]?.enabled ?? true))
      .map(([, v]) => v.trigger);

    const helpText = `👋 *Welcome!*\n\nHere are the available commands:\n${enabledCmds.join("\n")}\n\nReply with any command to get started.`;
    try {
      await this._sendTrackedMessage(jid, { text: helpText }, {
        eventType: "message_sent",
        details: `First-DM help sent to ${jid}`,
        metadata: { channel: "first_dm_help" }
      });
    } catch {}
  }

  async _handleWelcomeMessage(jid) {
    const sac = this.config.sales_agent_config ?? {};
    if (!sac.enabled || !sac.welcome_enabled) return;
    if (!String(sac.greeting ?? "").trim()) return;
    if (this._welcomedDmContacts.has(jid)) return;
    this._welcomedDmContacts.add(jid);
    try {
      await this._sendTrackedMessage(jid, { text: String(sac.greeting).trim() }, {
        eventType: "message_sent",
        details: `Welcome sent to ${jid.replace("@s.whatsapp.net", "")}`,
        metadata: { channel: "dm_welcome" }
      });
      await this._log("welcome_message_sent", `Welcome sent to ${jid.replace("@s.whatsapp.net", "")}`);
    } catch {}
  }

  /* ── Group helper queries ─────────────────────────────────── */

  async getAdminGroups() {
    if (!this.socket || this.status !== "connected") return [];
    try {
      const groups = await this.socket.groupFetchAllParticipating();
      const botJid = normalizeJid(this.socket.user?.id ?? "");
      return Object.values(groups).filter((g) => {
        const p = g.participants.find((p) =>
          normalizeJid(p.id) === botJid ||
          normalizeJid(p.id).split("@")[0] === botJid.split("@")[0]
        );
        return p?.admin === "admin" || p?.admin === "superadmin";
      });
    } catch { return []; }
  }

  async _getGroupMeta(groupJid) {
    const cached = this._metaCache.get(groupJid);
    if (cached && (Date.now() - cached.cachedAt) < META_CACHE_TTL) return cached.meta;
    try {
      const meta = await this.socket.groupMetadata(groupJid);
      this._metaCache.set(groupJid, { meta, cachedAt: Date.now() });
      return meta;
    } catch { return null; }
  }

  async _isBotAdmin(groupJid) {
    const meta   = await this._getGroupMeta(groupJid);
    if (!meta) return false;
    const botJid = normalizeJid(this.socket?.user?.id ?? "");
    return meta.participants.some((p) => {
      const pNorm = normalizeJid(p.id);
      return (pNorm === botJid || pNorm.split("@")[0] === botJid.split("@")[0])
        && (p.admin === "admin" || p.admin === "superadmin");
    });
  }

  async _isSenderAdmin(groupJid, senderJid) {
    const meta = await this._getGroupMeta(groupJid);
    if (!meta) return false;
    const p = meta.participants.find((p) => normalizeJid(p.id) === senderJid);
    return p?.admin === "admin" || p?.admin === "superadmin";
  }

  /* ── Strike helpers ───────────────────────────────────────── */

  _addStrike(groupJid, userJid) {
    const key = `${groupJid}:${userJid}`;
    const n   = (this._strikes.get(key) ?? 0) + 1;
    this._strikes.set(key, n);
    return n;
  }
  _getStrikes(groupJid, userJid)  { return this._strikes.get(`${groupJid}:${userJid}`) ?? 0; }
  _clearStrikes(groupJid, userJid) { this._strikes.delete(`${groupJid}:${userJid}`); }

  /* ── Group moderation ─────────────────────────────────────── */

  async _handleGroupModeration(msg, groupJid, senderJid, body) {
    const gmc = this.config.group_management_config ?? {};
    const senderIsAdmin = await this._isSenderAdmin(groupJid, senderJid);
    if (senderIsAdmin) return false; // admins are exempt

    let violated = false;
    let reason   = "";

    if (gmc.anti_link?.enabled && LINK_REGEX.test(body)) {
      violated = true;
      reason   = "anti_link";
      try { await this.socket?.sendMessage(groupJid, { delete: msg.key }); } catch {}
    }

    if (!violated && gmc.anti_vulgar?.enabled) {
      const words   = Array.isArray(gmc.anti_vulgar.words) ? gmc.anti_vulgar.words : [];
      const bodyLow = body.toLowerCase();
      const found   = words.find((w) => w && bodyLow.includes(String(w).toLowerCase()));
      if (found) {
        violated = true;
        reason   = "anti_vulgar";
        try { await this.socket?.sendMessage(groupJid, { delete: msg.key }); } catch {}
      }
    }

    if (!violated && gmc.anti_spam?.enabled) {
      const threshold = gmc.anti_spam.threshold          ?? 5;
      const window    = (gmc.anti_spam.window_seconds    ?? 10) * 1000;
      const now       = Date.now();
      const key       = `${groupJid}:${senderJid}`;
      const times     = (this._spamTracker.get(key) ?? []).filter((t) => now - t < window);
      times.push(now);
      this._spamTracker.set(key, times);
      if (times.length >= threshold) {
        violated = true;
        reason   = "anti_spam";
        this._spamTracker.set(key, []);
      }
    }

    if (!violated) return false;

    const strikes    = this._addStrike(groupJid, senderJid);
    const shortJid   = senderJid.replace("@s.whatsapp.net", "");
    const maxStrikes = 3;
    const action     = gmc[reason]?.action ?? "warn";

    if (action === "kick" || strikes >= maxStrikes) {
      try {
        await this.socket?.groupParticipantsUpdate(groupJid, [senderJid], "remove");
        await this.socket?.sendMessage(groupJid, {
          text: `🚫 @${shortJid} has been removed for violating group rules (${reason.replace("_", "-")}).`,
          mentions: [senderJid]
        });
        this._clearStrikes(groupJid, senderJid);
        await this._log("group_moderation", `Removed @${shortJid} — ${reason} (${strikes} strikes)`, { groupJid, senderJid });
      } catch (err) {
        logger.error({ err }, "Group kick failed");
      }
    } else {
      try {
        await this.socket?.sendMessage(groupJid, {
          text: `⚠️ @${shortJid}, this message was removed (${reason.replace("_", "-")}). Strike *${strikes}/${maxStrikes}*. You will be removed after ${maxStrikes} strikes.`,
          mentions: [senderJid]
        });
        await this._log("group_moderation", `Warned @${shortJid} — ${reason} strike ${strikes}/${maxStrikes}`, { groupJid, senderJid });
      } catch {}
    }
    return true;
  }

  /* ── Group management commands ────────────────────────────── */

  async _handleGroupCommand(msg, groupJid, senderJid, body, extra = {}) {
    const lower = body.trim().toLowerCase();
    const isGCmd = GROUP_COMMANDS.some(
      (c) => lower === c || lower.startsWith(c + " ") || lower.startsWith(c + "@")
    );
    if (!isGCmd) return false;

    const parts     = body.trim().split(/\s+/);
    const cmd       = parts[0].toLowerCase();
    const mentioned = Array.isArray(extra.mentionedJid) ? extra.mentionedJid : [];

    let targetJid = mentioned[0] ?? extra.quotedParticipant ?? null;
    if (!targetJid && parts[1]) {
      const maybePhone = parts[1].replace(/[^\d]/g, "");
      if (maybePhone.length >= 7) targetJid = `${maybePhone}@s.whatsapp.net`;
    }
    const shortTarget = targetJid ? targetJid.replace("@s.whatsapp.net", "") : null;
    const senderIsAdmin = await this._isSenderAdmin(groupJid, senderJid);

    /* .help is open to everyone */
    if (cmd === ".help") {
      const gmc = this.config.group_management_config ?? {};
      const lines = [
        "*📋 Group Commands*", "",
        "*.help* — Show this list",
        "*.kick @user* — Remove a member (admin only)",
        "*.ban @user* — Remove a member (admin only)",
        "*.lock* — Lock group so only admins can send",
        "*.unlock* — Allow all members to send",
        "*.promote @user* — Make someone an admin",
        "*.demote @user* — Remove someone's admin role",
        "*.warn @user [reason]* — Warn a member",
        "*.warnings @user* — Check someone's warnings",
        "*.clearwarn @user* — Clear someone's warnings",
        "*.tagall [msg]* — Mention all members",
        "*.admins* — List group admins",
        "*.rules* — Show group rules",
        "", "*🛡 Auto-moderation*"
      ];
      if (gmc.anti_link?.enabled)   lines.push("• Anti-link: ON — links from non-admins are removed");
      if (gmc.anti_spam?.enabled)   lines.push("• Anti-spam: ON — excessive messages trigger a warning");
      if (gmc.anti_vulgar?.enabled) lines.push("• Anti-vulgar: ON — profanity is filtered");
      if (!gmc.anti_link?.enabled && !gmc.anti_spam?.enabled && !gmc.anti_vulgar?.enabled)
        lines.push("• No auto-moderation enabled");
      lines.push("", "3 strikes → automatic removal");
      try { await this.socket?.sendMessage(groupJid, { text: lines.join("\n") }); } catch {}
      return true;
    }

    /* All other commands require sender to be admin */
    if (!senderIsAdmin) {
      try {
        await this.socket?.sendMessage(groupJid, {
          text: `⛔ @${senderJid.replace("@s.whatsapp.net", "")}, only group admins can use that command.`,
          mentions: [senderJid]
        });
      } catch {}
      return true;
    }

    switch (cmd) {
      case ".kick":
      case ".ban": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: `❌ Usage: ${cmd} @user` }).catch(() => {}); break; }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "remove");
          await this.socket?.sendMessage(groupJid, { text: `✅ @${shortTarget} has been removed.`, mentions: [targetJid] });
          await this._log("group_command", `${cmd}: removed @${shortTarget}`, { groupJid, targetJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not remove @${shortTarget}. Make sure I am an admin.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }
      case ".lock": {
        try {
          await this.socket?.groupSettingUpdate(groupJid, "announcement");
          await this.socket?.sendMessage(groupJid, { text: "🔒 Group is now *locked*. Only admins can send messages." });
          await this._log("group_command", "Group locked", { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not lock the group. Ensure I have admin rights." }).catch(() => {});
        }
        break;
      }
      case ".unlock": {
        try {
          await this.socket?.groupSettingUpdate(groupJid, "not_announcement");
          await this.socket?.sendMessage(groupJid, { text: "🔓 Group is now *unlocked*. Everyone can send messages." });
          await this._log("group_command", "Group unlocked", { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not unlock the group." }).catch(() => {});
        }
        break;
      }
      case ".promote": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .promote @user" }).catch(() => {}); break; }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "promote");
          await this.socket?.sendMessage(groupJid, { text: `⬆️ @${shortTarget} has been promoted to admin.`, mentions: [targetJid] });
          this._metaCache.delete(groupJid);
          await this._log("group_command", `.promote @${shortTarget}`, { groupJid, targetJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not promote @${shortTarget}.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }
      case ".demote": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .demote @user" }).catch(() => {}); break; }
        try {
          await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "demote");
          await this.socket?.sendMessage(groupJid, { text: `⬇️ @${shortTarget} has been demoted from admin.`, mentions: [targetJid] });
          this._metaCache.delete(groupJid);
          await this._log("group_command", `.demote @${shortTarget}`, { groupJid, targetJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: `❌ Could not demote @${shortTarget}.`, mentions: [targetJid] }).catch(() => {});
        }
        break;
      }
      case ".warn": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .warn @user [reason]" }).catch(() => {}); break; }
        const warnReason = parts.slice(2).join(" ") || "No reason given";
        const wKey       = `${groupJid}:${targetJid}`;
        const warnCount  = (this._warnCount.get(wKey) ?? 0) + 1;
        this._warnCount.set(wKey, warnCount);
        const maxWarns   = 3;
        if (warnCount >= maxWarns) {
          try {
            await this.socket?.groupParticipantsUpdate(groupJid, [targetJid], "remove");
            await this.socket?.sendMessage(groupJid, { text: `🚫 @${shortTarget} reached *${maxWarns} warnings* and has been removed.\nReason: ${warnReason}`, mentions: [targetJid] });
            this._warnCount.delete(wKey);
            await this._log("group_command", `.warn (removed) @${shortTarget}`, { groupJid, targetJid });
          } catch {
            await this.socket?.sendMessage(groupJid, { text: `❌ Could not remove @${shortTarget} after ${maxWarns} warnings.`, mentions: [targetJid] }).catch(() => {});
          }
        } else {
          await this.socket?.sendMessage(groupJid, { text: `⚠️ @${shortTarget} has been warned (*${warnCount}/${maxWarns}*).\nReason: ${warnReason}`, mentions: [targetJid] }).catch(() => {});
          await this._log("group_command", `.warn ${warnCount}/${maxWarns} @${shortTarget}`, { groupJid, targetJid });
        }
        break;
      }
      case ".warnings": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .warnings @user" }).catch(() => {}); break; }
        const wc = this._warnCount.get(`${groupJid}:${targetJid}`) ?? 0;
        await this.socket?.sendMessage(groupJid, { text: `📋 @${shortTarget} has *${wc}/3* warnings.`, mentions: [targetJid] }).catch(() => {});
        break;
      }
      case ".clearwarn": {
        if (!targetJid) { await this.socket?.sendMessage(groupJid, { text: "❌ Usage: .clearwarn @user" }).catch(() => {}); break; }
        this._warnCount.delete(`${groupJid}:${targetJid}`);
        this._clearStrikes(groupJid, targetJid);
        await this.socket?.sendMessage(groupJid, { text: `✅ Warnings cleared for @${shortTarget}.`, mentions: [targetJid] }).catch(() => {});
        await this._log("group_command", `.clearwarn @${shortTarget}`, { groupJid, targetJid });
        break;
      }
      case ".tagall": {
        const tagMsg = parts.slice(1).join(" ");
        try {
          const meta    = await this._getGroupMeta(groupJid);
          if (!meta) break;
          const members  = meta.participants.map((p) => p.id);
          const mentions = members.map((m) => `@${m.replace("@s.whatsapp.net", "")}`).join(" ");
          await this.socket?.sendMessage(groupJid, { text: (tagMsg ? `${tagMsg}\n\n` : "") + mentions, mentions: members });
          await this._log("group_command", `.tagall (${members.length} members)`, { groupJid });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not fetch group members." }).catch(() => {});
        }
        break;
      }
      case ".admins": {
        try {
          const meta   = await this._getGroupMeta(groupJid);
          if (!meta) break;
          const admins   = meta.participants.filter((p) => p.admin).map((p) => p.id);
          const mentions = admins.map((m) => `@${m.replace("@s.whatsapp.net", "")}`);
          await this.socket?.sendMessage(groupJid, { text: `👑 *Group Admins:*\n${mentions.join("\n")}`, mentions: admins });
        } catch {
          await this.socket?.sendMessage(groupJid, { text: "❌ Could not fetch admin list." }).catch(() => {});
        }
        break;
      }
      case ".rules": {
        const rules = (this.config.group_management_config ?? {}).rules?.trim();
        await this.socket?.sendMessage(groupJid, { text: rules || "📜 No group rules have been set yet. Contact an admin." }).catch(() => {});
        break;
      }
      default: break;
    }
    return true;
  }

  /* ── DM commands ──────────────────────────────────────────── */

  async _handleCommand(jid, body) {
    if (!body.startsWith("/")) return false;
    const cmd    = body.split(" ")[0].toLowerCase();
    const cmdKey = Object.keys(DEFAULT_COMMANDS).find((k) => DEFAULT_COMMANDS[k].trigger === cmd);
    if (!cmdKey) return false;

    const override = this.config.commands_config?.[cmdKey] ?? {};
    if (override.enabled === false) return false;

    const sac      = this.config.sales_agent_config ?? {};
    const products = sac.products ?? [];

    if (override.custom_response) {
      await this._sendTrackedMessage(jid, { text: override.custom_response }, {
        eventType: "message_sent",
        details: `Command ${cmd} custom response`,
        metadata: { channel: "command", command: cmdKey }
      });
      await this._log("command_handled", `Command ${cmd} → custom response`);
      return true;
    }

    let reply = null;
    switch (cmdKey) {
      case "help": {
        const enabledCmds = Object.entries(DEFAULT_COMMANDS)
          .filter(([k]) => (this.config.commands_config?.[k]?.enabled ?? true))
          .map(([, v]) => v.trigger);
        reply = `*Available commands:*\n${enabledCmds.join("\n")}`;
        break;
      }
      case "catalog":
      case "price":
        reply = products.length ? formatCatalog(products) : "No catalog available yet.";
        break;
      case "contact":
        reply = "Our team will contact you shortly. Please hold on.";
        break;
      case "stop":
        reply = "You have unsubscribed. Send any message to re-subscribe.";
        break;
      case "agent":
        reply = "Connecting you to a live agent. Please wait…";
        break;
      case "hours":
        reply = "Business hours: Monday–Friday, 9am–6pm.";
        break;
      case "order":
        reply = this.config.website_url
          ? `To place an order, visit: ${this.config.website_url}`
          : "To order, please contact our sales team directly.";
        break;
    }

    if (reply) {
      try {
        await this._sendTrackedMessage(jid, { text: reply }, {
          eventType: "message_sent",
          details: `Command ${cmd}`,
          metadata: { channel: "command", command: cmdKey }
        });
        await this._log("command_handled", `Command ${cmd}`);
      } catch (err) {
        logger.error({ err }, "Command reply failed");
      }
    }
    return true;
  }

  /* ── Keyword triggers ─────────────────────────────────────── */

  async _handleKeywordTrigger(jid, body) {
    const triggers = Array.isArray(this.config.keyword_triggers) ? this.config.keyword_triggers : [];
    if (!triggers.length) return false;

    for (const trigger of triggers) {
      if (!trigger.keyword || !trigger.response) continue;
      if (trigger.enabled === false) continue;

      const cs       = trigger.caseSensitive === true;
      const haystack = cs ? body : body.toLowerCase();
      const needle   = cs ? String(trigger.keyword).trim() : String(trigger.keyword).toLowerCase().trim();
      const matchType = trigger.matchType ?? (trigger.exact_match === true ? "exact" : "contains");

      let hit = false;
      try {
        switch (matchType) {
          case "exact":       hit = haystack === needle; break;
          case "starts_with": hit = haystack.startsWith(needle); break;
          case "ends_with":   hit = haystack.endsWith(needle); break;
          case "regex": {
            const flags = cs ? "" : "i";
            hit = new RegExp(trigger.keyword, flags).test(body);
            break;
          }
          default:            hit = haystack.includes(needle); break;
        }
      } catch { hit = false; }

      if (hit) {
        try {
          await this._sendTrackedMessage(jid, { text: trigger.response }, {
            eventType: "message_sent",
            details: `Keyword trigger matched: "${needle}" (${matchType})`,
            metadata: { channel: "keyword_trigger", keyword: needle, matchType }
          });
          await this._log("keyword_reply_sent", `Keyword trigger matched: "${needle}" (${matchType})`);
        } catch {}
        return true;
      }
    }
    return false;
  }

  /* ── Sales agent ──────────────────────────────────────────── */

  async _handleSalesAgent(jid, body) {
    const sac = this.config.sales_agent_config ?? {};
    if (!sac.enabled) return false;

    const bodyL    = body.toLowerCase();
    const products = sac.products ?? [];

    if (sac.show_catalog_on_keyword) {
      const catalogKw = ["catalog", "products", "price", "menu", "catalogue", "list", "items", "stock", "available"];
      if (catalogKw.some((k) => bodyL.includes(k)) && products.length) {
        const catalog = formatCatalog(products);
        try {
          await this._sendTrackedMessage(jid, { text: catalog }, {
            eventType: "message_sent",
            details: `Catalog sent to ${jid}`,
            metadata: { channel: "sales_catalog" }
          });
        } catch {}
        return true;
      }
    }

    if (products.length && body.length > 1) {
      const match = products.find((p) => bodyL.includes(String(p.name).toLowerCase()));
      if (match) {
        const reply = `*${match.name}*\n💰 ₦${match.price || "Contact for price"}\n${match.description || ""}`;
        try {
          await this._sendTrackedMessage(jid, { text: reply }, {
            eventType: "message_sent",
            details: `Product reply sent for ${match.name}`,
            metadata: { channel: "sales_product", product: match.name }
          });
        } catch {}
        return true;
      }
      const productWords = ["buy", "order", "want", "price of", "how much", "get"];
      if (productWords.some((w) => bodyL.includes(w))) {
        const msg = this.config.catalog_unavail_msg
          ?? (this.config.website_url ? `❌ Product not available. Check our website: ${this.config.website_url}` : "❌ Product not available. Our seller will be in touch shortly.");
        try {
          await this._sendTrackedMessage(jid, { text: msg }, {
            eventType: "message_sent",
            details: `Unavailable product fallback sent to ${jid}`,
            metadata: { channel: "sales_unavailable" }
          });
        } catch {}
        return true;
      }
    }
    return false;
  }

  /* ── AI response (paid plan only) ────────────────────────── */

  async _handleAiResponse(jid, body, extra = {}, isGroup = false, context = {}) {
    const ai = this.config.ai_config ?? {};
    const messageId = context.messageId ?? null;
    const normalizedJid = normalizeJid(jid);

    if (!ai.enabled || !ai.encrypted_key || this.config.plan_tier !== "paid") {
      logger.debug({
        botId: this.botId,
        jid: normalizedJid,
        messageId,
        aiEnabled: Boolean(ai.enabled),
        hasKey: Boolean(ai.encrypted_key),
        planTier: this.config.plan_tier,
      }, "Skipping AI response because runtime AI is not eligible");
      return false;
    }
    if (!body?.trim()) return false;

    if (isGroup  && ai.groups_enabled === false) return false;
    if (!isGroup && ai.dm_enabled     === false) return false;

    const triggerMode = isGroup
      ? (ai.group_trigger_mode ?? ai.trigger_mode ?? "mention")
      : (ai.dm_trigger_mode    ?? ai.trigger_mode ?? "all");

    if (triggerMode === "mention") {
      const botJid       = normalizeJid(this.socket?.user?.id ?? "");
      const mentioned    = Array.isArray(extra?.mentionedJid) ? extra.mentionedJid : [];
      const botMentioned = mentioned.some((m) =>
        normalizeJid(m) === botJid || normalizeJid(m).split("@")[0] === botJid.split("@")[0]
      );
      if (!botMentioned) return false;
    } else if (triggerMode === "keyword") {
      const prefix = (ai.trigger_prefix ?? "@bot").toLowerCase().trim();
      if (!body.toLowerCase().trimStart().startsWith(prefix)) return false;
      body = body.slice(body.toLowerCase().indexOf(prefix) + prefix.length).trim();
      if (!body) return false;
    }

    let typingSession = null;
    try {
      const apiKey = decryptApiKey(ai.encrypted_key, env.jwtSecret);
      logger.info({
        botId: this.botId,
        jid: normalizedJid,
        messageId,
        provider: ai.provider,
        model: ai.model,
        hasApiKey: Boolean(apiKey),
      }, "AI provider selected");
      if (!apiKey) {
        logger.warn({ botId: this.botId, provider: ai.provider, messageId }, "Stored AI API key could not be decrypted");
        return false;
      }

      const sac      = this.config.sales_agent_config ?? {};
      const products = sac.products ?? [];
      const catalog  = products.length
        ? `\n\nProducts:\n${products.map((p) => `- ${p.name}: ₦${p.price || "?"} — ${p.description || ""}`).join("\n")}`
        : "";

      // Build structured messages (roles) instead of concatenating a single systemPrompt.
      // Roles: multiple system messages (safety, admin context, bot config), developer (bot personality), then user.
      const baseRules = `You are a helpful WhatsApp assistant for a business. Be concise and friendly. Answer in 1-3 sentences maximum.`;
      const configPrompt = isGroup ? (ai.group_system_prompt || null) : (ai.system_prompt || null);
  const userCustomPrompt = (ai.user_custom_prompt && String(ai.user_custom_prompt).trim()) || null;
  const assistantAdminNumbers = Array.isArray(ai.assistant_admin_numbers) ? ai.assistant_admin_numbers : [];

      const memoryBlock = await this._buildAiConversationMemory(context.conversationId ?? null, messageId);
      const userMessageBody = memoryBlock
        ? `Recent conversation:\n${memoryBlock}\n\nCurrent user message:\n${body}`
        : body;

      const isAdmin = this._isAssistantAdmin(senderJid);
      const senderNumber = extractPhoneFromJid(senderJid) || null;

      // Use PromptEngine to strictly compile messages (server-controlled system blocks only)
      const compiled = compilePrompt({
        baseRules,
        botConfig: configPrompt,
        catalog,
        adminMeta: { assistantAdminNumbers },
        userCustomPrompt: userCustomPrompt,
        userMessage: userMessageBody,
      });

      if (!compiled.ok) {
        this._log('ai_request_rejected', { reason: compiled.error }, { sender_number: senderNumber });
        return null;
      }

      const messages = compiled.messages;

      // Logging: only safe preview in production; debug preview only when not production
      try {
        const safePreview = redactForLogs(compiled.safeLog).slice(0, 1600);
        this._log('ai_request_preview', { preview: safePreview }, { sender_number: senderNumber });
        if (process.env.NODE_ENV !== 'production') {
          this._log('ai_request_debug_preview', { debug: compiled.debugLog }, { sender_number: senderNumber });
        }
      } catch (err) {
        // non-fatal
      }
      const wantsImageResponse = ai.provider === "gemini" && looksLikeImageGenerationPrompt(body);

      typingSession = await this._startTypingPresence(normalizedJid);
      const initialDelayMs = this._sampleDelay(300, 1_200);
      await this._sleep(initialDelayMs);

      const jobId = `${this.botId}:${messageId ?? normalizedJid}:${ai.provider}:${body.trim().slice(0, 120)}`;
      logger.info({
        botId: this.botId,
        jid: normalizedJid,
        messageId,
        jobId,
        provider: ai.provider,
        queueDepth: this._aiJobs.length,
      }, "Queueing AI job");

      const generationStartedAt = Date.now();
  const aiReply = await this._enqueueAiTask(jobId, async () => {
        logger.info({
          botId: this.botId,
          provider: ai.provider,
          model: ai.model,
          jid: normalizedJid,
          isGroup,
          messageId,
          jobId,
          wantsImageResponse,
        }, "AI provider initialized");
        return getAiCompletion({
          provider: ai.provider,
          apiKey,
          model: ai.model,
          // backward-compatible: keep systemPrompt/userMessage empty when passing messages
          systemPrompt: undefined,
          userMessage: undefined,
          messages,
          metadata: {
            botId: this.botId,
            jid: normalizedJid,
            messageId,
            jobId,
            isAdmin,
            assistant_admin_numbers: assistantAdminNumbers,
            sender_number: senderNumber,
            sender_jid: senderJid,
          },
          responseModalities: wantsImageResponse ? ["TEXT", "IMAGE"] : undefined,
        });
      });

      // Parse structured contract output — only structured contracts can request actions.
      let finalReply = aiReply;
      try {
        const { parse } = await import('../ai/OutputParser.js');
        const { executeAction } = await import('../ai/ExecutionEngine.js');
        const { validateContract } = await import('../ai/ContractValidator.js');
        const parsed = parse(aiReply?.text ?? '');
        if (parsed.ok) {
          const contract = parsed.parsed;
          // Strict schema validation: only execute when contract strictly matches schema.
          const { valid } = validateContract(contract);
          if (!valid) {
            logger.warn({ botId: this.botId, jobId, errors: validateContract(contract).errors }, 'AI contract failed schema validation — falling back to plain text');
          } else {
            if (contract.type === 'action_request') {
              // Execute action via ExecutionEngine (ExecutionEngine MUST NOT parse or validate)
              const execResult = await executeAction(contract, { botInstance: this, senderJid, senderNumber, isAdmin });
              if (!execResult.ok) {
                // Execution denied/failed: send a refusal message to user
                await this.sendMessage(normalizedJid, { text: `I couldn't perform the requested action: ${execResult.error}` }, { persist: true });
              } else {
                // On success, optionally notify the user
                await this.sendMessage(normalizedJid, { text: `Action ${contract.action} executed successfully.` }, { persist: true });
              }
              await this._markConversationAiResponse(context.conversationId ?? null);
              return true;
            }

            if (contract.type === 'message') {
              const textOut = String(contract.text ?? '').trim();
              if (textOut) {
                await this.sendMessage(normalizedJid, { text: textOut }, { persist: true, countOnly: false });
                await this._markConversationAiResponse(context.conversationId ?? null);
                await this._log("ai_reply_sent", `AI (${ai.provider}) replied to ${normalizedJid.replace("@s.whatsapp.net", "")}`, {
                  provider: ai.provider,
                  model: ai.model,
                  message_id: messageId,
                  conversation_id: context.conversationId ?? null,
                });
                return true;
              }
            }

            if (contract.type === 'refusal') {
              const reason = String(contract.reason ?? 'Refused to comply');
              await this.sendMessage(normalizedJid, { text: reason }, { persist: true });
              await this._markConversationAiResponse(context.conversationId ?? null);
              return true;
            }
          }
        }
        // If not structured, parsing failed, or schema invalid, fall back to sending plain text only (no actions).
      } catch (err) {
        logger.warn({ err, botId: this.botId, jobId }, "Structured output handling failed — falling back to plain text send");
      }

      if (finalReply?.text || finalReply?.media) {
        const generationMs = Date.now() - generationStartedAt;
        await this._waitForReplyWindow("ai_reply", {
          text: aiReply?.text || aiReply?.media?.caption || "",
          generationMs,
          queueDepth: this._aiJobs.length + this._activeAiJobs,
          jid: normalizedJid,
        });
        try {
          logger.info({
            botId: this.botId,
            jid: normalizedJid,
            messageId,
            jobId,
            replyLength: aiReply?.text?.length ?? 0,
            hasMedia: Boolean(aiReply?.media),
          }, "Sending AI response to WhatsApp");
          const aiPayload = finalReply?.media?.type === "image"
            ? {
                media: {
                  type: "image",
                  url: `data:${finalReply.media.mimetype};base64,${finalReply.media.data}`,
                  caption: finalReply.text || "Generated with Gemini.",
                  mimetype: finalReply.media.mimetype,
                },
              }
            : { text: finalReply.text };
          await this.sendMessage(normalizedJid, aiPayload, { persist: true, countOnly: false });
          await this._markConversationAiResponse(context.conversationId ?? null);
          await this._log("ai_reply_sent", `AI (${ai.provider}) replied to ${normalizedJid.replace("@s.whatsapp.net", "")}`, {
            provider: ai.provider,
            model: ai.model,
            message_id: messageId,
            conversation_id: context.conversationId ?? null,
            ai_generated_media: aiReply?.media?.type ?? null,
          });
          logger.info({ botId: this.botId, jid: normalizedJid, messageId, jobId }, "AI response sent");
          return true;
        } finally {
          await this._stopTypingPresence(typingSession);
        }
      }
      logger.warn({ botId: this.botId, jid: normalizedJid, messageId, jobId }, "AI task completed without a reply payload");
      await this._stopTypingPresence(typingSession);
    } catch (err) {
      logger.error({
        err,
        botId: this.botId,
        jid: normalizedJid,
        messageId,
        provider: ai.provider,
        model: ai.model,
      }, "AI response failed — falling through");
      await this._stopTypingPresence(typingSession ?? normalizedJid);
    }
    return false;
  }

  _enqueueAiTask(jobId, task) {
    this._pruneTransientState();

    const existing = this._recentAiJobs.get(jobId);
    if (existing && (existing.state === "queued" || existing.state === "running" || existing.state === "done")) {
      logger.warn({ botId: this.botId, jobId, state: existing.state }, "Skipping duplicate AI job");
      return Promise.resolve("");
    }

    if (this._aiJobs.length >= AI_JOB_MAX_QUEUE_SIZE) {
      logger.warn({ botId: this.botId, jobId, queueDepth: this._aiJobs.length }, "AI queue is full");
      return Promise.reject(new Error("AI queue is full. Backpressure applied."));
    }

    this._recentAiJobs.set(jobId, { state: "queued", updatedAt: Date.now() });

    return new Promise((resolve, reject) => {
      this._aiJobs.push({
        id: jobId,
        task,
        resolve,
        reject,
        createdAt: Date.now(),
      });
      this._pumpAiQueue().catch((err) => {
        logger.error({ err, botId: this.botId, jobId }, "AI queue pump failed");
      });
    });
  }

  async _pumpAiQueue() {
    if (this._activeAiJobs >= AI_MAX_CONCURRENCY || this._destroyed) return;
    this._pruneTransientState();

    while (this._activeAiJobs < AI_MAX_CONCURRENCY && this._aiJobs.length > 0 && !this._destroyed) {
      const job = this._aiJobs.shift();
      if (!job) return;

      this._activeAiJobs += 1;
      this._recentAiJobs.set(job.id, { state: "running", updatedAt: Date.now() });

      try {
        const value = await job.task();
        this._recentAiJobs.set(job.id, { state: "done", updatedAt: Date.now() });
        job.resolve(value);
      } catch (err) {
        this._recentAiJobs.set(job.id, { state: "failed", updatedAt: Date.now() });
        job.reject(err);
      } finally {
        this._activeAiJobs = Math.max(0, this._activeAiJobs - 1);
      }
    }
  }

  /* ── Webhook ──────────────────────────────────────────────── */

  async _dispatchWebhook(payload) {
    logger.info({ botId: this.botId, event: payload.event, messageId: payload.messageId ?? null }, "Webhook received for dispatch");
    await this._log("webhook_received", `Webhook event queued: ${payload.event}`, {
      event: payload.event,
      message_id: payload.messageId ?? null,
      conversation_id: payload.conversationId ?? null,
    });

    try {
      await this._sendWebhook(payload);
      logger.info({ botId: this.botId, event: payload.event, messageId: payload.messageId ?? null }, "Webhook processed");
    } catch (err) {
      logger.warn({ botId: this.botId, event: payload.event, messageId: payload.messageId ?? null, err: err.message }, "Webhook delivery failed after retries");
    }
  }

  async _sendWebhook(payload, attempt = 1) {
    const body    = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "User-Agent": "WaBot-Webhook/2.0" };
    if (this.config.webhook_secret) {
      headers["X-WaBot-Signature"] = "sha256=" + createHmac("sha256", this.config.webhook_secret).update(body).digest("hex");
    }

    logger.info({ botId: this.botId, url: this.config.webhook_url, attempt, event: payload.event }, "Webhook request sent");
    try {
      const res = await fetch(this.config.webhook_url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      await this._log("webhook_sent", `Webhook → HTTP ${res.status}`, {
        event: payload.event,
        attempt,
        status: res.status,
        message_id: payload.messageId ?? null,
      });

      if (!res.ok) {
        if (attempt < 3 && res.status >= 500) {
          const retryInMs = attempt * 1_000 + this._sampleDelay(150, 700);
          logger.warn({ botId: this.botId, attempt, retryInMs, status: res.status }, "Webhook retry triggered");
          await this._log("webhook_retry", `Webhook retry scheduled after HTTP ${res.status}`, { attempt, status: res.status });
          await this._sleep(retryInMs);
          return this._sendWebhook(payload, attempt + 1);
        }
        throw new Error(`Webhook responded with HTTP ${res.status}`);
      }
    } catch (err) {
      if (attempt < 3) {
        const retryInMs = attempt * 1_000 + this._sampleDelay(150, 700);
        logger.warn({ botId: this.botId, attempt, retryInMs, err: err.message }, "Webhook retry triggered");
        await this._log("webhook_retry", "Webhook retry scheduled after delivery failure", { attempt, error: err.message });
        await this._sleep(retryInMs);
        return this._sendWebhook(payload, attempt + 1);
      }

      await this._log("webhook_failed", `Webhook failed: ${err.message}`, {
        event: payload.event,
        attempt,
        error: err.message,
        message_id: payload.messageId ?? null,
      });
      throw err;
    }
  }

  /* ── Usage / log helpers ──────────────────────────────────── */

  _queueUsage(delta = {}) {
    this._pendingUsage.messagesThisMonth += Number(delta.messagesThisMonth ?? 0);
    this._pendingUsage.totalMessages     += Number(delta.totalMessages     ?? 0);
    this._pendingUsage.lastActivity       = delta.lastActivity ?? this._pendingUsage.lastActivity;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushPendingUsage();
    }, 5000);
  }

  async _flushPendingUsage() {
    if (this._usageFlushInFlight) return;
    const pending = this._pendingUsage;
    if (!pending.messagesThisMonth && !pending.totalMessages && !pending.lastActivity) return;

    this._usageFlushInFlight = true;
    this._pendingUsage = { messagesThisMonth: 0, totalMessages: 0, lastActivity: null };

    const patch = {};
    if (pending.messagesThisMonth) {
      patch.messages_this_month = Math.max(0, this.config.messages_this_month ?? 0);
    }
    if (pending.lastActivity) patch.last_activity = pending.lastActivity;

    try {
      if (Object.keys(patch).length > 0) {
        await supabase.from("bots").update(patch).eq("id", this.botId);
      }
      if (pending.totalMessages > 0) {
        try {
          await supabase.rpc("increment_bot_messages_by", { bid: this.botId, amount: pending.totalMessages });
        } catch {
          for (let i = 0; i < pending.totalMessages; i++) {
            try { await supabase.rpc("increment_bot_messages", { bid: this.botId }); } catch {}
          }
        }
      }
    } catch (err) {
      logger.warn({ botId: this.botId, error: err.message }, "Failed to flush pending usage");
    } finally {
      this._usageFlushInFlight = false;
    }
  }

  _scheduleLogFlush() {
    if (this._pendingLogs.length >= 20) { this._flushLogs(); return; }
    if (this._logFlushTimer) return;
    this._logFlushTimer = setTimeout(() => {
      this._logFlushTimer = null;
      this._flushLogs();
    }, 2000);
  }

  async _flushLogs() {
    if (this._logFlushInFlight || this._pendingLogs.length === 0) return;
    this._logFlushInFlight = true;
    const batch = this._pendingLogs.splice(0, this._pendingLogs.length);
    try {
      await supabase.from("bot_activity").insert(batch);
    } catch (err) {
      logger.warn({ botId: this.botId, error: err.message }, "Failed to insert activity logs");
    }
    this._logFlushInFlight = false;
  }

  async _teardownSocket() {
    if (!this.socket) return;
    const socket = this.socket;
    const listeners = this._socketListeners;

    if (listeners && socket?.ev) {
      try { socket.ev.off?.("creds.update", listeners.saveCreds); } catch {}
      try { socket.ev.off?.("connection.update", listeners.onConnectionUpdate); } catch {}
      try { socket.ev.off?.("messages.upsert", listeners.onMessages); } catch {}
      try { socket.ev.off?.("group-participants.update", listeners.onGroupParticipants); } catch {}
    }

    const flushNow = listeners?.flushNow ?? null;
    if (typeof flushNow === "function") {
      try { await flushNow("socket_teardown"); } catch (err) {
        logger.warn({ botId: this.botId, err }, "Final auth flush failed during socket teardown");
      }
    }

    this._socketListeners = null;
    this.socket = null;

    try { socket.end?.(undefined); } catch {}
  }

  async _flushAuthState(reason = "manual_auth_flush") {
    try {
      await flushSupabaseAuthState(this.botId, reason);
    } catch (err) {
      logger.warn({ botId: this.botId, err, reason }, "Auth state flush failed");
    }
  }

  async _setStatus(status) {
    if (this.status === status) return;
    const oldStatus = this.status;
    this.status = status;
    for (const cb of this._onStatus) { try { cb(status); } catch {} }
    try {
      const { error } = await supabase
        .from("bots")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", this.botId);
      if (error) {
        logger.warn({ botId: this.botId, oldStatus, newStatus: status, error: error.message }, "Failed to update bot status in DB");
      }
    } catch (err) {
      logger.warn({ botId: this.botId, err, oldStatus, newStatus: status }, "Failed to update bot status in DB (exception)");
    }

  }
  
  async _log(eventType, details, metadata = {}) {
    // Normalize sender_number when sender_jid is present to ensure DB consistency
    try {
      const meta = Object.assign({}, metadata);
      if (!meta.sender_number && meta.sender_jid) {
        meta.sender_number = extractPhoneFromJid(String(meta.sender_jid));
      }
      this._pendingLogs.push({ user_id: this.userId, bot_id: this.botId, event_type: eventType, details, metadata: meta });
    } catch (err) {
      // Fallback to original metadata on any error
      this._pendingLogs.push({ user_id: this.userId, bot_id: this.botId, event_type: eventType, details, metadata });
    }
    this._scheduleLogFlush();
  }
  }
