-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Lead Management Migration
-- Extends the leads table for admin workflow use.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Extend status vocabulary ───────────────────────────────────────────────────
-- Original statuses: new | contacted | closed
-- Added: scheduled | ignored
-- Drop the old check constraint if it exists, then add the full set.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'contacted', 'scheduled', 'closed', 'ignored'));

-- ── Audit: who last updated the lead ──────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS updated_by text DEFAULT NULL;
