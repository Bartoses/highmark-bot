-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Extend clients table with feature toggles + booking settings
-- Run in Supabase Project 1 → SQL Editor
--
-- Adds fields required for the portal Settings UI:
--   Feature Toggles: campaigns_enabled, followups_enabled, human_handoff_enabled
--   Booking: booking_link (single URL for informational/hybrid clients)
--   Future: settings_json (extensible blob for future settings)
--
-- Safe to run multiple times (IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS).
-- Defaults match current behavior so existing clients are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaigns_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS followups_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS human_handoff_enabled  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS booking_link           TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS settings_json          JSONB;
