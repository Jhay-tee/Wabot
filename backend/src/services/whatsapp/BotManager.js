/**
 * BotManager — singleton managing all WhatsApp bot instances.
 */

import { BotInstance }  from "./BotInstance.js";
import { supabase }     from "../../lib/supabase.js";
import { logger }       from "../../utils/logger.js";

class BotManager {
  constructor() {
    /** @type {Map<string, BotInstance>} */
    this.instances  = new Map();
    /** @type {Map<string, Set<import("express").Response>>} */
    this.sseClients = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._pairingTimeouts = new Map();
    
    /* ── Per-minute message rate limiting (prevents WhatsApp 429 errors) ── */
    /** @type {Map<string, { timestamps: number[], planTier: string }>} */
    this._messageRateLimiters = new Map(); // userId -> { timestamps, planTier }
  }

  /* ── Boot ─────────────────────────────────────────────────── */

  async initialize() {
    const { data: sessions } = await supabase
      .from("bot_sessions")
      .select("bot_id");

    const botIds = [...new Set((sessions ?? []).map((row) => row.bot_id).filter(Boolean))];
    if (botIds.length === 0) return;

    const { data: bots } = await supabase
      .from("bots")
      .select(`id, user_id, status,
        plan_tier:users!inner(plan_tier),
        auto_reply_enabled, auto_reply_message,
        webhook_url, webhook_secret,
        messages_this_month, bot_type,
        keyword_triggers, sales_agent_config,
        commands_config, ai_config,
        group_management_config,
        website_url, catalog_unavail_msg`)
      .in("id", botIds);

    if (!bots?.length) return;
    logger.info(`BotManager: reconnecting ${bots.length} bot(s)`);

    for (const bot of bots) {
      const planTier = bot.plan_tier?.plan_tier ?? bot.plan_tier ?? "free";
      await this._create(bot.id, bot.user_id, {
        plan_tier:           planTier,
        bot_type:            bot.bot_type ?? "dm",
        auto_reply_enabled:  bot.auto_reply_enabled,
        auto_reply_message:  bot.auto_reply_message,
        webhook_url:         bot.webhook_url,
        webhook_secret:      bot.webhook_secret,
        messages_this_month: bot.messages_this_month ?? 0,
        keyword_triggers:    bot.keyword_triggers   ?? [],
        sales_agent_config:  bot.sales_agent_config ?? {},
        commands_config:         bot.commands_config         ?? {},
        ai_config:               bot.ai_config               ?? {},
        group_management_config: bot.group_management_config ?? {},
        website_url:             bot.website_url,
        catalog_unavail_msg:     bot.catalog_unavail_msg
      });
    }
  }

  /* ── Helper: Check and increment monthly message counter ─── */
  
  /**
   * Check if user has exceeded monthly message limit
   * @param {string} userId - User ID
   * @returns {Promise<{ allowed: boolean, limit: number, used: number, error?: string }>}
   */
  async _checkMonthlyLimit(userId) {
    const { data: user, error } = await supabase
      .from("users")
      .select("messages_this_month, plan_tier")
      .eq("id", userId)
      .single();
    
    if (error) {
      logger.error({ error, userId }, "Failed to fetch user for rate limit check");
      return { allowed: true, limit: 1000, used: 0 }; // Allow on error
    }
    
    const limit = user?.plan_tier === "paid" ? 100_000 : 1_000;
    const used = user?.messages_this_month ?? 0;
    
    if (used >= limit) {
      return {
        allowed: false,
        limit,
        used,
        error: `Monthly message limit reached (${limit.toLocaleString()} messages). Upgrade to Pro for 100,000 messages/month.`
      };
    }
    
    return { allowed: true, limit, used };
  }
  
  /**
   * Increment monthly message counter for a user
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async _incrementMonthlyCounter(userId) {
    try {
      await supabase.rpc("increment_user_messages", { uid: userId });
    } catch (err) {
      // Fallback if RPC doesn't exist
      const { data: user } = await supabase
        .from("users")
        .select("messages_this_month")
        .eq("id", userId)
        .single();
      
      if (user) {
        await supabase
          .from("users")
          .update({ messages_this_month: (user.messages_this_month ?? 0) + 1 })
          .eq("id", userId);
      }
    }
  }

  /* ── Per-minute message rate limiting (prevents WhatsApp 429) ── */
  
  /**
   * Check and enforce per-minute message rate limit
   * Free: 20 messages per minute (1 every 3 seconds)
   * Paid: 60 messages per minute (1 per second)
   * 
   * @param {string} userId - User ID
   * @param {string} planTier - User's plan tier ('free' or 'paid')
   * @returns {Promise<{ allowed: boolean, waitMs?: number, error?: string }>}
   */
  async _checkPerMinuteRateLimit(userId, planTier) {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute window
    const limits = {
      free: 20,   // 20 messages per minute
      paid: 60    // 60 messages per minute
    };
    const maxMessages = limits[planTier] || limits.free;
    
    let rateData = this._messageRateLimiters.get(userId);
    
    if (!rateData || rateData.planTier !== planTier) {
      // Initialize or reset with current plan
      rateData = { timestamps: [], planTier };
      this._messageRateLimiters.set(userId, rateData);
    }
    
    // Clean up timestamps older than the window
    rateData.timestamps = rateData.timestamps.filter(ts => now - ts < windowMs);
    
    if (rateData.timestamps.length >= maxMessages) {
      // Find the oldest timestamp to calculate wait time
      const oldestTs = Math.min(...rateData.timestamps);
      const waitMs = (oldestTs + windowMs) - now;
      return {
        allowed: false,
        waitMs,
        error: `Message rate limit exceeded (${maxMessages} messages per minute). Please wait ${Math.ceil(waitMs / 1000)} seconds.`
      };
    }
    
    // Add current timestamp
    rateData.timestamps.push(now);
    
    return { allowed: true };
  }
  
  /**
   * Clean up old rate limiter data periodically (optional, prevents memory leaks)
   */
  _cleanupOldRateLimiters() {
    const now = Date.now();
    const windowMs = 60_000;
    for (const [userId, data] of this._messageRateLimiters.entries()) {
      data.timestamps = data.timestamps.filter(ts => now - ts < windowMs);
      if (data.timestamps.length === 0) {
        this._messageRateLimiters.delete(userId);
      }
    }
  }

  /* ── Instance lifecycle ───────────────────────────────────── */

  async _create(botId, userId, config) {
    // Clean up existing instance
    if (this.instances.has(botId)) {
      const oldInstance = this.instances.get(botId);
      await oldInstance.stop();
      this.instances.delete(botId);
    }
    
    // Clear any pending pairing timeout
    if (this._pairingTimeouts.has(botId)) {
      clearTimeout(this._pairingTimeouts.get(botId));
      this._pairingTimeouts.delete(botId);
    }

    const instance = new BotInstance(botId, userId, config);

    // QR code handler
    instance.onQR((qrUrl) => {
      this._broadcast(botId, { type: "qr", qrUrl });
    });
    
    // Status handler
    instance.onStatus((status) => {
      this._broadcast(botId, { type: "status", status });
      // When connected, clear any pending pairing timeout
      if (status === "connected" && this._pairingTimeouts.has(botId)) {
        clearTimeout(this._pairingTimeouts.get(botId));
        this._pairingTimeouts.delete(botId);
      }
    });
    
    // Pairing code handler
    if (typeof instance.onPairCode === "function") {
      instance.onPairCode((code) => {
        logger.info({ botId, code }, "Pairing code generated");
        this._broadcast(botId, { type: "pair_code", code });
      });
    } else {
      logger.warn({ botId }, "onPairCode not available on BotInstance");
    }

    this.instances.set(botId, instance);
    await instance.start();
    return instance;
  }

  async deploy(botId, userId, config = {}) { 
    return this._create(botId, userId, config); 
  }

  /**
   * Reconnect a bot that is disconnected / failed / timed-out.
   * Fetches the latest config from DB and starts a fresh instance.
   */
  async reconnect(botId, userId) {
    const { data: bot } = await supabase
      .from("bots")
      .select(`id, user_id,
        plan_tier:users!inner(plan_tier),
        auto_reply_enabled, auto_reply_message,
        webhook_url, webhook_secret,
        messages_this_month, bot_type,
        keyword_triggers, sales_agent_config,
        commands_config, ai_config,
        group_management_config,
        website_url, catalog_unavail_msg`)
      .eq("id", botId)
      .maybeSingle();

    if (!bot || bot.user_id !== userId) throw new Error("Bot not found.");

    const planTier = bot.plan_tier?.plan_tier ?? bot.plan_tier ?? "free";
    await this._create(botId, userId, {
      plan_tier:               planTier,
      bot_type:                bot.bot_type            ?? "dm",
      auto_reply_enabled:      bot.auto_reply_enabled,
      auto_reply_message:      bot.auto_reply_message,
      webhook_url:             bot.webhook_url,
      webhook_secret:          bot.webhook_secret,
      messages_this_month:     bot.messages_this_month ?? 0,
      keyword_triggers:        bot.keyword_triggers    ?? [],
      sales_agent_config:      bot.sales_agent_config  ?? {},
      commands_config:         bot.commands_config     ?? {},
      ai_config:               bot.ai_config           ?? {},
      group_management_config: bot.group_management_config ?? {},
      website_url:             bot.website_url,
      catalog_unavail_msg:     bot.catalog_unavail_msg
    });
  }

  async remove(botId) {
    const inst = this.instances.get(botId);
    if (inst) { 
      await inst.stop(); 
      this.instances.delete(botId); 
    }
    if (this._pairingTimeouts.has(botId)) {
      clearTimeout(this._pairingTimeouts.get(botId));
      this._pairingTimeouts.delete(botId);
    }
    this._closeSseClients(botId);
  }

  updateConfig(botId, patch) { 
    this.instances.get(botId)?.updateConfig(patch); 
  }
  
  getQR(botId) { 
    return this.instances.get(botId)?.qrCode ?? null; 
  }
  
  getStatus(botId) { 
    return this.instances.get(botId)?.status ?? "unknown"; 
  }

  /**
   * Push a plan downgrade to every running bot owned by userId.
   * Called immediately when a subscription expires / is cancelled /
   * payment fails so Pro features stop working without a server restart.
   */
  downgradeUserBots(userId) {
    for (const inst of this.instances.values()) {
      if (inst.userId === userId) {
        inst.updateConfig({ plan_tier: "free" });
      }
    }
    logger.info({ userId }, "[BotManager] downgradeUserBots — plan_tier set to free for all running bots");
  }

  /**
   * Send a message via a bot instance.
   * @param {string} botId - Bot ID
   * @param {string} to - Recipient JID or phone number
   * @param {string|object} text - Message text or media object
   * @param {object} options - { persist: boolean, countOnly: boolean, skipLimitCheck: boolean, skipPerMinuteRateLimit: boolean }
   *   - persist: true = save message content to DB (default: true)
   *   - countOnly: true = only update counter, don't save content (default: false)
   *   - skipLimitCheck: true = bypass monthly limit (for internal use, default: false)
   *   - skipPerMinuteRateLimit: true = bypass per-minute rate limit (default: false)
   */
  async sendMessage(botId, to, text, options = { persist: true, countOnly: false, skipLimitCheck: false, skipPerMinuteRateLimit: false }) {
    const inst = this.instances.get(botId);
    if (!inst) throw new Error("Bot instance not found.");
    if (inst.status !== "connected") {
      throw new Error(`Bot is ${inst.status}. Please wait for connection.`);
    }
    
    // Fetch user's plan tier
    const { data: user } = await supabase
      .from("users")
      .select("plan_tier, messages_this_month")
      .eq("id", inst.userId)
      .single();
    
    const planTier = user?.plan_tier || "free";
    
    // Check PER-MINUTE rate limit (prevents WhatsApp 429 errors)
    if (!options.skipPerMinuteRateLimit) {
      const rateLimitCheck = await this._checkPerMinuteRateLimit(inst.userId, planTier);
      if (!rateLimitCheck.allowed) {
        throw new Error(rateLimitCheck.error);
      }
    }
    
    // Check MONTHLY limit (skip for internal operations if explicitly allowed)
    if (!options.skipLimitCheck) {
      const limitCheck = await this._checkMonthlyLimit(inst.userId);
      if (!limitCheck.allowed) {
        throw new Error(limitCheck.error);
      }
    }
    
    // Send the message
    await inst.sendMessage(to, text, options);
    
    // Update monthly counter regardless of persist flag (as long as not skipping limit check)
    if (!options.skipLimitCheck) {
      await this._incrementMonthlyCounter(inst.userId);
    }
    
    // Only save content to activity log if persist is true AND countOnly is false
    if (options.persist === true && options.countOnly !== true && typeof text === "string") {
      await inst._log("dm_sent", `Message sent to ${to}`, { to, preview: text.slice(0, 100) });
    }
    
    // Clean up old rate limiter entries every 100 messages (optional)
    if (Math.random() < 0.01) { // 1% chance per message
      this._cleanupOldRateLimiters();
    }
  }

  async getAdminGroups(botId) {
    const inst = this.instances.get(botId);
    if (!inst) return [];
    return inst.getAdminGroups();
  }

  /**
   * Get current rate limit status for a user
   * @param {string} userId - User ID
   * @returns {Promise<{ remainingPerMinute: number, messagesUsedThisMonth: number, limitPerMinute: number, monthlyLimit: number, planTier: string }>}
   */
  async getRateLimitStatus(userId) {
    const { data: user } = await supabase
      .from("users")
      .select("plan_tier, messages_this_month")
      .eq("id", userId)
      .single();
    
    const planTier = user?.plan_tier || "free";
    const perMinuteLimits = { free: 20, paid: 60 };
    const monthlyLimits = { free: 1_000, paid: 100_000 };
    
    const rateData = this._messageRateLimiters.get(userId);
    const now = Date.now();
    const windowMs = 60_000;
    const recentMessages = rateData?.timestamps.filter(ts => now - ts < windowMs).length || 0;
    const remainingPerMinute = perMinuteLimits[planTier] - recentMessages;
    
    return {
      remainingPerMinute: Math.max(0, remainingPerMinute),
      messagesUsedThisMonth: user?.messages_this_month || 0,
      limitPerMinute: perMinuteLimits[planTier],
      monthlyLimit: monthlyLimits[planTier],
      planTier
    };
  }

  /**
   * Request an 8-digit pairing code for a bot (WhatsApp Web style).
   * @param {string} botId - Bot ID
   * @param {string} phone - Phone number (e.g., "628123456789" — no +, no spaces)
   * @returns {Promise<string>} - 8-digit pairing code
   */
  async requestPairingCode(botId, phone) {
    const inst = this.instances.get(botId);
    if (!inst) throw new Error("Bot instance not found.");
    if (typeof inst.requestPairingCode !== "function") {
      throw new Error("Pairing not supported by this Baileys version.");
    }
    
    // Clean phone number (remove all non-digits)
    const cleanPhone = phone.replace(/[^\d]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error("Valid phone number required (10+ digits, country code first).");
    }
    
    logger.info({ botId, phone: cleanPhone }, "Requesting pairing code");
    
    // Set a timeout for pairing code generation (30 seconds)
    const timeoutPromise = new Promise((_, reject) => {
      const timeout = setTimeout(() => {
        this._pairingTimeouts.delete(botId);
        reject(new Error("Pairing code request timed out after 30 seconds."));
      }, 30000);
      this._pairingTimeouts.set(botId, timeout);
    });
    
    const codePromise = inst.requestPairingCode(cleanPhone);
    
    try {
      const code = await Promise.race([codePromise, timeoutPromise]);
      if (this._pairingTimeouts.has(botId)) {
        clearTimeout(this._pairingTimeouts.get(botId));
        this._pairingTimeouts.delete(botId);
      }
      return code;
    } catch (error) {
      if (this._pairingTimeouts.has(botId)) {
        clearTimeout(this._pairingTimeouts.get(botId));
        this._pairingTimeouts.delete(botId);
      }
      throw error;
    }
  }

  /* ── SSE ──────────────────────────────────────────────────── */

  addSseClient(botId, res) {
    if (!this.sseClients.has(botId)) this.sseClients.set(botId, new Set());
    this.sseClients.get(botId).add(res);
    
    // Send current state immediately
    const qr = this.getQR(botId);
    if (qr) this._sendSse(res, { type: "qr", qrUrl: qr });
    
    const status = this.getStatus(botId);
    if (status) this._sendSse(res, { type: "status", status: status });
    
    // Also send any existing pairing code from the instance
    const inst = this.instances.get(botId);
    if (inst && inst._lastPairingCode) {
      this._sendSse(res, { type: "pair_code", code: inst._lastPairingCode });
    }
  }

  removeSseClient(botId, res) { 
    this.sseClients.get(botId)?.delete(res); 
  }

  _broadcast(botId, payload) {
    const clients = this.sseClients.get(botId);
    if (clients?.size) {
      for (const res of clients) {
        this._sendSse(res, payload);
      }
    }
  }

  _sendSse(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      /* Flush for proxied environments (Nginx, Replit, etc.) */
      if (typeof res.flush === "function") res.flush();
    } catch (err) {
      // Client disconnected — will be cleaned up on next tick
      logger.debug("SSE send failed, client likely disconnected");
    }
  }

  _closeSseClients(botId) {
    const clients = this.sseClients.get(botId);
    if (clients) {
      for (const res of clients) { 
        try { 
          res.end(); 
        } catch {} 
      }
      this.sseClients.delete(botId);
    }
  }
}

export const botManager = new BotManager();