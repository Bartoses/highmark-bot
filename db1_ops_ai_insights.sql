-- ─────────────────────────────────────────────────────────────────────────────
-- Operations Dashboard — AI Insights cache
-- Run in: Supabase DB1 SQL Editor (project ref: qygcmdyxvjlzbmpdpesc)
--
-- Caches Claude-generated narrative observations on each client's recent
-- booking data. Lazy-refresh: the GET handler regenerates only when the
-- newest row is >24h old, so day-over-day cost is bounded to one Haiku call
-- per client per day. POST .../ai-insights/refresh forces regeneration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ops_ai_insights (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  insights     JSONB NOT NULL,                    -- { bullets: [...], headline: "...", model, prompt_window }
  prompt_hash  TEXT                               -- so we can dedupe identical context
);

CREATE INDEX IF NOT EXISTS idx_ops_ai_insights_client_id_generated_at
  ON public.ops_ai_insights (client_id, generated_at DESC);
