-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Phase 11.5: Web events + attribution
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS web_events (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id   text        NOT NULL,
  session_id  text,
  channel     text        NOT NULL DEFAULT 'web',   -- web | sms
  page_url    text,                                  -- full URL of the host page (null for SMS)
  event_type  text        NOT NULL,                  -- chat_started | message_sent | lead_captured | booking_clicked
  metadata    jsonb       DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);

-- Multi-tenant index: every query filters by client_id first
CREATE INDEX IF NOT EXISTS web_events_client_created_idx ON web_events (client_id, created_at DESC);

-- Per-session lookup (lead linkage)
CREATE INDEX IF NOT EXISTS web_events_session_idx ON web_events (session_id) WHERE session_id IS NOT NULL;

-- Event type filter (used in attribution aggregations)
CREATE INDEX IF NOT EXISTS web_events_type_idx ON web_events (client_id, event_type, created_at DESC);

COMMENT ON TABLE web_events IS
  'Per-message and per-event tracking for web chat and SMS. Aggregated by page_url for attribution.';
