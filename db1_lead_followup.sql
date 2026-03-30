-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Lead Lifecycle + Follow-up Engine (Chunk 8)
-- Run in Supabase Project 1 → SQL Editor
--
-- Adds lifecycle columns to leads, extends status vocab,
-- and links scheduled_messages back to leads for stop-condition queries.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Lead lifecycle + profile columns ─────────────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up_at timestamptz DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_name     text        DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website           text        DEFAULT NULL;

-- ── Extend status enum ────────────────────────────────────────────────────────
-- Prior: new | contacted | scheduled | closed | ignored
-- Added: engaged (lead replied to a follow-up)
--        converted (lead became a customer — set manually or via future trigger)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'contacted', 'engaged', 'scheduled', 'converted', 'closed', 'ignored'));

-- ── Link scheduled_messages to leads ─────────────────────────────────────────
-- lead_id used by the worker to check lead status before sending.
-- If lead is engaged/converted, pending follow-ups are cancelled.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS lead_id uuid DEFAULT NULL;
CREATE INDEX IF NOT EXISTS scheduled_messages_lead_id_idx ON scheduled_messages (lead_id);
