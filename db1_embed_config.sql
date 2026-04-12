-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Embed Widget Config
-- Phase 11.2: per-client widget customization stored in DB.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS embed_config (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id       text        NOT NULL UNIQUE,
  primary_color   text        DEFAULT '#2563eb',
  button_color    text        DEFAULT '#2563eb',
  text_color      text        DEFAULT '#ffffff',
  button_text     text        DEFAULT 'Chat with us',
  size            text        DEFAULT 'medium',   -- small | medium | large
  border_radius   text        DEFAULT '16',       -- px value as string
  logo_url        text,
  welcome_message text,
  delay_seconds   integer     DEFAULT 0,
  auto_open       boolean     DEFAULT false,
  position        text        DEFAULT 'bottom_right',  -- bottom_right | bottom_left
  bottom_offset   integer     DEFAULT 20,              -- px from bottom edge (increase to clear sticky navs)
  show_icon       boolean     DEFAULT true,            -- show 💬 bubble on launcher button
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embed_config_client_id_idx ON embed_config (client_id);

COMMENT ON TABLE embed_config IS
  'Per-client widget appearance and behavior settings. One row per client. Used by /web/config/:clientId and the portal Embed Builder.';
