-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 4 — One-Click Client Creation
--
-- Adds onboarding lifecycle tracking + bot mode to the clients table.
-- Run in Supabase DB1 SQL editor after db1_clients.sql.
-- Safe to run multiple times (IF NOT EXISTS / exception blocks).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS bot_mode          text NOT NULL DEFAULT 'test';

-- Check constraints (wrapped in exception blocks so re-runs don't error)
DO $$ BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_onboarding_status_check
    CHECK (onboarding_status IN ('created', 'configured', 'ready', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_bot_mode_check
    CHECK (bot_mode IN ('test', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Index for filtering by onboarding stage (e.g. show all clients not yet live)
CREATE INDEX IF NOT EXISTS clients_onboarding_status_idx
  ON clients (onboarding_status, created_at DESC);

-- Verify
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'clients'
   AND column_name IN ('onboarding_status', 'bot_mode');
