-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Multi-source website scraping (Chunk 14)
-- Run in Supabase Project 1 → SQL Editor
--
-- Adds client_scrape_sources table for managing per-client KB scrape URLs.
-- Supports multiple sources per client with labels, type tags, and ordering.
--
-- Falls back gracefully to clients.scrape_urls if no rows exist for a client.
-- Safe to run multiple times (IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_scrape_sources (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   TEXT    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url         TEXT    NOT NULL,
  label       TEXT,
  source_type TEXT    NOT NULL DEFAULT 'website'
                CHECK (source_type IN ('website', 'faq', 'booking', 'policies', 'blog')),
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scrape_sources_client ON client_scrape_sources(client_id, active);
