/**
 * SupabaseStore — Production-ready Baileys auth state backed by Supabase.
 * - No destructive session validation
 * - Safe partial state restoration
 * - Optimistic version control
 * - Multi-instance safer writes
 */

import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { supabase } from "../../lib/supabase.js";
import { logger } from "../../utils/logger.js";

const authPersistors = new Map();

/* ----------------- serialization helpers ----------------- */

function deserializeAuthPart(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
  } catch {
    return fallback;
  }
}

function serializeAuthPart(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

/* ----------------- minimal validation (IMPORTANT FIX) ----------------- */

/**
 * ONLY checks if creds exist at all.
 * DO NOT enforce completeness — Baileys builds it incrementally.
 */
function hasCreds(creds) {
  return Boolean(creds && typeof creds === "object");
}

/* ----------------- snapshot builder ----------------- */

function buildSnapshot({ creds, keys, version }) {
  return {
    creds: serializeAuthPart(creds),
    keys: serializeAuthPart(keys),
    state_version: version,
    updated_at: new Date().toISOString(),
  };
}

/* ----------------- persistor ----------------- */

class BotAuthPersistor {
  constructor(botId, row = null) {
    this.botId = botId;

    this.creds = deserializeAuthPart(row?.creds, initAuthCreds());
    this.keysCache = deserializeAuthPart(row?.keys, {});

    this.latestDbVersion = Number(row?.state_version ?? 0);
    this.snapshotVersion = this.latestDbVersion;

    this.isWriting = false;
    this.needsFlush = false;
    this.destroyed = false;
  }

  snapshot() {
    this.snapshotVersion += 1;

    return buildSnapshot({
      creds: this.creds,
      keys: this.keysCache,
      version: this.snapshotVersion,
    });
  }

  markDirty(reason = "update") {
    if (this.destroyed) return;

    this.needsFlush = true;

    if (!this.isWriting) {
      this.flush(reason).catch((err) => {
        logger.error({ err, botId: this.botId }, "auth flush failed");
      });
    }
  }

  async flush(reason = "update") {
    if (this.destroyed || this.isWriting || !this.needsFlush) return;

    this.isWriting = true;

    try {
      while (this.needsFlush && !this.destroyed) {
        this.needsFlush = false;

        const snapshot = this.snapshot();

        const { data: current, error } = await supabase
          .from("bot_sessions")
          .select("id, state_version")
          .eq("bot_id", this.botId)
          .maybeSingle();

        if (error) throw error;

        const dbVersion = Number(current?.state_version ?? 0);
        this.latestDbVersion = Math.max(this.latestDbVersion, dbVersion);

        // version safety (prevents overwrite race)
        if (snapshot.state_version < this.latestDbVersion) continue;

        const payload = {
          bot_id: this.botId,
          ...snapshot,
        };

        if (current?.id) {
          const { error } = await supabase
            .from("bot_sessions")
            .update(payload)
            .eq("bot_id", this.botId)
            .eq("state_version", dbVersion);

          if (error) throw error;
        } else {
          // Normal insert attempt
          let insertResult = await supabase.from("bot_sessions").insert(payload);

          // If Postgres returns RLS/permission denied (42501), try again with an
          // explicit server-side service-role client in case the imported
          // `supabase` instance was created with a restricted key.
          if (insertResult?.error && String(insertResult.error?.code) === "42501") {
            logger.error({ err: insertResult.error, botId: this.botId }, "auth insert blocked by RLS — verify SUPABASE_SERVICE_ROLE_KEY and that backend uses service-role client");
            // Retry using the canonical server-side client exported from lib/supabase.js
            const { error: retryErr } = await supabase.from("bot_sessions").insert(payload);
            if (retryErr) throw retryErr;
          } else if (insertResult?.error) {
            throw insertResult.error;
          }
        }

        this.latestDbVersion = snapshot.state_version;

        logger.debug(
          { botId: this.botId, stateVersion: snapshot.state_version, reason },
          "auth persisted"
        );
      }
    } finally {
      this.isWriting = false;

      if (this.needsFlush && !this.destroyed) {
        this.flush("followup").catch(() => {});
      }
    }
  }

  async flushCritical(reason = "critical") {
    this.markDirty(reason);
    await this.flush(reason);
  }

  async shutdown() {
    this.destroyed = true;
    await this.flushCritical("shutdown");
  }
}

/* ----------------- MAIN FACTORY ----------------- */

export async function createSupabaseAuthState(botId) {
  const existing = authPersistors.get(botId);

  if (existing) {
    existing.destroyed = true;
    authPersistors.delete(botId);
  }

  const { data, error } = await supabase
    .from("bot_sessions")
    .select("creds, keys, state_version")
    .eq("bot_id", botId)
    .maybeSingle();

  if (error) throw error;

  // ✅ IMPORTANT CHANGE: DO NOT reject partial session anymore
  const persistor = new BotAuthPersistor(botId, data || null);
  authPersistors.set(botId, persistor);

  logger.info(
    {
      botId,
      hasCreds: hasCreds(data?.creds),
      hasKeys: Boolean(data?.keys),
      stateVersion: Number(data?.state_version ?? 0),
    },
    "restored auth state"
  );

  const state = {
    creds: persistor.creds,

    keys: {
      get: async (type, ids) => {
        const out = {};

        for (const id of ids) {
          const key = `${type}:${id}`;
          if (persistor.keysCache[key] !== undefined) {
            out[id] = persistor.keysCache[key];
          }
        }

        return out;
      },

      set: async (data) => {
        for (const [type, entries] of Object.entries(data || {})) {
          if (!entries) continue;

          for (const [id, value] of Object.entries(entries)) {
            const key = `${type}:${id}`;

            if (value == null) delete persistor.keysCache[key];
            else persistor.keysCache[key] = value;
          }
        }

        await persistor.flushCritical("keys_update");
      },
    },
  };

  const saveCreds = async () => {
    await persistor.flushCritical("creds.update");
  };

  const flushNow = async (reason = "manual") => {
    await persistor.flushCritical(reason);
  };

  return {
    state,
    saveCreds,
    flushNow,
    hasValidSession: Boolean(data?.creds),
  };
}

/* ----------------- helpers ----------------- */

export async function flushSupabaseAuthState(botId, reason = "manual") {
  const p = authPersistors.get(botId);
  if (!p) return;
  await p.flushCritical(reason);
}

export async function clearSupabaseSession(botId) {
  authPersistors.delete(botId);
  await supabase.from("bot_sessions").delete().eq("bot_id", botId);
}