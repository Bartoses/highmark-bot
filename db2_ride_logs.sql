-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Guide Ride Log, slice 1 (guideApp.js, docs/sprints/sprint-guide-app.md). NOT YET APPLIED — for Sean's review.
-- Additive. Until applied, /guide shows today's departures but can't save claims, logs or photos.
--
--   ride_assignments  who led which FareHarbor departure (claim in the app; later the manager board / FareHarbor field)
--   ride_logs         the guide's details per departure: miles, high point, stops, highlight (shown in the recap),
--                     group note + conditions (internal). booking_pks = only those riders when a departure is split.
--   staff             the app's staff list: name, role, home location, phone, Google email
--   recap_tours       + route jsonb (stops with elevations, duration, description) set in the app's Tours screen
--   ride_media        + hosted-photo columns: photos uploaded in the app live in Supabase Storage (recap-photos), so
--                     drive_file_id becomes optional (Drive copy comes later via the service account).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ride_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL DEFAULT 'csr_rea',
  availability_pk text NOT NULL,                    -- FareHarbor departure id
  ride_date       date,
  operator_phone  text NOT NULL,                    -- DB1 operator_phones.phone (E.164)
  guide_name      text,
  booking_pks     text[] NOT NULL DEFAULT '{}',     -- empty = the whole departure
  source          text NOT NULL DEFAULT 'claim' CHECK (source IN ('claim', 'manager', 'fareharbor')),
  assigned_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ride_assignments_dep_phone_key UNIQUE (availability_pk, operator_phone)
);
CREATE INDEX IF NOT EXISTS ride_assignments_date_idx ON public.ride_assignments (client_id, ride_date);

CREATE TABLE IF NOT EXISTS public.ride_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL DEFAULT 'csr_rea',
  ride_date       date,
  availability_pk text NOT NULL,
  guide_phone     text NOT NULL,
  guide_name      text,
  booking_pks     text[] NOT NULL DEFAULT '{}',
  miles           numeric,
  high_point_ft   integer,
  stops           text[] NOT NULL DEFAULT '{}',
  highlight       text,                             -- shown in the guest's recap
  group_note      text,                             -- internal only, never shown to guests
  conditions      text[] NOT NULL DEFAULT '{}',     -- fresh_snow | bluebird | snowing | windy | cold
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ride_logs_dep_guide_key UNIQUE (availability_pk, guide_phone)
);
CREATE INDEX IF NOT EXISTS ride_logs_date_idx ON public.ride_logs (client_id, ride_date);

ALTER TABLE public.ride_media ALTER COLUMN drive_file_id DROP NOT NULL;
ALTER TABLE public.ride_media
  ADD COLUMN IF NOT EXISTS public_url       text,         -- full 1200px JPEG (download / photos page)
  ADD COLUMN IF NOT EXISTS hero_url         text,         -- 1200x900 crop (email hero)
  ADD COLUMN IF NOT EXISTS thumb_urls       text[],       -- three 400x300 crops (REA: the 3rd is the loop map)
  ADD COLUMN IF NOT EXISTS uploaded_by      text,         -- operator phone
  ADD COLUMN IF NOT EXISTS client_upload_id text,         -- the phone's id for a photo → retries never duplicate
  ADD COLUMN IF NOT EXISTS hidden           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS ride_media_client_upload_key ON public.ride_media (availability_pk, client_upload_id) WHERE client_upload_id IS NOT NULL;

-- Tour routes set by managers in the app (Tours screen): stops with elevations, duration, description.
-- recap_tours.stops (names) stays the list the recap uses; route holds the richer version.
ALTER TABLE public.recap_tours ADD COLUMN IF NOT EXISTS route jsonb;

-- Staff list (Settings → Staff in the app; later synced with the Google Sheet). Phone = briefing link + assignments.
CREATE TABLE IF NOT EXISTS public.staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text NOT NULL DEFAULT 'csr_rea',
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('guide', 'shop', 'driver', 'mechanic', 'manager')),
  home_location text CHECK (home_location IN ('steamboat', 'north_routt', 'kremmling', 'rabbit_ears')),
  phone         text,                              -- E.164
  google_email  text,                              -- for Google sign-in later
  active        boolean NOT NULL DEFAULT true,
  source        text NOT NULL DEFAULT 'app',       -- app | sheet
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_phone_key ON public.staff (client_id, phone) WHERE phone IS NOT NULL;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ride_assignments ENABLE ROW LEVEL SECURITY;   -- service role only
ALTER TABLE public.ride_logs        ENABLE ROW LEVEL SECURITY;
