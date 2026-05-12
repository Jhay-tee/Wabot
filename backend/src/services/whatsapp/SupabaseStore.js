/**
 * SupabaseStore — Custom Baileys auth state backed by Supabase.
 * Saves WhatsApp credentials + Signal keys so bots survive server restarts
 * without requiring a new QR scan.
 */

import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { supabase } from "../../lib/supabase.js";

/**
 * Creates a Baileys-compatible auth state that persists in Supabase.
 * @param {string} botId - UUID of the bot
 * @returns {{ state: AuthenticationState, saveCreds: Function }}
 */
export async function createSupabaseAuthState(botId) {
  const { data } = await supabase
    .from("bot_sessions")
    .select("creds, keys")
    .eq("bot_id", botId)
    .maybeSingle();

  // Deserialize stored creds using Baileys' BufferJSON reviver
  let creds;
  try {
    creds = data?.creds
      ? JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver)
      : initAuthCreds();
  } catch {
    creds = initAuthCreds();
  }

  // In-memory key cache — flushed to Supabase on every write
  let keysCache = {};
  try {
    if (data?.keys) {
      const raw = JSON.stringify(data.keys);
      keysCache = JSON.parse(raw, BufferJSON.reviver);
    }
  } catch {
    keysCache = {};
  }

  /* Persist both creds and keys in a single upsert */
  const saveAll = async () => {
    try {
      const credsJson  = JSON.parse(JSON.stringify(creds,     BufferJSON.replacer));
      const keysJson   = JSON.parse(JSON.stringify(keysCache, BufferJSON.replacer));
      await supabase.from("bot_sessions").upsert(
        { bot_id: botId, creds: credsJson, keys: keysJson, updated_at: new Date().toISOString() },
        { onConflict: "bot_id" }
      );
    } catch (err) {
      console.error("[SupabaseStore] save failed:", err.message);
    }
  };

  const state = {
    creds,
    keys: {
      /** Retrieve Signal keys by type+id pairs */
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const k = `${type}:${id}`;
          if (keysCache[k] !== undefined) result[id] = keysCache[k];
        }
        return result;
      },
      /** Write (or delete if null) Signal keys, then persist */
      set: async (data) => {
        for (const [type, typeData] of Object.entries(data)) {
          if (!typeData) continue;
          for (const [id, value] of Object.entries(typeData)) {
            const k = `${type}:${id}`;
            if (value !== null && value !== undefined) {
              keysCache[k] = value;
            } else {
              delete keysCache[k];
            }
          }
        }
        await saveAll();
      }
    }
  };

  return { state, saveCreds: saveAll };
}

/** Delete persisted session so the next connection requires a new QR scan. */
export async function clearSupabaseSession(botId) {
  await supabase.from("bot_sessions").delete().eq("bot_id", botId);
}
