-- ─────────────────────────────────────────────────────────────────────────────
-- db1_dashboard_layout.sql — Operator Intelligence 2.0 Phase 2: Mission Control
-- Run once in Supabase DB1 SQL editor.
--
-- Per-user customizable dashboard. Stores the chosen role preset + ordered
-- widget list so each portal user's Mission Control persists across sessions.
--   { "role_preset": "operations_manager", "widgets": ["priorities","today","fleet",...] }
--
-- Additive + non-breaking: NULL = use the role-preset default (computed in code).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.portal_users
  ADD COLUMN IF NOT EXISTS dashboard_layout JSONB;

COMMENT ON COLUMN public.portal_users.dashboard_layout IS
  'Per-user Mission Control layout: { role_preset, widgets:[ordered ids] }. NULL = role-preset default.';

-- Verify:
-- SELECT email, role, dashboard_layout FROM public.portal_users;
