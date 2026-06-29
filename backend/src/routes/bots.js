/**
 * /api/bots — Bot management routes
 * All routes require authentication via JWT or API key.
 */

import { Router }        from "express";
import { supabase }      from "../lib/supabase.js";
import { requireAuth }   from "../middleware/auth.js";
import { deployLimiter } from "../middleware/rateLimiter.js";
import { botManager }    from "../services/whatsapp/BotManager.js";
import { logger }        from "../utils/logger.js";
import { dashboardRealtime } from "../services/realtime/DashboardRealtime.js";
import { AI_PROVIDERS, encryptApiKey, testAiKey } from "../services/ai/AiService.js";
import {
  normalizeAiConfig,
  normalizeCommandsConfig,
  normalizeGroupManagementConfig,
  normalizeKeywordTriggers,
  normalizeRuntimeBotConfig,
  normalizeSalesAgentConfig,
} from "../services/whatsapp/configNormalization.js";
import { env }           from "../config/env.js";

const router = Router();
router.use(requireAuth);

/* Free plan updated to 1 000 messages/month */
const PLAN_LIMITS = {
  free: { maxBots: 1,  maxMsgMonth: 1_000    },
  paid: { maxBots: 50, maxMsgMonth: 100_000  }
};

/* Allowed PATCH fields (strict whitelist) */
const TEXT_FIELDS = [
  "bot_name", "description",
  "webhook_url", "webhook_secret",
  "auto_reply_message",
  "website_url", "catalog_unavail_msg"
];
const BOOL_FIELDS = ["auto_reply_enabled"];
const JSON_FIELDS = ["keyword_triggers", "sales_agent_config", "commands_config", "group_management_config"];
const ALLOWED_AI_PROVIDERS = new Set(AI_PROVIDERS.map((provider) => provider.id));
const PAIRING_STATUSES = new Set(["awaiting_code", "code_generated", "awaiting_link", "awaiting_pairing"]);
const STATUS_POST_TYPES = new Set(["scheduled", "processing", "posted", "failed", "cancelled"]);

function normalizeOptionalUrl(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${label} must use http:// or https://`);
    }
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be a valid http(s) URL.`);
  }
}

/* ── Sanitise a bot name ─────────────────────────────────────── */
function validateBotName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 64)
    return { error: "Bot name must be 2–64 characters." };
  if (!/^[\w\s\-]+$/.test(name))
    return { error: "Bot name may only contain letters, numbers, spaces, hyphens, and underscores." };
  return { name };
}

function buildDirectMessagePayload(body = {}) {
  const preset = String(body.preset ?? "custom").trim().toLowerCase();
  if (preset === "otp") {
    const code = String(body.code ?? "").trim();
    if (!/^\d{4,10}$/.test(code)) {
      throw new Error("OTP code must be 4-10 digits.");
    }

    const appName = String(body.app_name ?? "verification").trim();
    const intro = String(body.intro ?? `Your ${appName} code is ready.`).trim();
    const expires = body.expires_in_minutes ? `\nExpires in ${Number(body.expires_in_minutes)} minute(s).` : "";
    const outro = String(body.outro ?? "").trim();
    return [intro, `OTP: ${code}${expires}`, outro].filter(Boolean).join("\n");
  }

  if (preset === "form") {
    const fields = body.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error("Form fields must be an object.");
    }

    const heading = String(body.heading ?? `New submission: ${String(body.form_name ?? "Form").trim() || "Form"}`).trim();
    const entries = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      .map(([key, value]) => `- ${key}: ${String(value).trim()}`);

    if (entries.length === 0) throw new Error("Form preset requires at least one non-empty field.");
    const footer = String(body.footer ?? "").trim();
    return [heading, ...entries, footer].filter(Boolean).join("\n");
  }

  if (preset === "welcome") {
    const name = String(body.name ?? "").trim();
    return String(body.message ?? "").trim() || (name
      ? `Welcome ${name}! We received your message and will reply shortly.`
      : "Welcome! We received your message and will reply shortly.");
  }

  return String(body.message ?? "").trim();
}

function extractSendPayload(body = {}) {
  if (body?.media && typeof body.media === "object") {
    return { media: body.media };
  }

  if (body?.message && typeof body.message === "object" && !Array.isArray(body.message)) {
    if (body.message.media || body.message.location || body.message.contact || body.message.contacts || typeof body.message.text === "string") {
      return body.message;
    }
  }

  return buildDirectMessagePayload(body);
}

function hasSendPayloadContent(payload) {
  if (typeof payload === "string") return payload.trim().length > 0;
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.text === "string") return payload.text.trim().length > 0;
  if (payload.media?.type && payload.media?.url) return true;
  if (payload.location) return true;
  if (payload.contact) return true;
  if (Array.isArray(payload.contacts) && payload.contacts.length > 0) return true;
  return false;
}

function sanitizeBotForClient(bot) {
  const ai = normalizeAiConfig(bot.ai_config ?? {});
  const safeAi = ai.encrypted_key
    ? { ...ai, encrypted_key: undefined, has_key: true }
    : ai;

  return {
    ...bot,
    status: botManager.getStatus(bot.id) || bot.status,
    ai_config: safeAi,
  };
}

function normalizeScheduleTime(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("publish_at must be a valid ISO date/time.");
  return date.toISOString();
}

function normalizeStatusPostOptions(body = {}) {
  const options = {};
  if (body.backgroundColor) options.backgroundColor = String(body.backgroundColor).trim().slice(0, 32);
  if (body.background_color) options.backgroundColor = String(body.background_color).trim().slice(0, 32);
  if (body.font !== undefined && body.font !== null && body.font !== "") {
    const parsed = Number(body.font);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
      throw new Error("font must be an integer between 0 and 10.");
    }
    options.font = parsed;
  }
  return options;
}

function mapStatusPostRow(row) {
  return {
    id: row.id,
    bot_id: row.bot_id,
    status: STATUS_POST_TYPES.has(row.status) ? row.status : "scheduled",
    caption: row.caption ?? "",
    payload: row.payload ?? {},
    media_type: row.media_type ?? row.payload?.media?.type ?? null,
    publish_at: row.publish_at,
    posted_at: row.posted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    error_message: row.error_message ?? null,
  };
}

/* ── GET /api/bots/ai-providers (must be before /:id routes) ─── */
router.get("/ai-providers", (_req, res) => {
  return res.json({
    providers: AI_PROVIDERS.map(({ id, name, logo, models, applyUrl }) => ({ id, name, logo, models, applyUrl }))
  });
});

/* ── GET /api/bots/dashboard ─────────────────────────────────── */
router.get("/dashboard", async (req, res) => {
  const userId = req.user.sub;

  const [
    { data: user, error: uErr },
    { data: bots              },
    { data: activity          }
  ] = await Promise.all([
    supabase.from("users")
      .select("id, email, full_name, email_verified, plan_tier, created_at, messages_this_month, billing_period_start")
      .eq("id", userId).single(),
    supabase.from("bots")
      .select("id, bot_name, description, status, bot_type, messages_count, messages_this_month, auto_reply_enabled, webhook_url, keyword_triggers, sales_agent_config, commands_config, ai_config, group_management_config, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabase.from("bot_activity")
      .select("id, bot_id, event_type, details, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  if (uErr) return res.status(500).json({ error: "Could not load dashboard." });

  const plan    = user.plan_tier ?? "free";
  const limits  = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const botList = bots ?? [];

  /* Overlay live status + sanitise sensitive AI key from response */
  const botsWithLiveStatus = botList.map((b) => {
    const liveStatus = botManager.getStatus(b.id);
    const ai = normalizeAiConfig(b.ai_config ?? {});
    /* Never return encrypted key to frontend — replace with masked indicator */
    const safeAi = ai.encrypted_key
      ? { ...ai, encrypted_key: undefined, has_key: true }
      : ai;
    return {
      ...b,
      status:    liveStatus && liveStatus !== "unknown" ? liveStatus : b.status,
      ai_config: safeAi
    };
  });

  return res.json({
    user: {
      ...user,
      isSuperAdmin: user.email?.toLowerCase() === env.superadminEmail?.toLowerCase() && Boolean(env.superadminEmail),
    },
    bots:     botsWithLiveStatus,
    activity: activity ?? [],
    stats: {
      totalBots:     botList.length,
      activeBots:    botList.filter((b) => b.status === "connected").length,
      totalMessages: botList.reduce((s, b) => s + (b.messages_count || 0), 0),
      messagesMonth: user.messages_this_month ?? 0,
      planLimit:     limits.maxBots,
      msgLimit:      limits.maxMsgMonth
    }
  });
});

/* ── GET /api/bots/:id ──────────────────────────────────────── */
router.get("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot, error } = await supabase
    .from("bots")
    .select("id, user_id, bot_name, description, status, bot_type, messages_count, messages_this_month, auto_reply_enabled, auto_reply_message, webhook_url, webhook_secret, keyword_triggers, sales_agent_config, commands_config, ai_config, group_management_config, website_url, catalog_unavail_msg, created_at, last_activity")
    .eq("id", id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Could not load bot." });
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  return res.json({ bot: sanitizeBotForClient(bot) });
});

/* ── GET /api/bots/dashboard/events (SSE) ───────────────────── */
router.get("/dashboard/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);

  const pingInterval = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(pingInterval);
    }
  }, 20_000);

  dashboardRealtime.addClient(req.user.sub, res);

  req.on("close", () => {
    clearInterval(pingInterval);
    dashboardRealtime.removeClient(req.user.sub, res);
  });
});

/* ── POST /api/bots/deploy ───────────────────────────────────── */
router.post("/deploy", deployLimiter, async (req, res) => {
  const userId  = req.user.sub;
  const { error: nameErr, name: botName } = validateBotName(req.body?.botName);
  if (nameErr) return res.status(400).json({ error: nameErr });

  const desc    = String(req.body?.description ?? "").trim().slice(0, 200);
  const botType = ["dm", "group", "all"].includes(req.body?.botType) ? req.body.botType : "dm";

  const { data: user } = await supabase
    .from("users").select("email_verified, plan_tier").eq("id", userId).single();

  if (!user) return res.status(500).json({ error: "Could not fetch user." });
  if (!user.email_verified)
    return res.status(403).json({ error: "Please verify your email before deploying bots." });

  const plan   = user.plan_tier ?? "free";
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  const { count } = await supabase
    .from("bots").select("*", { count: "exact", head: true }).eq("user_id", userId);

  if ((count ?? 0) >= limits.maxBots) {
    return res.status(403).json({
      error: `You've reached the ${plan === "paid" ? "Pro" : "Free"} plan limit of ${limits.maxBots} bot${limits.maxBots === 1 ? "" : "s"}.${plan !== "paid" ? " Upgrade to Pro to deploy up to 50 bots." : ""}`
    });
  }

  const { data: bot, error: botErr } = await supabase
    .from("bots")
    .insert({ user_id: userId, bot_name: botName, description: desc || null, status: "connecting", bot_type: botType })
    .select("id, bot_name, description, status, bot_type, created_at")
    .single();

  if (botErr) {
    if (botErr.message?.includes("Bot limit reached"))
      return res.status(403).json({ error: botErr.message });
    return res.status(500).json({ error: "Could not create bot. Please try again." });
  }

  try {
    // Start the WhatsApp instance asynchronously — pairing/QR will be handled
    // by the frontend via SSE and the dedicated /request-pairing endpoint.
    await botManager.deploy(bot.id, userId, { plan_tier: plan, bot_type: botType });
  } catch (err) {
    // Deploy/start failed — log and continue. Bot row was created so frontend can show the record.
    logger.error({ err, botId: bot.id }, "botManager.deploy failed during deploy route");
  }

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: bot.id, event_type: "deploy_started",
    details: `Bot "${botName}" (${botType}) deployed — waiting for QR scan`
  }).catch(() => {});

  return res.status(201).json({ bot });
});

/* ── GET /api/bots/:id/events (SSE) ─────────────────────────── */
router.get("/:id/events", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId)
    return res.status(404).json({ error: "Bot not found." });

  res.set({
    "Content-Type":      "text/event-stream; charset=utf-8",
    "Cache-Control":     "no-cache, no-store, no-transform",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.flushHeaders();
  /* Send an initial comment so the browser confirms the stream opened */
  res.write(": stream-open\n\n");
  if (typeof res.flush === "function") res.flush();

  const pingInterval = setInterval(() => {
    try {
      res.write(": ping\n\n");
      if (typeof res.flush === "function") res.flush();
    } catch { clearInterval(pingInterval); }
  }, 15_000);

  botManager.addSseClient(id, res);

  req.on("close", () => {
    clearInterval(pingInterval);
    botManager.removeSseClient(id, res);
  });
});

/* ── GET /api/bots/:id/qr ────────────────────────────────────── */
router.get("/:id/qr", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });
  const liveStatus = botManager.getStatus(id);
  if (PAIRING_STATUSES.has(liveStatus) || PAIRING_STATUSES.has(bot.status)) {
    return res.status(409).json({ error: "This bot is using pairing-code mode, so no QR code is available." });
  }
  const qrCode = botManager.getQR(id);
  if (!qrCode) return res.status(404).json({ error: "No QR code available yet. Wait a moment and try again." });
  return res.json({ qrCodeDataUrl: qrCode });
});

/* ── POST /api/bots/:id/reconnect ───────────────────────────── */
router.post("/:id/reconnect", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const RECONNECTABLE = ["disconnected", "failed", "error", "qr_timeout"];
  if (!RECONNECTABLE.includes(bot.status)) {
    return res.status(409).json({ error: `Bot cannot be reconnected from status "${bot.status}". It is already ${bot.status}.` });
  }

  try {
    await botManager.reconnect(id, userId);
    return res.json({ ok: true, message: "Reconnect initiated. Open QR or pairing mode and wait for the new auth payload." });
  } catch (err) {
    logger.error({ err, botId: id }, "Reconnect route failed");
    return res.status(500).json({ error: "Could not reconnect this bot right now. Please try again." });
  }
});

/* ── POST /api/bots/:id/request-pairing ───────────────────── */
router.post("/:id/request-pairing", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const phone = String(req.body?.phone ?? "").trim();

  const { data: bot } = await supabase.from("bots").select("id, user_id").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  try {
    const result = await botManager.requestPairingCode(id, phone);
    const code = typeof result === "string" ? result : result?.code ?? null;
    const expiresAt = typeof result === "string"
      ? new Date(Date.now() + 2 * 60 * 1000).toISOString()
      : result?.expiresAt ?? null;
    return res.json({ ok: true, code, expiresAt });
  } catch (err) {
    logger.warn({ err, botId: id }, "Pairing code request route failed");
    const message = String(err?.message ?? "").trim();
    if (/invalid phone number/i.test(message)) {
      return res.status(400).json({ error: "Enter a valid WhatsApp phone number with country code." });
    }
    if (/already connected/i.test(message)) {
      return res.status(409).json({ error: "This bot is already connected, so a pairing code is not needed." });
    }
    if (/does not support pairing codes/i.test(message)) {
      return res.status(409).json({ error: "Pairing code is not available for this connection. Use QR mode instead." });
    }
    return res.status(500).json({ error: "Could not request a pairing code right now. Please try again." });
  }
});

/* ── GET /api/bots/:id/status-posts ─────────────────────────── */
router.get("/:id/status-posts", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  const { data: bot } = await supabase
    .from("bots")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const { data, error } = await supabase
    .from("bot_status_posts")
    .select("id, bot_id, status, caption, payload, media_type, publish_at, posted_at, created_at, updated_at, error_message")
    .eq("user_id", userId)
    .eq("bot_id", id)
    .order("publish_at", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: "Could not load status posts." });
  return res.json({ posts: (data ?? []).map(mapStatusPostRow) });
});

/* ── POST /api/bots/:id/status-posts ────────────────────────── */
router.post("/:id/status-posts", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots")
    .select("id, user_id, bot_name, status")
    .eq("id", id)
    .maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  let payload;
  let statusOptions;
  let publishAt;
  try {
    payload = extractSendPayload(req.body ?? {});
    statusOptions = normalizeStatusPostOptions(req.body ?? {});
    publishAt = normalizeScheduleTime(req.body?.publish_at);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!hasSendPayloadContent(payload)) {
    return res.status(400).json({ error: "A text or media payload is required." });
  }

  const caption = typeof payload === "string"
    ? payload.slice(0, 4096)
    : String(payload?.text ?? payload?.media?.caption ?? "").slice(0, 4096);
  const mediaType = typeof payload === "string" ? "text" : (payload.media?.type ?? (payload.text ? "text" : null));

  if (publishAt && new Date(publishAt).getTime() <= Date.now() + 10_000) {
    return res.status(400).json({ error: "Scheduled posts must be at least 10 seconds in the future." });
  }

  const baseInsert = {
    user_id: userId,
    bot_id: id,
    caption: caption || null,
    payload: typeof payload === "string" ? { text: payload } : payload,
    media_type: mediaType,
    publish_at: publishAt ?? new Date().toISOString(),
    status_options: statusOptions,
  };

  if (publishAt) {
    const { data: scheduled, error } = await supabase
      .from("bot_status_posts")
      .insert({
        ...baseInsert,
        status: "scheduled",
      })
      .select("id, bot_id, status, caption, payload, media_type, publish_at, posted_at, created_at, updated_at, error_message")
      .single();

    if (error) return res.status(500).json({ error: "Could not schedule status post." });

    await supabase.from("bot_activity").insert({
      user_id: userId,
      bot_id: id,
      event_type: "status_post_scheduled",
      details: `Scheduled a status post for "${bot.bot_name}"`,
      metadata: { publish_at: publishAt, media_type: mediaType },
    }).catch(() => {});

    return res.status(201).json({ post: mapStatusPostRow(scheduled), message: "Status post scheduled." });
  }

  const { data: created, error: createError } = await supabase
    .from("bot_status_posts")
    .insert({
      ...baseInsert,
      status: "processing",
      processing_started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (createError || !created) {
    return res.status(500).json({ error: "Could not create status post." });
  }

  try {
    const result = await botManager.postStatus(id, payload, statusOptions);
    const postedAt = new Date().toISOString();
    const { data: posted } = await supabase
      .from("bot_status_posts")
      .update({
        status: "posted",
        posted_at: postedAt,
        processing_started_at: null,
        audience_count: result.audienceCount,
        error_message: null,
      })
      .eq("id", created.id)
      .select("id, bot_id, status, caption, payload, media_type, publish_at, posted_at, created_at, updated_at, error_message")
      .single();

    await supabase.from("bot_activity").insert({
      user_id: userId,
      bot_id: id,
      event_type: "status_posted",
      details: `Posted a WhatsApp status for "${bot.bot_name}"`,
      metadata: { media_type: mediaType, audience_count: result.audienceCount },
    }).catch(() => {});

    return res.status(201).json({
      post: posted ? mapStatusPostRow(posted) : null,
      message: "Status posted successfully.",
    });
  } catch (err) {
    await supabase
      .from("bot_status_posts")
      .update({
        status: "failed",
        processing_started_at: null,
        error_message: err.message ?? "Status post failed.",
      })
      .eq("id", created.id);

    return res.status(409).json({ error: err.message ?? "Status post failed." });
  }
});

/* ── DELETE /api/bots/:id/status-posts/:postId ──────────────── */
router.delete("/:id/status-posts/:postId", async (req, res) => {
  const userId = req.user.sub;
  const { id, postId } = req.params;

  const { data: post, error } = await supabase
    .from("bot_status_posts")
    .select("id, user_id, bot_id, status")
    .eq("id", postId)
    .eq("bot_id", id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Could not load scheduled post." });
  if (!post || post.user_id !== userId) return res.status(404).json({ error: "Scheduled post not found." });
  if (post.status !== "scheduled") {
    return res.status(409).json({ error: "Only scheduled posts can be deleted before publishing." });
  }

  const { error: deleteError } = await supabase
    .from("bot_status_posts")
    .delete()
    .eq("id", postId)
    .eq("status", "scheduled");

  if (deleteError) return res.status(500).json({ error: "Could not delete scheduled post." });

  await supabase.from("bot_activity").insert({
    user_id: userId,
    bot_id: id,
    event_type: "status_post_deleted",
    details: "Deleted a scheduled status post before publication",
    metadata: { post_id: postId },
  }).catch(() => {});

  return res.status(204).send();
});

/* ── POST /api/bots/:id/send ─────────────────────────────────── */
/* 
 * Dashboard manual message send.
 * - Updates monthly counter (counts toward user's plan limit)
 * - Saves message content so dashboard conversations stay in sync
 * - Returns 429 if monthly limit reached
 */
router.post("/:id/send", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const to      = String(req.body?.to ?? "").trim();
  let message;

  try {
    message = extractSendPayload(req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!to)                         return res.status(400).json({ error: "`to` (phone number) is required." });
  if (!hasSendPayloadContent(message)) return res.status(400).json({ error: "`message` is required." });
  const isRawJid = /@(g\.us|s\.whatsapp\.net|lid)$/i.test(to.trim());
  if (!isRawJid && !/^\+?\d{7,15}$/.test(to.replace(/[\s\-()]/g, "")))
    return res.status(400).json({ error: "Invalid phone number format." });

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, status").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  // Check monthly limit before sending
  const { data: user } = await supabase
    .from("users")
    .select("messages_this_month, plan_tier")
    .eq("id", userId)
    .single();

  const limit = user?.plan_tier === "paid" ? 100_000 : 1_000;
  const currentUsage = user?.messages_this_month ?? 0;

  if (currentUsage >= limit) {
    return res.status(429).json({ 
      error: `Monthly message limit reached (${limit.toLocaleString()} messages). Upgrade to Pro for 100,000 messages/month.`,
      code: "MONTHLY_LIMIT_REACHED",
      used: currentUsage,
      limit: limit
    });
  }

  try {
    await botManager.sendMessage(id, to, message, { persist: true, countOnly: false });
    
    return res.json({ ok: true, message: "Message sent." });
  } catch (err) {
    // Check if it's a rate limit error from BotManager
    if (err.message?.includes("Monthly message limit reached")) {
      return res.status(429).json({ error: err.message });
    }
    return res.status(409).json({ error: err?.message ?? "Message send failed." });
  }
});

/* ── PATCH /api/bots/:id ─────────────────────────────────────── */
router.patch("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, user_id, ai_config, plan_tier:users!inner(plan_tier)").eq("id", id).maybeSingle();
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  const planTier = bot.plan_tier?.plan_tier ?? "free";
  const updates  = {};

  /* Text fields */
  for (const key of TEXT_FIELDS) {
    if (req.body && key in req.body) {
      try {
        if (key === "webhook_url") {
          updates[key] = normalizeOptionalUrl(req.body[key], "Webhook URL");
          continue;
        }
        if (key === "website_url") {
          updates[key] = normalizeOptionalUrl(req.body[key], "Website URL");
          continue;
        }
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      updates[key] = req.body[key] === "" ? null : String(req.body[key]).slice(0, 2048);
    }
  }

  /* Boolean fields */
  for (const key of BOOL_FIELDS) {
    if (req.body && key in req.body) updates[key] = Boolean(req.body[key]);
  }

  /* JSON fields */
  for (const key of JSON_FIELDS) {
    if (req.body && key in req.body) {
      if (!req.body[key] || typeof req.body[key] !== "object")
        return res.status(400).json({ error: `Field ${key} must be an object or array.` });
      updates[key] = key === "sales_agent_config"
        ? normalizeSalesAgentConfig(req.body[key])
        : key === "commands_config"
          ? normalizeCommandsConfig(req.body[key])
        : key === "keyword_triggers"
          ? normalizeKeywordTriggers(req.body[key])
        : key === "group_management_config"
          ? normalizeGroupManagementConfig(req.body[key])
        : req.body[key];
    }
  }

  /* Bot type */
  if (req.body && "bot_type" in req.body) {
    if (!["dm", "group", "all"].includes(req.body.bot_type))
      return res.status(400).json({ error: "bot_type must be dm, group, or all." });
    updates.bot_type = req.body.bot_type;
  }

  /* AI config — encrypt key, enforce Pro plan */
  if (req.body && "ai_config" in req.body) {
    if (planTier !== "paid")
      return res.status(403).json({ error: "AI integration is a Pro plan feature." });

    const aiRaw = req.body.ai_config ?? {};
    const ai = normalizeAiConfig({ ...(bot.ai_config ?? {}), ...aiRaw });
    const clearKey = aiRaw?.clear_key === true;

    const provider = String(ai.provider ?? "openai").trim().toLowerCase();
    if (!ALLOWED_AI_PROVIDERS.has(provider)) {
      return res.status(400).json({
        error: `Unsupported AI provider "${provider}". Supported: ${[...ALLOWED_AI_PROVIDERS].join(", ")}.`
      });
    }
    ai.provider = provider;
    if (ai.assistant_enabled && !ai.enabled) {
      return res.status(400).json({ error: "Assistant mode requires AI responses to be enabled first." });
    }

    /* If new raw API key provided, encrypt it */
    if (clearKey) {
      ai.encrypted_key = null;
      ai.has_key = false;
      ai.is_sensitive = false;
    } else if (ai.api_key && ai.api_key.trim() && !ai.api_key.startsWith("***")) {
      if (!env.hasJwt)
        return res.status(500).json({ error: "Server not configured for key encryption (JWT_SECRET missing)." });
      ai.encrypted_key = encryptApiKey(String(ai.api_key), env.jwtSecret);
      ai.has_key = true;
    }
    /* Never store raw key */
    delete ai.api_key;
    delete ai.clear_key;

    updates.ai_config = ai;
  }

  /* Bot name validation */
  if (updates.bot_name !== undefined) {
    const { error: nameErr, name } = validateBotName(updates.bot_name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    updates.bot_name = name;
  }

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields provided." });

  const { data: updated, error } = await supabase
    .from("bots").update(updates).eq("id", id)
    .select("id, bot_name, description, status, bot_type, auto_reply_enabled, auto_reply_message, webhook_url, webhook_secret, keyword_triggers, sales_agent_config, commands_config, ai_config, group_management_config, website_url, catalog_unavail_msg, created_at")
    .single();

  if (error) return res.status(500).json({ error: "Could not update bot." });

  /* Push live config updates to running bot instance */
  await botManager.refreshConfig(id, userId).catch((err) => {
    logger.warn({ err, botId: id }, "Falling back to direct runtime config patch after refresh failure");
    botManager.updateConfig(id, normalizeRuntimeBotConfig({
      ...updated,
      plan_tier: planTier,
    }));
  });

  /* Sanitise encrypted key before returning to client */
  const normalizedUpdatedAi = normalizeAiConfig(updated.ai_config ?? {});
  const safeAi = normalizedUpdatedAi.encrypted_key
    ? { ...normalizedUpdatedAi, encrypted_key: undefined, has_key: true }
    : normalizedUpdatedAi;

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: id, event_type: "bot_updated",
    details: "Bot configuration updated"
  }).catch(() => {});

  return res.json({ bot: { ...updated, ai_config: safeAi } });
});

/* ── POST /api/bots/:id/test-ai ─────────────────────────────── */
router.post("/:id/test-ai", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots")
    .select("id, user_id, ai_config, users!inner(plan_tier)")
    .eq("id", id)
    .maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const planTier = bot.users?.plan_tier ?? "free";
  if (planTier !== "paid") return res.status(403).json({ error: "AI features require the Pro plan." });

  const rawKey  = String(req.body?.api_key ?? "").trim();
  const provider = String(req.body?.provider ?? bot.ai_config?.provider ?? "openai").trim().toLowerCase();

  if (!ALLOWED_AI_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }

  let apiKey = rawKey;
  if (!apiKey) {
    const encrypted = bot.ai_config?.encrypted_key;
    if (!encrypted) return res.status(400).json({ error: "No API key to test. Enter a key in the field above first." });
    const { decryptApiKey } = await import("../services/ai/AiService.js");
    apiKey = decryptApiKey(encrypted, env.jwtSecret);
    if (!apiKey) return res.status(500).json({ error: "Could not decrypt the stored API key." });
  }

  const result = await testAiKey({ provider, apiKey });
  return res.json(result);
});

/* ── GET /api/bots/:id/groups ────────────────────────────────── */
router.get("/:id/groups", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;
  const { data: bot } = await supabase
    .from("bots").select("id, user_id, bot_type").eq("id", id).maybeSingle();
  if (!bot || bot.user_id !== userId) return res.status(404).json({ error: "Bot not found." });

  const groups = await botManager.getAdminGroups(id);
  return res.json({
    count:  groups.length,
    groups: groups.map((g) => ({
      id:           g.id,
      subject:      g.subject,
      participants: g.participants?.length ?? 0
    }))
  });
});

/* ── DELETE /api/bots/:id ────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  const userId = req.user.sub;
  const { id } = req.params;

  const { data: bot } = await supabase
    .from("bots").select("id, bot_name, user_id").eq("id", id).maybeSingle();
  if (!bot) return res.status(404).json({ error: "Bot not found." });
  if (bot.user_id !== userId) return res.status(403).json({ error: "Forbidden." });

  await botManager.remove(id);
  const { error } = await supabase.from("bots").delete().eq("id", id);
  if (error) return res.status(500).json({ error: "Could not delete bot." });

  await supabase.from("bot_activity").insert({
    user_id: userId, bot_id: null, event_type: "bot_deleted",
    details: `Bot "${bot.bot_name}" was deleted`
  }).catch(() => {});

  return res.status(204).send();
});

export default router;
