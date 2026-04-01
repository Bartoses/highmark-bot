-- Phase 2: Crawl configuration per client
-- Run in Supabase DB1 SQL editor after db1_clients.sql.
--
-- crawl_settings JSONB schema:
-- {
--   "enabled":       true/false,          -- must be true to activate crawler
--   "primary_url":   "https://...",       -- root URL to start from
--   "seed_urls":     ["https://..."],     -- additional starting pages
--   "max_depth":     2,                   -- link-hop depth (default 2, max 3)
--   "max_pages":     20,                  -- total page cap (default 20, max 50)
--   "deny_patterns": ["/blog", "/news"]   -- URL substrings to skip
-- }
--
-- Example: enable crawler for a DB-backed client via portal curl:
--   PATCH /admin/clients/:id { "crawl_settings": { "enabled": true, "primary_url": "https://example.com" } }

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS crawl_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
