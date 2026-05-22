-- Add monotonic auth state versioning for race-safe Baileys session persistence.
ALTER TABLE bot_sessions
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS bot_sessions_state_version_idx
  ON bot_sessions(bot_id, state_version DESC);
