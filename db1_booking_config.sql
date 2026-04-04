-- ─────────────────────────────────────────────────────────────────────────────
-- BOOKING CONFIG — Per-client booking behavior overrides (Phase 1, Chunk 2)
--
-- Run in Supabase DB1 SQL editor.
-- These values override booking-related columns on the `clients` table.
-- Falls back to clients.booking_mode / clients.booking_link if no row.
--
-- call_cta_text is NEW — custom call-to-action text shown when
-- booking_mode = call_only or hybrid.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS booking_config (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       text        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  booking_mode    text,
  booking_link    text,
  call_cta_text   text,         -- custom phone CTA shown in call_only/hybrid mode
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(client_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_config_client_id ON booking_config(client_id);

COMMENT ON TABLE booking_config IS
  'Per-client booking behavior overrides. Overrides clients table booking columns at runtime.';
COMMENT ON COLUMN booking_config.call_cta_text IS
  'Custom CTA text injected when booking_mode is call_only or hybrid. Defaults to standard phone number prompt.';
