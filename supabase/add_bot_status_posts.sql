-- Scheduled and immediate WhatsApp status posts per bot.
-- Run this migration against your Supabase/Postgres database.

CREATE TABLE IF NOT EXISTS bot_status_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'posted', 'failed', 'cancelled')),
  caption text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  media_type text,
  audience_count integer NOT NULL DEFAULT 0,
  publish_at timestamptz NOT NULL,
  posted_at timestamptz,
  processing_started_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_status_posts_user_id ON bot_status_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_status_posts_bot_id ON bot_status_posts(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_status_posts_status_publish_at ON bot_status_posts(status, publish_at);

DROP TRIGGER IF EXISTS bot_status_posts_updated_at ON bot_status_posts;
CREATE TRIGGER bot_status_posts_updated_at
  BEFORE UPDATE ON bot_status_posts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE bot_status_posts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bot_status_posts'
      AND policyname = 'Users can manage their own bot status posts'
  ) THEN
    CREATE POLICY "Users can manage their own bot status posts"
      ON bot_status_posts
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
