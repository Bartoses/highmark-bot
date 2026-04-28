-- ─────────────────────────────────────────────────────────────────────────────
-- SMS CONSENT — Progressive opt-in tracking on conversations
--
-- Run once in Supabase DB1 SQL editor.
--
-- These columns track per-conversation SMS opt-in state for the web chat
-- progressive consent flow. They are ALSO valid for SMS conversations (a
-- conversation always has a from/to row); SMS-channel rows are treated as
-- already opted-in once the user sends a first message, since Twilio's
-- 30510 compliance framework treats inbound SMS as implicit consent.
--
-- Web chat: sms_opted_in starts false; flipped true only after explicit
-- consent reply ("yes" to the consent prompt). Phone collection is gated
-- behind sms_opted_in === true.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sms_opted_in           boolean     DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sms_opted_in_at        timestamptz DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sms_consent_requested  boolean     DEFAULT false;
