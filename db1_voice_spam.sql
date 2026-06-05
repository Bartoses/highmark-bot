-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Voice AI Phase 4: shared spam network
-- Run once in Supabase Project 1 → SQL Editor
--
-- Cross-client blocklist. A number flagged as a solicitor / robocaller on ANY
-- client's call is remembered here, so EVERY client benefits: on the next call
-- from that number we hard-block it pre-answer (<Reject/>) — it never reaches the
-- AI or the human transfer line. Additive + non-breaking.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spam_numbers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  text        NOT NULL UNIQUE,        -- E.164 caller number
  score         numeric(4,2) NOT NULL DEFAULT 0.5,  -- 0..1 confidence it's spam
  reports       integer     NOT NULL DEFAULT 1,     -- times flagged across the network
  reason        text        DEFAULT NULL,           -- last category / phrase
  blocked       boolean     NOT NULL DEFAULT false, -- hard pre-answer block
  sources       jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{client_id, call_sid, at}]
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spam_numbers_blocked_idx ON spam_numbers (blocked, last_seen DESC);

ALTER TABLE spam_numbers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE spam_numbers IS
  'Voice AI Phase 4: shared cross-client spam blocklist. Numbers flagged spam on any call are pre-answer-blocked for everyone.';
