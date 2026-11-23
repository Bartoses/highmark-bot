-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Guide app ops (docs/sprints/sprint-guide-app.md). NOT YET APPLIED — for Sean's review.
-- Additive. Three tables, all keyed by the FareHarbor booking (fareharbor_pk, e.g. '#123456789').
--
--   shuttle_runs        van runs (Sean, 2026-11-23): shuttle bookings grouped into runs, one driver per run, 25-seat vans.
--                       kind: to_trail (lodging → trailhead), from_trail, between_locations, evening_pickup (rental sleds the
--                       night before). A run can serve several departures the same morning, so it's keyed by date.
--   booking_equipment   which sled / trailer (or other unit) goes with a booking. Today this lives in the shop's Google Sheet
--                       ("Weekly Shop Manifest"); plan = sync both ways, then the app replaces the sheet. source says where
--                       the row came from so a sync never overwrites an edit made in the app.
--   booking_staff_notes notes staff add to a booking in the app (internal, never sent to guests). Shown to whoever sees the
--                       booking's full manifest (its guide, shop for rentals, managers).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shuttle_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        text NOT NULL DEFAULT 'csr_rea',
  run_date         date NOT NULL,
  kind             text NOT NULL DEFAULT 'to_trail' CHECK (kind IN ('to_trail', 'from_trail', 'between_locations', 'evening_pickup')),
  depart_at        timestamptz,                         -- when the van leaves
  vehicle          text,                                -- e.g. "Van 1"
  seats            integer NOT NULL DEFAULT 25 CHECK (seats > 0),
  driver_phone     text,                                -- staff phone (E.164); null = no driver yet
  driver_name      text,
  booking_pks      text[] NOT NULL DEFAULT '{}',        -- FareHarbor bookings on this run
  availability_pks text[] NOT NULL DEFAULT '{}',        -- the departures it serves
  stops            jsonb NOT NULL DEFAULT '[]',         -- ordered [{ booking_pk, address, time }]
  from_location    text,                                -- steamboat | north_routt | kremmling | rabbit_ears (between_locations)
  to_location      text,
  notes            text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shuttle_runs_date_idx ON public.shuttle_runs (client_id, run_date);

CREATE TABLE IF NOT EXISTS public.booking_equipment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text NOT NULL DEFAULT 'csr_rea',
  booking_pk    text NOT NULL,                         -- FareHarbor booking
  ride_date     date,
  kind          text NOT NULL DEFAULT 'sled' CHECK (kind IN ('sled', 'trailer', 'other')),
  unit          text NOT NULL,                         -- the sled / trailer as the shop names it (e.g. "K-12", "4-place #2")
  note          text,
  source        text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'sheet')),
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_equipment_unit_key UNIQUE (booking_pk, kind, unit)
);
CREATE INDEX IF NOT EXISTS booking_equipment_date_idx ON public.booking_equipment (client_id, ride_date);

CREATE TABLE IF NOT EXISTS public.booking_staff_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text NOT NULL DEFAULT 'csr_rea',
  booking_pk    text NOT NULL,
  ride_date     date,
  note          text NOT NULL CHECK (char_length(note) <= 500),
  author_phone  text,
  author_name   text,
  hidden        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_staff_notes_pk_idx ON public.booking_staff_notes (booking_pk);

ALTER TABLE public.shuttle_runs        ENABLE ROW LEVEL SECURITY;   -- service role only
ALTER TABLE public.booking_equipment   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_staff_notes ENABLE ROW LEVEL SECURITY;
-- Drivers: staff.role already allows 'driver'.
