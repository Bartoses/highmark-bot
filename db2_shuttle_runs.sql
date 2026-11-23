-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Guide app: shuttle van runs (docs/sprints/sprint-guide-app.md). NOT YET APPLIED — for Sean's review.
-- Additive. Sean (2026-11-23): shuttle bookings are grouped into van runs with one driver per run; vans seat 25.
--
--   shuttle_runs  one van trip: which bookings ride (booking_pks), pickup stops in order, the driver, seats.
--                 kind: to_trail (lodging → trailhead), from_trail, between_locations, evening_pickup (rental sleds the
--                 night before). A run may serve several departures the same morning, so it's keyed by date, not departure.
-- Bookings that asked for a shuttle are found from FareHarbor ("Shuttle from lodging to trail…" + the address field);
-- the app suggests runs, a manager adjusts and assigns a driver.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shuttle_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL DEFAULT 'csr_rea',
  run_date        date NOT NULL,
  kind            text NOT NULL DEFAULT 'to_trail' CHECK (kind IN ('to_trail', 'from_trail', 'between_locations', 'evening_pickup')),
  depart_at       timestamptz,                         -- when the van leaves
  vehicle         text,                                -- e.g. "Van 1"
  seats           integer NOT NULL DEFAULT 25 CHECK (seats > 0),
  driver_phone    text,                                -- staff phone (E.164); null = no driver yet
  driver_name     text,
  booking_pks     text[] NOT NULL DEFAULT '{}',        -- FareHarbor bookings on this run
  availability_pks text[] NOT NULL DEFAULT '{}',       -- the departures it serves
  stops           jsonb NOT NULL DEFAULT '[]',         -- ordered [{ booking_pk, address, time }]
  from_location   text,                                -- steamboat | north_routt | kremmling | rabbit_ears (between_locations)
  to_location     text,
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shuttle_runs_date_idx ON public.shuttle_runs (client_id, run_date);
ALTER TABLE public.shuttle_runs ENABLE ROW LEVEL SECURITY;   -- service role only

-- Drivers: staff.role already allows 'driver'.
