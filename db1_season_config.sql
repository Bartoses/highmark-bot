-- ─────────────────────────────────────────────────────────────────────────────
-- db1_season_config.sql — per-client season boundaries
-- Run in DB1 (primary Supabase) SQL editor.
--
-- Adds a JSONB column on clients to override the default season ranges used
-- by parseSeasonRange (operator queries) and seasonToDateRange (past_guests
-- campaign filter). Format:
--   {
--     "summer": { "start": "04-01", "end": "10-31" },
--     "winter": { "start": "12-01", "end": "03-31" }
--   }
-- MM-DD strings — year-agnostic. NULL → fall back to global defaults
-- (summer Apr 1 – Oct 31, winter Dec 1 – Mar 31).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS season_config JSONB DEFAULT NULL;

COMMENT ON COLUMN public.clients.season_config IS
  'Per-client season boundaries: { summer: {start,end}, winter: {start,end} } as MM-DD. NULL = use global defaults.';

-- Seed CSR/REA with their current ranges (Kremmling opens April, Steamboat opens late May).
UPDATE public.clients
SET    season_config = jsonb_build_object(
         'summer', jsonb_build_object('start', '04-01', 'end', '10-31'),
         'winter', jsonb_build_object('start', '12-01', 'end', '03-31')
       )
WHERE  id = 'csr_rea' AND season_config IS NULL;
