-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 MIGRATION — scheduled_messages table
-- Run this in Supabase Project 1 → SQL Editor (DB1, conversations project)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       text         NOT NULL DEFAULT 'csr_rea',
  conversation_id uuid         NULL,
  phone           text         NOT NULL,
  body            text         NOT NULL,
  message_type    text         NOT NULL,    -- e.g. 'booking_followup', 'campaign'
  send_at         timestamptz  NOT NULL,
  status          text         NOT NULL DEFAULT 'pending',
                               -- pending | processing | sent | failed | cancelled
  attempts        integer      NOT NULL DEFAULT 0,
  max_attempts    integer      NOT NULL DEFAULT 3,
  twilio_sid      text         NULL,
  error           text         NULL,
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  sent_at         timestamptz  NULL,
  locked_at       timestamptz  NULL,        -- set when worker claims row
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- Primary worker query: find due pending messages
CREATE INDEX IF NOT EXISTS scheduled_messages_status_send_at_idx
  ON scheduled_messages (status, send_at);

-- Opt-out check and per-phone lookups
CREATE INDEX IF NOT EXISTS scheduled_messages_phone_idx
  ON scheduled_messages (phone);

-- Per-client reporting
CREATE INDEX IF NOT EXISTS scheduled_messages_client_id_idx
  ON scheduled_messages (client_id);

-- Enable RLS (service role key bypasses automatically — bot unaffected)
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
