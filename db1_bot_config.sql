-- ─────────────────────────────────────────────────────────────────────────────
-- BOT CONFIG — Per-client bot identity + AI behavior overrides (Phase 1, Chunk 2)
--
-- Run in Supabase DB1 SQL editor.
-- These values override the corresponding columns on the `clients` table.
-- Falls back to clients.bot_name / clients.tone / clients.opener_text if no row.
--
-- system_prompt_addon is NEW — appended to every system prompt for the client,
-- allowing custom AI instructions without code changes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_config (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id            text        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  bot_name             text,
  tone                 text,
  opener_text          text,
  system_prompt_addon  text,         -- custom instructions appended to every system prompt
  handoff_message      text,         -- override the default human handoff text
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),
  UNIQUE(client_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_config_client_id ON bot_config(client_id);

COMMENT ON TABLE bot_config IS
  'Per-client bot identity overrides + custom AI instructions. Overrides clients table values at runtime.';
COMMENT ON COLUMN bot_config.system_prompt_addon IS
  'Text appended to the end of every system prompt. Use for business-specific rules, restrictions, or persona details.';
