-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Lead Capture Migration
-- Adds lead state columns to conversations and creates the leads table.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Lead state on conversations ───────────────────────────────────────────────
-- lead_step: null = not in flow | 1 = asked service | 2 = asked callback | 3 = asked timeframe
-- lead_data: JSON with { service, callback, timeframe }
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_step integer DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_data jsonb DEFAULT NULL;

-- ── LEADS ─────────────────────────────────────────────────────────────────────
-- Stores service/appointment requests captured via SMS lead flow.
-- Used by informational clients (no booking API) to collect guest requests
-- for manual follow-up by the business.
CREATE TABLE IF NOT EXISTS leads (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id            text NOT NULL,
  from_number          text NOT NULL,
  contact_name         text,
  contact_phone        text NOT NULL,
  requested_service    text,
  preferred_timeframe  text,
  notes                text,
  source               text DEFAULT 'sms',
  status               text DEFAULT 'new',  -- new | contacted | closed
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_client_id_idx   ON leads (client_id);
CREATE INDEX IF NOT EXISTS leads_from_number_idx ON leads (from_number);
CREATE INDEX IF NOT EXISTS leads_status_idx      ON leads (status);
CREATE INDEX IF NOT EXISTS leads_created_at_idx  ON leads (created_at DESC);
