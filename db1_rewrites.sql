-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 8 — AI Message Rewrite Engine
--
-- Creates message_rewrites table + adds rewrite_auto_apply to bot_config.
-- Run in Supabase DB1 SQL editor.
-- Safe to run multiple times (IF NOT EXISTS / DO blocks throughout).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── message_rewrites ──────────────────────────────────────────────────────────
-- One row per AI-generated rewrite suggestion. Tracks full version history.
CREATE TABLE IF NOT EXISTS message_rewrites (
  id                  uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id           text    NOT NULL,

  -- Source conversation (optional — may have been deleted)
  conversation_id     uuid,

  -- The original (weak) bot message that was sampled
  original_message    text    NOT NULL,
  context_summary     text,             -- what the user said before the bot replied

  -- Phase 7 insight that triggered this rewrite
  insight_type        text,             -- e.g. 'booking_gap' | 'early_dropoff' | 'pricing_no_action'

  -- The improved version
  rewritten_message   text,
  rewrite_reason      text,             -- why this is better (shown in portal)
  rewrite_pattern     text,             -- 'add_cta' | 'increase_specificity' | 'reduce_friction' | 'add_urgency' | 'shorten'

  -- Lifecycle
  status              text    NOT NULL DEFAULT 'pending',
  -- 'pending'      → awaiting review in portal
  -- 'accepted'     → user approved; injected into system prompt at runtime
  -- 'auto_applied' → auto-apply mode accepted without user review
  -- 'rejected'     → user dismissed; not injected

  -- Safe to auto-apply without human review (conservative patterns only)
  auto_apply_eligible boolean NOT NULL DEFAULT false,

  -- Versioning — full edit history stored as JSONB array
  version             integer NOT NULL DEFAULT 1,
  version_history     jsonb   NOT NULL DEFAULT '[]',
  -- Each entry: { version, message, source: 'ai'|'manual', created_at }

  -- Provenance
  generated_by        text    NOT NULL DEFAULT 'ai',

  -- Audit
  created_at          timestamptz DEFAULT now(),
  reviewed_at         timestamptz,
  reviewed_by         text          -- portal user email who accepted/rejected
);

-- Status constraint
DO $$ BEGIN
  ALTER TABLE message_rewrites ADD CONSTRAINT mr_status_check
    CHECK (status IN ('pending','accepted','auto_applied','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Pattern constraint
DO $$ BEGIN
  ALTER TABLE message_rewrites ADD CONSTRAINT mr_pattern_check
    CHECK (rewrite_pattern IN ('add_cta','increase_specificity','reduce_friction','add_urgency','shorten') OR rewrite_pattern IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS mr_client_status_idx ON message_rewrites (client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS mr_client_id_idx     ON message_rewrites (client_id, id);

-- ── bot_config: add rewrite_auto_apply column ─────────────────────────────────
-- When true, auto_apply_eligible rewrites are applied without manual approval.
DO $$ BEGIN
  ALTER TABLE bot_config ADD COLUMN rewrite_auto_apply boolean NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
         WHEN undefined_table  THEN NULL; END $$;

-- Enable RLS (server uses service role key which bypasses RLS automatically)
ALTER TABLE public.message_rewrites ENABLE ROW LEVEL SECURITY;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name IN ('message_rewrites')
 ORDER BY ordinal_position;
