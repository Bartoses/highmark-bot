-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 7 — AI Optimization Engine
--
-- Creates optimization_insights + optimization_scores tables.
-- Run in Supabase DB1 SQL editor.
-- Safe to run multiple times (IF NOT EXISTS guards throughout).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── optimization_insights ─────────────────────────────────────────────────────
-- Stores generated insights per client. Re-generated on each analysis run.
CREATE TABLE IF NOT EXISTS optimization_insights (
  id             uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id      text    NOT NULL,

  -- Classification
  insight_type   text    NOT NULL,  -- 'missed_lead' | 'booking_gap' | 'early_dropoff' | 'frustrated' | 'no_booking_config' | 'no_api_integration' | 'handoff_heavy' | 'pricing_no_action'
  severity       text    NOT NULL,  -- 'high' | 'medium' | 'low'
  category       text    NOT NULL,  -- 'lead_capture' | 'booking' | 'messaging' | 'integration' | 'config'

  -- Human-readable content
  title          text    NOT NULL,
  description    text    NOT NULL,
  suggestion     text    NOT NULL,

  -- Optional action link (portal section name, e.g. 'integrations', 'booking-config')
  action_section text,
  action_label   text,

  -- Supporting metric
  metric_value   numeric,
  metric_label   text,  -- e.g. "72% drop-off rate across 43 conversations"

  generated_at   timestamptz DEFAULT now(),
  dismissed      boolean     DEFAULT false
);

-- Check constraint on severity
DO $$ BEGIN
  ALTER TABLE optimization_insights ADD CONSTRAINT oi_severity_check
    CHECK (severity IN ('high','medium','low'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── optimization_scores ───────────────────────────────────────────────────────
-- Latest conversion health score per client (one row per client, upserted).
CREATE TABLE IF NOT EXISTS optimization_scores (
  client_id                 text    PRIMARY KEY,
  score                     integer NOT NULL,  -- 0–100
  conversations_analyzed    integer NOT NULL DEFAULT 0,
  leads_captured            integer NOT NULL DEFAULT 0,
  lead_capture_rate         numeric,           -- leads / total conversations
  dropoff_rate              numeric,           -- abandoned conversations / total
  booking_intent_rate       numeric,           -- convos with booking intent / total
  frustrated_rate           numeric,           -- convos with frustrated sentiment / total
  analyzed_at               timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS oi_client_id_idx     ON optimization_insights (client_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS oi_client_type_idx   ON optimization_insights (client_id, insight_type);

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name IN ('optimization_insights','optimization_scores')
 ORDER BY table_name, ordinal_position;
