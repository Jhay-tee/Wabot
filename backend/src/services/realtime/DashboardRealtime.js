import { supabase } from "../../lib/supabase.js";
import { logger } from "../../utils/logger.js";

const TRACKED_TABLES = [
  "users",
  "bots",
  "bot_activity",
  "subscriptions",
  "api_keys",
  "message_templates",
];

class DashboardRealtime {
  constructor() {
    this.channel = null;
    this.clients = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized || this.channel) return;

    this.channel = supabase.channel("wabot-dashboard-realtime");

    for (const table of TRACKED_TABLES) {
      this.channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (payload) => this.handleChange(table, payload)
      );
    }

    await new Promise((resolve) => {
      this.channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.initialized = true;
          logger.info("✓ DashboardRealtime subscribed");
          resolve();
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          logger.warn({ status }, "DashboardRealtime subscription status");
          resolve();
        }
      });
    });
  }

  addClient(userId, res) {
    if (!userId || !res) return;
    const set = this.clients.get(userId) ?? new Set();
    set.add(res);
    this.clients.set(userId, set);
  }

  removeClient(userId, res) {
    const set = this.clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(userId);
  }

  handleChange(table, payload) {
    const row = payload?.new ?? payload?.old ?? {};
    const userId = this.getUserId(table, row);
    if (!userId) return;

    this.broadcast(userId, {
      type: "dashboard_refresh",
      table,
      event: payload?.eventType ?? "UNKNOWN",
      at: new Date().toISOString(),
    });
  }

  getUserId(table, row) {
    if (!row || typeof row !== "object") return null;
    if (table === "users") return row.id ?? null;
    return row.user_id ?? null;
  }

  broadcast(userId, message) {
    const set = this.clients.get(userId);
    if (!set?.size) return;

    const body = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of set) {
      try {
        res.write(body);
      } catch {
        this.removeClient(userId, res);
      }
    }
  }
}

export const dashboardRealtime = new DashboardRealtime();
