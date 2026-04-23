-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Sprint 5: Activity Distribution Network
-- Run in Supabase Project 1 → SQL Editor
--
-- Stores partner operator activities that a client can resell / refer out.
-- These surface as Source 5 inside resolveBookingLink() and are injected
-- into the bot's system prompt so the bot can recommend them naturally.
-- Link clicks are tracked via /track/partner → web_events (partner_link_clicked).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS partner_activities (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text        NOT NULL,          -- owner (the reseller)
  partner_name    text        NOT NULL,          -- operator / brand
  activity_name   text        NOT NULL,          -- product name shown to guest
  category        text        NOT NULL,          -- tour | rental | lodging | dining | transport | other
  description     text        DEFAULT '',
  booking_url     text        NOT NULL,          -- destination URL the tracker redirects to
  price_range     text        DEFAULT NULL,      -- display-only e.g. "$75–$150"
  commission_pct  numeric(5,2) DEFAULT NULL,     -- stored for reporting; not shown to guests
  seasons         text[]      DEFAULT ARRAY['all'], -- winter | summer | shoulder | all
  keywords        text[]      DEFAULT ARRAY[]::text[], -- matching hints: "kayak", "fly fishing", ...
  location        text        DEFAULT NULL,      -- optional location hint (town / area)
  enabled         boolean     NOT NULL DEFAULT true,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_activities_client_idx
  ON partner_activities (client_id, enabled);

CREATE INDEX IF NOT EXISTS partner_activities_seasons_gin_idx
  ON partner_activities USING GIN (seasons);

CREATE INDEX IF NOT EXISTS partner_activities_keywords_gin_idx
  ON partner_activities USING GIN (keywords);

COMMENT ON TABLE partner_activities IS
  'Sprint 5: referral / resell catalog. Bot recommends these when its own booking options do not match the guest request. Clicks tracked via /track/partner.';
