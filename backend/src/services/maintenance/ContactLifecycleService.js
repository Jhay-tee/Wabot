import { supabase } from "../../lib/supabase.js";
import { logger } from "../../utils/logger.js";

const CONTACT_TTL_HOURS = 48;
const RUN_INTERVAL_MS = 60 * 60 * 1000;

class ContactLifecycleService {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  async initialize() {
    await this.runArchivePass();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.runArchivePass().catch((err) => {
        logger.warn({ err }, "ContactLifecycleService archive pass failed");
      });
    }, RUN_INTERVAL_MS);
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runArchivePass() {
    if (this.running) return;
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - CONTACT_TTL_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("bot_contacts")
        .select("id, user_id, bot_id, contact_jid")
        .is("archived_at", null)
        .is("deleted_at", null)
        .lt("last_message_at", cutoff)
        .limit(500);

      if (error) throw error;
      if (!data?.length) return;

      const ids = data.map((row) => row.id);
      const { error: updateError } = await supabase
        .from("bot_contacts")
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in("id", ids);
      if (updateError) throw updateError;

      logger.info({ archivedContacts: ids.length }, "Archived stale bot contacts");
    } finally {
      this.running = false;
    }
  }
}

export const contactLifecycleService = new ContactLifecycleService();
