-- Rolling AI context, assistant leads, and contact lifecycle support.

CREATE TABLE IF NOT EXISTS bot_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  contact_jid text NOT NULL,
  phone_number text,
  display_name text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_contacts_bot_id_contact_jid_key UNIQUE (bot_id, contact_jid)
);

CREATE INDEX IF NOT EXISTS bot_contacts_user_id_idx ON bot_contacts(user_id);
CREATE INDEX IF NOT EXISTS bot_contacts_bot_id_idx ON bot_contacts(bot_id);
CREATE INDEX IF NOT EXISTS bot_contacts_last_message_at_idx ON bot_contacts(last_message_at DESC);
CREATE INDEX IF NOT EXISTS bot_contacts_archived_at_idx ON bot_contacts(archived_at);

ALTER TABLE bot_contacts ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS bot_contacts_updated_at ON bot_contacts;
CREATE TRIGGER bot_contacts_updated_at
  BEFORE UPDATE ON bot_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  contact_jid text NOT NULL,
  is_group boolean NOT NULL DEFAULT false,
  summary_text text NOT NULL DEFAULT '',
  recent_turns jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_ai_response_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_conversations_bot_id_conversation_id_key UNIQUE (bot_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_id_idx ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS ai_conversations_bot_id_idx ON ai_conversations(bot_id);
CREATE INDEX IF NOT EXISTS ai_conversations_last_message_at_idx ON ai_conversations(last_message_at DESC);

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS ai_conversations_updated_at ON ai_conversations;
CREATE TRIGGER ai_conversations_updated_at
  BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS assistant_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  contact_jid text NOT NULL,
  name text,
  phone text,
  message text NOT NULL,
  source text NOT NULL DEFAULT 'assistant',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_leads_user_id_idx ON assistant_leads(user_id);
CREATE INDEX IF NOT EXISTS assistant_leads_bot_id_idx ON assistant_leads(bot_id);
CREATE INDEX IF NOT EXISTS assistant_leads_created_at_idx ON assistant_leads(created_at DESC);

ALTER TABLE assistant_leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE bot_contacts REPLICA IDENTITY FULL;
ALTER TABLE ai_conversations REPLICA IDENTITY FULL;
ALTER TABLE assistant_leads REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE bot_contacts;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE ai_conversations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE assistant_leads;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
