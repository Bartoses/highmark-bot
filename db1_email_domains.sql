-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Email Marketing: per-client sending domain (Phase 2)
-- Run in Supabase Project 1 → SQL Editor
--
-- One verified sending domain per client (their own domain, not the shared
-- usehighmark.com) so deliverability/reputation is isolated per client — see
-- Roadmap "PLANNED — Email Marketing" Phase 2. Registered via the Resend
-- Domains API (resendDomains.js); `records` caches the DNS records Resend
-- wants so the portal can render instructions without an extra API round
-- trip on every page load.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_email_domains (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text        NOT NULL UNIQUE,
  domain            text        NOT NULL,
  resend_domain_id  text        DEFAULT NULL,
  from_local_part   text        NOT NULL DEFAULT 'hello',  -- local-part before @domain
  status            text        NOT NULL DEFAULT 'not_started',
                                      -- not_started | pending | verified | failed | temporary_failure
  records           jsonb       NOT NULL DEFAULT '[]'::jsonb, -- Resend's DNS records to add
  region            text        DEFAULT NULL,
  last_checked_at   timestamptz DEFAULT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_email_domains_client_idx ON client_email_domains (client_id);

ALTER TABLE client_email_domains ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE client_email_domains IS
  'Highmark Email Marketing Phase 2: one Resend-verified sending domain per client. Campaign sends stay on the shared usehighmark.com fallback until status=verified.';
