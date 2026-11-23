-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Guide app: shuttle settings per location (Settings → Shuttles). NOT YET APPLIED — for Sean's review.
-- Additive. One row per client + location. Sean (2026-11-23):
--   • vans never mix locations: one run per location + ride start time
--   • pickup time = a fixed pickup time where set (the latest one that still leaves lead_minutes before the ride),
--     otherwise lead_minutes before the ride
--   • pickup spot = the guest's lodging when the booking has one, otherwise the location's meeting spot
--   • return van leaves when the ride ends (+ return_after_minutes)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shuttle_settings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            text NOT NULL DEFAULT 'csr_rea',
  location             text NOT NULL CHECK (location IN ('steamboat', 'north_routt', 'kremmling', 'rabbit_ears')),
  lead_minutes         integer CHECK (lead_minutes IS NULL OR (lead_minutes >= 0 AND lead_minutes <= 300)),   -- pick up this long before the ride
  pickup_times         text[] NOT NULL DEFAULT '{}',          -- fixed pickups, 'HH:MM' local, e.g. {06:45,11:15}
  start_point          text,                                  -- where the van leaves from (e.g. "Steamboat shop, 2151 Downhill Dr")
  meeting_spots        text[] NOT NULL DEFAULT '{}',          -- set pickup spots for guests without a lodging address
  return_after_minutes integer NOT NULL DEFAULT 0 CHECK (return_after_minutes >= 0 AND return_after_minutes <= 240),
  seats                integer NOT NULL DEFAULT 25 CHECK (seats > 0 AND seats <= 60),
  active               boolean NOT NULL DEFAULT true,
  updated_by           text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shuttle_settings_loc_key UNIQUE (client_id, location)
);
ALTER TABLE public.shuttle_settings ENABLE ROW LEVEL SECURITY;   -- service role only

-- The run remembers which location it serves (vans never mix locations).
ALTER TABLE public.shuttle_runs ADD COLUMN IF NOT EXISTS location text;
