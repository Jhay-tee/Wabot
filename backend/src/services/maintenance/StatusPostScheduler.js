import { supabase } from "../../lib/supabase.js";
import { botManager } from "../whatsapp/BotManager.js";
import { logger } from "../../utils/logger.js";

const POLL_MS = 15_000;
const BATCH_SIZE = 20;

class StatusPostScheduler {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  async initialize() {
    if (this._timer) return;
    await this._tick();
    this._timer = setInterval(() => {
      this._tick().catch((err) => {
        logger.error({ err }, "StatusPostScheduler tick failed");
      });
    }, POLL_MS);
    logger.info("StatusPostScheduler initialized");
  }

  async shutdown() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    if (this._running) return;
    this._running = true;

    try {
      const nowIso = new Date().toISOString();
      const { data: duePosts, error } = await supabase
        .from("bot_status_posts")
        .select("id, user_id, bot_id, payload, status_options, media_type")
        .eq("status", "scheduled")
        .lte("publish_at", nowIso)
        .order("publish_at", { ascending: true })
        .limit(BATCH_SIZE);

      if (error) throw error;

      for (const post of duePosts ?? []) {
        await this._processPost(post);
      }
    } finally {
      this._running = false;
    }
  }

  async _processPost(post) {
    const claimTime = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("bot_status_posts")
      .update({
        status: "processing",
        processing_started_at: claimTime,
        error_message: null,
      })
      .eq("id", post.id)
      .eq("status", "scheduled")
      .select("id, user_id, bot_id, payload, status_options, media_type")
      .single();

    if (claimError || !claimed) return;

    try {
      const result = await botManager.postStatus(claimed.bot_id, claimed.payload, claimed.status_options ?? {});
      const postedAt = new Date().toISOString();

      await supabase
        .from("bot_status_posts")
        .update({
          status: "posted",
          posted_at: postedAt,
          processing_started_at: null,
          audience_count: result.audienceCount,
          error_message: null,
        })
        .eq("id", claimed.id);

      await supabase.from("bot_activity").insert({
        user_id: claimed.user_id,
        bot_id: claimed.bot_id,
        event_type: "scheduled_status_posted",
        details: "Scheduled WhatsApp status published",
        metadata: {
          post_id: claimed.id,
          audience_count: result.audienceCount,
          media_type: claimed.media_type,
        },
      }).catch(() => {});
    } catch (err) {
      await supabase
        .from("bot_status_posts")
        .update({
          status: "failed",
          processing_started_at: null,
          error_message: err.message ?? "Scheduled status post failed.",
        })
        .eq("id", claimed.id);

      await supabase.from("bot_activity").insert({
        user_id: claimed.user_id,
        bot_id: claimed.bot_id,
        event_type: "scheduled_status_failed",
        details: "Scheduled WhatsApp status failed",
        metadata: {
          post_id: claimed.id,
          error: err.message ?? "Unknown error",
          media_type: claimed.media_type,
        },
      }).catch(() => {});

      logger.warn({ err, botId: claimed.bot_id, postId: claimed.id }, "Scheduled status post failed");
    }
  }
}

export const statusPostScheduler = new StatusPostScheduler();
