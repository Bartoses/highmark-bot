-- Migration: per-client Twilio configuration (Chunk 15)
-- Run in Supabase DB1 SQL editor
--
-- Adds 4 columns to the clients table so each client's Twilio routing
-- details can be stored in DB and edited in the portal:
--
--   outbound_phone        — the "From" number used for all outgoing SMS
--                           (replies, confirmations, follow-ups, campaigns)
--                           Falls back to TWILIO_PHONE_NUMBER env var if null.
--
--   messaging_service_sid — optional Twilio Messaging Service SID
--                           When set, used instead of outbound_phone for outbound
--                           sends (better deliverability for campaigns / toll-free).
--                           Format: MG...
--
--   twilio_account_sid    — optional Twilio sub-account SID (for clients with
--                           their own Twilio account / Connect setup).
--                           Format: AC...
--
--   twilio_auth_token     — optional Twilio sub-account auth token.
--                           WARNING: stored in plaintext. Use with care.
--                           Required only when twilio_account_sid is set.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS outbound_phone        TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS messaging_service_sid TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_account_sid    TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_auth_token     TEXT;
