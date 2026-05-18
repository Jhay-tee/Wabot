-- Table to hold temporary pairing codes for manual pairing flows
CREATE TABLE IF NOT EXISTS pairing_codes (
  id bigserial PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  code varchar(16) NOT NULL,
  phone varchar(32),
  claimed boolean DEFAULT false,
  session_data jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_bot_id ON pairing_codes(bot_id);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON pairing_codes(code);
