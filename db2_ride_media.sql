-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — ride_media: which photo/video belongs to which ride and booking (Guide Ride Log app → Ride Recap)
-- APPLIED to DB2 2026-11-23. Additive; until it exists recaps fall back to Drive file-name matching.
--
-- The Guide app writes ONE ROW PER FILE it uploads to Drive (Tour Photos/<YYYY-MM-DD>/…):
--   availability_pk  FareHarbor departure id = bookings.raw_payload…availability.pk (every FH booking has it). All
--                    guests on that departure share it, so a departure-level photo reaches each of their recaps.
--   booking_pks      the bookings this file is for, e.g. {'#392519085','#392519086'}. Set it when one departure is split
--                    between guides (each guide tags their own riders). Empty = every booking on the departure.
--   drive_file_id    the Drive file; the recap sends it as photo_hint.file_id (exact file, no name guessing).
--   cover            the guide's pick for the email (else the lowest sort_order, then file name).
-- Matching (rideMedia.pickRideMediaForBooking): rows naming this booking → else departure-level rows → else the old
-- strict name match (date folder + tour label + time). A row tagged for OTHER bookings is never used.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ride_media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL DEFAULT 'csr_rea',
  ride_date       date NOT NULL,                       -- local (America/Denver) start date = the Drive day folder
  availability_pk text,                                -- FareHarbor departure id (NULL only for non-FH rides)
  booking_pks     text[] NOT NULL DEFAULT '{}',        -- '#<fareharbor pk>' values; empty = whole departure
  label           text,                                -- recap_tours.label of the ride (also in the file name)
  start_at        timestamptz,
  guide           text,
  kind            text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video')),
  mime_type       text,
  drive_file_id   text NOT NULL,
  file_name       text,
  cover           boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ride_media_file_key UNIQUE (drive_file_id)
);
CREATE INDEX IF NOT EXISTS ride_media_avail_idx   ON public.ride_media (availability_pk);
CREATE INDEX IF NOT EXISTS ride_media_bookings_idx ON public.ride_media USING gin (booking_pks);
CREATE INDEX IF NOT EXISTS ride_media_date_idx    ON public.ride_media (client_id, ride_date);
ALTER TABLE public.ride_media ENABLE ROW LEVEL SECURITY;   -- service role only (same as recap_*)
