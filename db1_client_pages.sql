-- Phase 2: Page-level website content storage for whole-site crawler
-- Run in Supabase DB1 SQL editor once, before enabling crawl_settings.enabled on any client.
--
-- Each row = one crawled page for a client.
-- Deduped by (client_id, normalized_url).
-- Fact extraction is hash-gated: content_hash prevents redundant Haiku calls.

CREATE TABLE IF NOT EXISTS client_pages (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  normalized_url  TEXT        NOT NULL,
  page_type       TEXT,                   -- homepage|services|pricing|booking|faq|policies|hours|contact|seasonal|other
  title           TEXT,
  clean_text      TEXT,                   -- extracted plain text, capped at 3000 chars
  content_hash    TEXT,                   -- SHA-256 prefix (16 chars) — gates Haiku re-extraction
  extracted_facts JSONB,                  -- { summary, key_facts: [] } from Haiku
  summary         TEXT,                   -- short one-sentence summary (from extracted_facts.summary)
  fetched_at      TIMESTAMPTZ,
  status          TEXT        DEFAULT 'ok',   -- ok | error | skipped
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS client_pages_client_type_idx ON client_pages (client_id, page_type);
CREATE INDEX IF NOT EXISTS client_pages_client_status_idx ON client_pages (client_id, status);
CREATE INDEX IF NOT EXISTS client_pages_updated_idx ON client_pages (updated_at);
