-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB2 CRM — Email Marketing Consent
-- Run in Supabase Project 2 (CRM) → SQL Editor
--
-- CAN-SPAM requires a working one-click unsubscribe regardless of prior
-- consent history. Existing `contacts.email` rows are treated as already
-- consented (email_marketing_consent defaults true) per 2026-07-08 decision —
-- this migration only adds the columns needed to HONOR an unsubscribe from
-- here forward, it does not itself send any consent-request email.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_marketing_consent boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_unsubscribed_at    timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS email_unsubscribe_token   uuid DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unsubscribe_token_idx
  ON contacts (email_unsubscribe_token);

CREATE INDEX IF NOT EXISTS contacts_email_marketing_consent_idx
  ON contacts (email_marketing_consent)
  WHERE email IS NOT NULL;
