-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Campaign Engine (Chunk 9)
-- Run in Supabase Project 1 → SQL Editor
--
-- Creates the campaigns and campaign_recipients tables.
-- Messages are delivered via the existing scheduled_messages system.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
-- One row per campaign. audience_type drives who receives it.
CREATE TABLE IF NOT EXISTS campaigns (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text        NOT NULL,
  name          text        NOT NULL,
  message_body  text        NOT NULL,
  audience_type text        NOT NULL DEFAULT 'all_leads',
                                    -- all_leads | engaged_leads | new_leads
  status        text        NOT NULL DEFAULT 'draft',
                                    -- draft | scheduled | sending | sent | failed
  scheduled_at  timestamptz DEFAULT NULL,   -- null = send immediately on trigger
  sent_at       timestamptz DEFAULT NULL,   -- set when sending starts
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── CAMPAIGN RECIPIENTS ───────────────────────────────────────────────────────
-- One row per lead targeted by a campaign.
-- Updated by the scheduled_messages worker as messages are sent/failed.
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid        NOT NULL REFERENCES campaigns(id),
  lead_id      uuid        DEFAULT NULL,
  phone        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
                                    -- pending | sent | failed | cancelled
  sent_at      timestamptz DEFAULT NULL,
  error        text        DEFAULT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaigns_client_id_idx          ON campaigns (client_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx             ON campaigns (status);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_id  ON campaign_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_lead_id      ON campaign_recipients (lead_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_status       ON campaign_recipients (status);
