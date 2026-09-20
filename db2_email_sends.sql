-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 (CSR/REA CRM) — per-recipient email send log + queue
-- Run once in the DB2 Supabase SQL editor. Additive + idempotent.
--
-- One row per (campaign, address). It is BOTH the durable send queue (status
-- 'queued' → 'sending' → 'sent') and the delivery record updated by the Resend
-- webhook (delivered / bounced / complained). Lives in DB2 next to `contacts` so a
-- bounce or complaint can suppress the address in the same database.
--
--   campaign_id  → DB1 email_campaigns.id (no FK: separate database). NULL for
--                  one-off transactional emails (booking confirmations etc.).
--   email        → always stored lowercase (the unique key relies on it).
--   subject / body_html → only for one-off transactional sends; campaign sends
--                  re-render from the campaign row so there is one source of truth.
--   idempotency_key → transactional sends: a retry with the same key is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid,
  client_id       text NOT NULL DEFAULT 'csr_rea',
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  email           text NOT NULL,
  category        text NOT NULL DEFAULT 'marketing' CHECK (category IN ('marketing', 'transactional')),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped')),
  subject         text,
  body_html       text,
  reference       text,                       -- e.g. booking pk for transactional sends
  provider_id     text,                       -- Resend email id (webhook events match on this)
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  idempotency_key text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  bounced_at      timestamptz,
  bounce_type     text,                       -- Permanent | Transient | Undetermined
  complained_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_sends_campaign_email_key UNIQUE (campaign_id, email),
  CONSTRAINT email_sends_idempotency_key    UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS email_sends_queue_idx    ON public.email_sends (queued_at) WHERE status IN ('queued', 'sending');
CREATE INDEX IF NOT EXISTS email_sends_provider_idx ON public.email_sends (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_sends_campaign_idx ON public.email_sends (campaign_id);
CREATE INDEX IF NOT EXISTS email_sends_email_idx    ON public.email_sends (email);

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;   -- service role bypasses; no public policies

-- ── Gmail transport (added 2026-09-20; APPLIED) ──────────────────────────────
-- Delivery channel per row. 'resend' rows are sent by the server (Resend worker); 'gmail' rows are handed to the owner's Apps Script
-- (/email/pull → GmailApp → /email/report) so mail can go out AS info@<their domain> without any DNS access. The Resend worker
-- never touches transport='gmail' rows.
ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'resend' CHECK (transport IN ('resend', 'gmail'));
CREATE INDEX IF NOT EXISTS email_sends_gmail_queue_idx
  ON public.email_sends (queued_at) WHERE transport = 'gmail' AND status IN ('queued', 'sending');

