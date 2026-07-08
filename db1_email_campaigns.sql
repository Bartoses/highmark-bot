-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Email Marketing Campaigns
-- Run in Supabase Project 1 → SQL Editor
--
-- Mirrors the SMS `campaigns` table but for outbound marketing email (Resend).
-- Send pipeline / open-click tracking columns are included now (additive,
-- populated by a later phase) so this migration doesn't need to run twice —
-- same pattern as voice_calls.spam_score/lead_score in db1_voice.sql.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_campaigns (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text        NOT NULL,
  name                text        NOT NULL,
  template_key        text        NOT NULL DEFAULT 'newsletter',
                                        -- newsletter | promo | season_announcement | thank_you
  subject             text        NOT NULL,
  preview_text        text        DEFAULT NULL,
  body_html           text        NOT NULL,
  from_name           text        DEFAULT NULL,   -- defaults to client display name if unset
  reply_to            text        DEFAULT NULL,   -- defaults to client support_email if unset
  audience_type       text        NOT NULL DEFAULT 'crm_contacts',
                                        -- crm_contacts | custom_emails
  audience_filter     jsonb       NOT NULL DEFAULT '{}'::jsonb,
                                        -- { emails: [...] } for custom_emails
  status              text        NOT NULL DEFAULT 'draft',
                                        -- draft | scheduled | sending | sent | failed
  scheduled_at        timestamptz DEFAULT NULL,
  sent_at             timestamptz DEFAULT NULL,
  -- Populated once the send pipeline (Phase 4) ships:
  total_sent          integer     NOT NULL DEFAULT 0,
  total_opened        integer     NOT NULL DEFAULT 0,
  total_clicked       integer     NOT NULL DEFAULT 0,
  total_bounced       integer     NOT NULL DEFAULT 0,
  total_unsubscribed  integer     NOT NULL DEFAULT 0,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_campaigns_client_id_idx ON email_campaigns (client_id);
CREATE INDEX IF NOT EXISTS email_campaigns_status_idx    ON email_campaigns (status);

ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
