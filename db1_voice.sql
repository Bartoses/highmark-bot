-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Voice AI (Phase 1): infrastructure + call logging
-- Run once in Supabase Project 1 → SQL Editor
--
-- Adds the foundation for Highmark Voice AI as a first-class, multi-tenant module
-- alongside the existing SMS concierge:
--   voice_numbers — Twilio voice numbers mapped to a client + forwarding target
--   voice_agents  — per-client voice agent config (greeting, hours, transfer rules)
--   voice_calls   — every inbound/outbound call: transcript, recording, outcome
--
-- Phase 1 is non-breaking and additive. The SMS stack is untouched; if these
-- tables are absent the voice routes degrade gracefully (answer + voicemail).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── voice_numbers ─────────────────────────────────────────────────────────────
-- One row per Twilio voice number. Maps an inbound called number to a client and
-- (optionally) a human forwarding target for live transfer.
CREATE TABLE IF NOT EXISTS voice_numbers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text        NOT NULL,
  twilio_number      text        NOT NULL UNIQUE,    -- E.164, the "To" on inbound calls
  forwarding_number  text        DEFAULT NULL,       -- E.164 owner/staff line for live transfer
  status             text        NOT NULL DEFAULT 'active', -- active | paused | pending
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_numbers_client_idx ON voice_numbers (client_id);

-- ── voice_agents ──────────────────────────────────────────────────────────────
-- Per-client voice agent configuration. One enabled agent per client is used at
-- call time; extra rows allow industry templates / drafts.
CREATE TABLE IF NOT EXISTS voice_agents (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text        NOT NULL,
  name               text        NOT NULL DEFAULT 'Receptionist',
  industry           text        DEFAULT NULL,       -- snowmobile | hvac | plumbing | dental | ...
  welcome_prompt     text        DEFAULT NULL,       -- spoken greeting (overrides default)
  system_prompt      text        DEFAULT NULL,       -- AI instruction (Phase 2 realtime agent)
  transfer_threshold numeric(4,2) DEFAULT 0.70,      -- lead score above which we offer transfer
  forwarding_number  text        DEFAULT NULL,       -- E.164 fallback transfer target
  business_hours     jsonb       NOT NULL DEFAULT '{}'::jsonb, -- { timezone, hours: { "1": {open,close} } }
  spam_aggressiveness text       NOT NULL DEFAULT 'medium',    -- low | medium | high
  ai_enabled         boolean     NOT NULL DEFAULT false,       -- Phase 2: engage the conversational AI receptionist (false = Phase 1 forward/voicemail)
  enabled            boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_agents_client_idx ON voice_agents (client_id, enabled);

-- ── voice_calls ───────────────────────────────────────────────────────────────
-- Every call. call_sid is the Twilio idempotency key (UNIQUE) so webhook retries
-- and the status/recording callbacks all update the same row.
CREATE TABLE IF NOT EXISTS voice_calls (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      text        NOT NULL,
  call_sid       text        NOT NULL UNIQUE,
  caller_number  text        DEFAULT NULL,           -- "From"
  to_number      text        DEFAULT NULL,           -- "To"
  direction      text        NOT NULL DEFAULT 'inbound', -- inbound | outbound
  status         text        DEFAULT 'in_progress',  -- ringing | in_progress | completed | failed | no_answer
  duration       integer     DEFAULT NULL,           -- seconds
  spam_score     numeric(4,2) DEFAULT NULL,          -- 0..1 (Phase 4)
  lead_score     numeric(4,2) DEFAULT NULL,          -- 0..1 (Phase 3)
  transcript     text        DEFAULT NULL,           -- Phase 2
  summary        text        DEFAULT NULL,           -- Phase 2
  recording_url  text        DEFAULT NULL,
  outcome        text        DEFAULT NULL,           -- spam|lead|customer|booking|support|voicemail|transferred|completed
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz DEFAULT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_calls_client_idx     ON voice_calls (client_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_outcome_idx    ON voice_calls (client_id, outcome);
CREATE INDEX IF NOT EXISTS voice_calls_caller_idx     ON voice_calls (caller_number);

COMMENT ON TABLE voice_calls IS
  'Highmark Voice AI Phase 1: call log. call_sid is the Twilio idempotency key; status + recording callbacks update the same row.';
