-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Site Content Management
-- Run this in Supabase Project 1 → SQL Editor
--
-- Stores editable marketing site content by section.
-- Each row is one section (hero, pricing, faq, etc.).
-- content is a jsonb object — only overrides need to be stored;
-- the app merges DB content on top of code defaults at runtime.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS site_content (
  section    text PRIMARY KEY,
  content    jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- No seed data — empty table means all defaults from code are used
