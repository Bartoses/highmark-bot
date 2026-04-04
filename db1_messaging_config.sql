-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGING CONFIG — Per-client SMS automation toggles (Phase 1, Chunk 1)
--
-- Run in Supabase DB1 SQL editor.
-- Controls which automated SMS messages each client sends.
-- Falls back to CONFIRMATIONS_ENABLED env var if no row exists for a client.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messaging_config (
  id                         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id                  text        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  enable_confirmation_texts  boolean     DEFAULT false,
  enable_reminders           boolean     DEFAULT false,
  reminder_hours_before      integer     DEFAULT 24,
  enable_cancellations       boolean     DEFAULT true,
  enable_rebooking           boolean     DEFAULT false,
  created_at                 timestamptz DEFAULT now(),
  updated_at                 timestamptz DEFAULT now(),
  UNIQUE(client_id)
);

-- reminder_hours_before must be between 1 and 168 (1 hour to 7 days)
ALTER TABLE messaging_config
  ADD CONSTRAINT reminder_hours_check CHECK (reminder_hours_before BETWEEN 1 AND 168);

-- Index for fast client lookups
CREATE INDEX IF NOT EXISTS idx_messaging_config_client_id ON messaging_config(client_id);

COMMENT ON TABLE messaging_config IS
  'Per-client SMS automation toggles. One row per client. Falls back to CONFIRMATIONS_ENABLED env var if no row exists.';
