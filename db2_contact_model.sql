-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 (CSR/REA CRM) — clean contact model for email + SMS outreach
-- Run once in the DB2 Supabase SQL editor. Additive + idempotent (safe to re-run).
--
-- WHY
--   * Waiver signers (Smartwaiver export) have an email but NO phone, and
--     contacts.phone was NOT NULL + UNIQUE → email-only people couldn't be stored.
--   * We need PROOF of consent: where did each opt-in come from, and when?
--   * The upcoming send pipeline needs somewhere to record bounces/complaints so we
--     never mail a dead or complaining address again.
--   * Waivers are per-rider records (one person can sign many); they belong in
--     their own table, not squeezed into contacts.
--
-- WHAT
--   1. contacts.phone becomes nullable (email-only contacts)
--   2. consent provenance + email verification + suppression columns
--   3. guard rails (CHECKs + unique key for email-only rows)
--   4. waivers table (+ RLS)
--   5. honest provenance backfill for existing consent
--
-- ROLLBACK (if ever needed): drop the CHECKs/indexes/columns/table added below and
-- `ALTER TABLE contacts ALTER COLUMN phone SET NOT NULL` (only valid while no
-- email-only rows exist — delete those first).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) email-only contacts ------------------------------------------------------
ALTER TABLE public.contacts ALTER COLUMN phone DROP NOT NULL;

-- 2) consent provenance / verification / suppression --------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS email_consent_source    text,         -- fareharbor_flag | smartwaiver | grandfathered | web_signup | …
  ADD COLUMN IF NOT EXISTS email_consent_at        timestamptz,
  ADD COLUMN IF NOT EXISTS email_verified_at       timestamptz,  -- NULL = address never confirmed by its owner
  ADD COLUMN IF NOT EXISTS email_suppressed_at     timestamptz,  -- hard bounce / spam complaint → never email again
  ADD COLUMN IF NOT EXISTS email_suppressed_reason text,         -- bounce | complaint | manual
  ADD COLUMN IF NOT EXISTS sms_consent_source      text,         -- fareharbor_flag | keyword_yes | assumed_on_booking | …
  ADD COLUMN IF NOT EXISTS sms_consent_at          timestamptz;

-- 3) guard rails --------------------------------------------------------------
DO $$
BEGIN
  -- every contact must be reachable by at least one channel
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_reachable_chk') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_reachable_chk CHECK (phone IS NOT NULL OR email IS NOT NULL);
  END IF;
  -- an SMS opt-in is meaningless (and dangerous) without a phone number.
  -- opted_in DEFAULTs to TRUE, so a careless insert of a phone-less contact now
  -- FAILS LOUDLY instead of silently becoming "opted in".
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_sms_needs_phone_chk') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_sms_needs_phone_chk CHECK (opted_in IS NOT TRUE OR phone IS NOT NULL);
  END IF;
END $$;

-- one row per address for email-only contacts (phone contacts may share an email —
-- e.g. a family — so this is deliberately partial)
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_only_key
  ON public.contacts (lower(email)) WHERE phone IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_email_lower_idx
  ON public.contacts (lower(email)) WHERE email IS NOT NULL;

-- 4) waivers ------------------------------------------------------------------
-- Deliberately NO date of birth / driver's-licence columns: sensitive, and not
-- needed to market to or recognise a guest.
CREATE TABLE IF NOT EXISTS public.waivers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL DEFAULT 'smartwaiver',
  waiver_id        text NOT NULL,                 -- provider's own id → idempotent re-imports
  client_id        text NOT NULL DEFAULT 'csr_rea',
  first_name       text,
  last_name        text,
  email            text,
  signed_at        timestamptz,
  status           text NOT NULL DEFAULT 'completed',   -- completed | pending_email_verification
  document_title   text,
  marketing_opt_in boolean NOT NULL DEFAULT false,      -- "Marketing Emails Allowed" on the form
  contact_id       uuid REFERENCES public.contacts(id)  ON DELETE SET NULL,
  customer_id      uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, waiver_id)
);
CREATE INDEX IF NOT EXISTS waivers_email_lower_idx ON public.waivers (lower(email));
CREATE INDEX IF NOT EXISTS waivers_contact_idx     ON public.waivers (contact_id);
CREATE INDEX IF NOT EXISTS waivers_signed_at_idx   ON public.waivers (signed_at);
ALTER TABLE public.waivers ENABLE ROW LEVEL SECURITY;   -- service role bypasses; no public policies

-- 5) honest provenance backfill ----------------------------------------------
-- Labels say what we actually know. "assumed_*" / "grandfathered" mean the opt-in
-- was set by a default or convention, NOT by an explicit choice from the guest —
-- that is exactly what an audit needs to be able to see.
UPDATE public.contacts SET
  email_consent_source = CASE
    WHEN source = 'fareharbor_booking' AND created_at >= '2026-09-20 00:00:00-06' THEN 'fareharbor_flag'
    ELSE 'grandfathered' END,
  email_consent_at = COALESCE(email_consent_at, created_at)
WHERE email_marketing_consent IS TRUE AND email_consent_source IS NULL;

UPDATE public.contacts SET
  sms_consent_source = CASE
    WHEN source = 'fareharbor_booking' AND created_at >= '2026-09-20 00:00:00-06' THEN 'fareharbor_flag'
    WHEN source = 'sms_conversation' THEN 'assumed_on_inbound_sms'
    WHEN source = 'operator_import'  THEN 'operator_import'
    ELSE 'assumed_on_booking' END,
  sms_consent_at = COALESCE(sms_consent_at, created_at)
WHERE opted_in IS TRUE AND sms_consent_source IS NULL;

COMMIT;
