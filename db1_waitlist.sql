-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Waitlist Migration
-- Adds waitlist state to conversations and lead_type to leads.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Waitlist state on conversations ───────────────────────────────────────────
-- waitlist_pending: true = waiting for guest YES/NO confirmation
-- waitlist_context: JSON with { service, date } — what they were interested in
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS waitlist_pending boolean DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS waitlist_context jsonb    DEFAULT NULL;

-- ── lead_type on leads ─────────────────────────────────────────────────────────
-- 'booking'  — Lone Pine 3-step service request flow
-- 'waitlist' — any client: guest wants to be notified when availability opens
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lead_type text DEFAULT 'booking';

CREATE INDEX IF NOT EXISTS leads_lead_type_idx ON leads (lead_type);
