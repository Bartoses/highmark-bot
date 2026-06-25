-- ─────────────────────────────────────────────────────────────────────────────
-- db1_operator_briefing_detail.sql — per-operator briefing altitude
-- Run once in Supabase DB1 SQL editor.
--
-- Controls how much detail a phone's briefing carries:
--   'detailed' — full per-booking lines (name/phone/time), full work-order list
--                with links + waiver chase names. For on-site staff who ACT.
--   'summary'  — high-level rollups (totals, fleet status line, headline issues).
--                For owners who want the pulse, not the play-by-play.
--   'auto'     — (default) detailed when scoped to a specific post (1–3
--                locations), summary for owner / all-locations / unscoped.
--
-- Additive + non-breaking: existing rows default to 'auto' (= today's behavior
-- for scoped staff; tighter for owners).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.operator_phones
  ADD COLUMN IF NOT EXISTS briefing_detail TEXT NOT NULL DEFAULT 'auto'
    CHECK (briefing_detail IN ('auto','summary','detailed'));

COMMENT ON COLUMN public.operator_phones.briefing_detail IS
  'Briefing altitude: auto (default; detailed if scoped to 1-3 locations, else summary) | summary (owner rollups) | detailed (staff per-booking + full work orders).';

-- Verify:
-- SELECT client_id, phone, role, locations, briefing_detail FROM public.operator_phones ORDER BY client_id;
