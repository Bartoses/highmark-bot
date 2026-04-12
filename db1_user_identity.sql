-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — User Identity (Cross-Channel Continuity)
-- Phase 11.8: links web session IDs to phone numbers for web↔SMS context sharing.
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_identity (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id   text        NOT NULL,
  phone       text        NOT NULL,               -- normalized E.164 (e.g. +15551234567)
  session_ids text[]      DEFAULT '{}',           -- web session IDs linked to this phone
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (client_id, phone)
);

CREATE INDEX IF NOT EXISTS user_identity_phone_idx   ON user_identity (client_id, phone);
CREATE INDEX IF NOT EXISTS user_identity_client_idx  ON user_identity (client_id);
CREATE INDEX IF NOT EXISTS user_identity_updated_idx ON user_identity (updated_at DESC);

COMMENT ON TABLE user_identity IS
  'Phase 11.8: Cross-channel continuity. Links web session IDs to phone numbers so conversations flow seamlessly between the website widget and SMS.';
