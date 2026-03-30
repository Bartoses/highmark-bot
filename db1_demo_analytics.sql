-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Demo Analytics Events
-- Run this in Supabase Project 1 → SQL Editor
--
-- Lightweight event log for the Highmark demo funnel.
-- Each row is one tracked event in the demo state machine.
-- Designed for simple funnel analysis: starts → paths → CTA → leads.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS demo_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name   text        NOT NULL,
  client_id    text        NOT NULL DEFAULT 'highmark_demo',
  from_number  text,
  demo_path    int,        -- 1=Q&A, 2=Lead Capture, 3=Booking (null if not applicable)
  step_key     text,       -- state machine step name
  vertical     text,       -- outdoor, appointments, home_services, restaurant, fitness, default
  subtype_key  text,       -- bike, snowmobile, raft, fishing, ski, atv, etc.
  source       text        NOT NULL DEFAULT 'sms',  -- 'sms' | 'ui'
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Event names used by demoFlow.js (trackDemoEvent):
--   demo_started              — first contact with demo bot
--   demo_path_selected        — user picks Q&A (1), Lead Capture (2), or Booking (3)
--   demo_cta_shown            — demo_cta state reached (explicit "want to get started?")
--   demo_interest_expressed   — YES intent detected (any state)
--   demo_lead_capture_started — entered lead_name step
--   demo_lead_captured        — lead saved successfully to leads table
--   demo_reset                — START OVER / DEMO / RESTART keyword

CREATE INDEX IF NOT EXISTS demo_events_created_at  ON demo_events (created_at DESC);
CREATE INDEX IF NOT EXISTS demo_events_event_name  ON demo_events (event_name);
CREATE INDEX IF NOT EXISTS demo_events_from_number ON demo_events (from_number);
CREATE INDEX IF NOT EXISTS demo_events_source      ON demo_events (source);
