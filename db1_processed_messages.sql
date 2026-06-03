-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Inbound message idempotency (P0-4)
-- Run in Supabase Project 1 → SQL Editor
--
-- One row per inbound Twilio MessageSid. claimInboundMessage() inserts here BEFORE
-- processing; the PRIMARY KEY makes the insert an atomic claim, so a Twilio webhook
-- retry (timeout / network) for the same MessageSid is detected and dropped instead
-- of producing a duplicate Claude call + duplicate reply.
--
-- Retention: the cron worker deletes rows older than 3 days (idempotency only needs
-- to outlive Twilio's retry window, which is minutes).
-- Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processed_messages (
  message_sid  text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_messages_processed_at_idx
  ON processed_messages (processed_at);
