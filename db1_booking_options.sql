-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Flexible booking options (Chunk 14)
-- Run in Supabase Project 1 → SQL Editor
--
-- Adds client_booking_options table for managing per-client booking links.
-- Supports link-based and API-based booking options with ordering and metadata.
--
-- booking_mode values supported:
--   static_links    — show numbered list of links to guest
--   hybrid          — show links + phone CTA
--   call_only       — phone CTA only (no links shown)
--   api_live_booking — alias for fareharbor (same behavior)
--
-- Falls back gracefully to clients.booking_urls if no rows exist for a client.
-- Safe to run multiple times (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_booking_options (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type          TEXT    NOT NULL DEFAULT 'link'
                  CHECK (type IN ('link', 'api')),
  title         TEXT    NOT NULL,
  description   TEXT,
  url           TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_options_client ON client_booking_options(client_id, active);
