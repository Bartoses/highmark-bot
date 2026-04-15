-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Dashboard Checklist Dismiss
-- Phase 2B: per-client flag to hide the getting-started checklist.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS dashboard_checklist_dismissed BOOLEAN DEFAULT FALSE;
