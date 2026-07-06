-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Portal invite auto-delivery (Chunk 11 follow-up)
-- Run in Supabase Project 1 → SQL Editor
--
-- Invites used to only produce a raw link the admin had to copy/paste and
-- send out-of-band. Invite creation now attempts real delivery: email via
-- Resend (RESEND_API_KEY), falling back to SMS via the existing Twilio
-- account when a phone number is provided and email isn't configured/fails.
--
-- phone            — optional, only used for the SMS-fallback delivery channel
-- delivery_method  — 'email' | 'sms' | null (manual — copy/paste link)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE portal_invites ADD COLUMN IF NOT EXISTS phone           text DEFAULT NULL;
ALTER TABLE portal_invites ADD COLUMN IF NOT EXISTS delivery_method text DEFAULT NULL;
