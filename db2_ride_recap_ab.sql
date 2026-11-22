-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Ride Recap A/B experiments (rideRecap.js RECAP_EXPERIMENTS). NOT YET APPLIED — for Sean's review.
-- Additive + idempotent. Until applied, recaps still send (all experiments on "auto", variants just aren't logged,
-- so no winner can be picked).
--
--   recap_settings.experiments  per-experiment mode: "auto" (default — 50/50, then shift toward the winner) | "A" | "B" | "off"
--                               e.g. {"subject":"auto","layout":"B","share_cta":"off"}. Missing key = "auto".
--   recap_log.variants          which version each email got, e.g. {"subject":"B","layout":"A","share_cta":"A"}
--                               (stats use real sends only: dry_run = false).
-- Report: GET /api/v1/recaps/experiments (Bearer OUTBOUND_API_KEY).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recap_settings ADD COLUMN IF NOT EXISTS experiments jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recap_log      ADD COLUMN IF NOT EXISTS variants    jsonb;
CREATE INDEX IF NOT EXISTS recap_log_real_sends_idx ON public.recap_log (client_id, queued_at) WHERE dry_run = false;
