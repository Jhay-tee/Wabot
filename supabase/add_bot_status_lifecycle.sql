-- Expand bot status lifecycle to support explicit QR and pairing-code states.
ALTER TABLE bots
  DROP CONSTRAINT IF EXISTS bots_status_check;

ALTER TABLE bots
  ADD CONSTRAINT bots_status_check
  CHECK (
    status IN (
      'idle',
      'connecting',
      'awaiting_qr',
      'awaiting_qr_scan',
      'qr_generated',
      'awaiting_code',
      'awaiting_pairing',
      'code_generated',
      'awaiting_link',
      'connected',
      'reconnecting',
      'disconnected',
      'qr_timeout',
      'failed',
      'error'
    )
  );
