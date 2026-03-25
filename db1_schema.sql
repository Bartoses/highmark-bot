-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 SCHEMA — Conversations + Knowledge Base
-- Run this in Supabase Project 1 → SQL Editor
--
-- IMPORTANT: If upgrading from a previous version, the ALTER TABLE statements
-- below safely add new columns to an existing conversations table and migrate
-- booking_step from TEXT to INTEGER.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── CONVERSATIONS ─────────────────────────────────────────────────────────────
-- Migrate booking_step from TEXT → INTEGER if the table already exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'booking_step'
    AND data_type = 'text'
  ) THEN
    ALTER TABLE conversations
      ALTER COLUMN booking_step TYPE integer
      USING CASE
        WHEN booking_step IS NULL THEN NULL
        WHEN booking_step ~ '^\d+$' THEN booking_step::integer
        ELSE NULL
      END;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversations (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  from_number           text NOT NULL,
  to_number             text NOT NULL,
  messages              jsonb DEFAULT '[]',
  booking_step          integer DEFAULT NULL,
  booking_data          jsonb DEFAULT '{"activity":null,"date":null,"groupSize":null,"company":null,"booking_pk":null}',
  handoff               boolean DEFAULT false,
  consecutive_frustrated integer DEFAULT 0,
  session_type          text DEFAULT 'live',
  fareharbor_checked    boolean DEFAULT false,
  availability_response jsonb DEFAULT NULL,
  date_requested        text DEFAULT NULL,
  client_id             text DEFAULT 'csr_rea',
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (from_number, to_number)
);

-- Add new columns to existing table if they don't exist
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS consecutive_frustrated integer DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_type text DEFAULT 'live';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS fareharbor_checked boolean DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS availability_response jsonb DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS date_requested text DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS client_id text DEFAULT 'csr_rea';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS conversations_from_number_idx ON conversations (from_number);
CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at);

-- ── KNOWLEDGE BASE ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_base (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id      text NOT NULL,
  type           text NOT NULL,
  key            text UNIQUE NOT NULL,
  data           jsonb NOT NULL,
  summary        text NOT NULL,
  fetched_at     timestamptz DEFAULT now(),
  next_refresh_at timestamptz NOT NULL
);

-- ── CONFIRMATIONS SENT ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS confirmations_sent (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_pk           text UNIQUE NOT NULL,
  guest_phone          text NOT NULL,
  guest_name           text,
  company              text NOT NULL,
  item_name            text NOT NULL,
  start_at             timestamptz NOT NULL,
  confirmation_sent_at timestamptz DEFAULT now(),
  source               text NOT NULL
);

-- ── SETTINGS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('last_booking_poll',   '1970-01-01T00:00:00Z'),
  ('last_website_scrape', '1970-01-01T00:00:00Z')
ON CONFLICT (key) DO NOTHING;
