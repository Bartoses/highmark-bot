-- Add MPWR enrichment columns to bookings (DB2).
-- Run once in the DB2 (CRM) Supabase SQL editor.
--
-- mpwrSync.js previously assigned all MPWR bookings to one of 2 activity_ids
-- (one per outfitter), losing the sub-location (Rabbit Ears, North Routt) and
-- the specific vehicle. These columns let us store the real product + vehicle
-- per booking so the operator briefing and CRM segments stay accurate.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS location      text,  -- kremmling | steamboat | rabbit_ears | north_routt | …
  ADD COLUMN IF NOT EXISTS product_title text,  -- full MPWR productTitle, e.g. "Rabbit Ears UTV Rentals | Ride From Trailhead (Remote Backcountry)"
  ADD COLUMN IF NOT EXISTS vehicle       text;  -- asset family name from reservation.vehicles[], e.g. "RZR PRO S4", "Ranger XP General"

CREATE INDEX IF NOT EXISTS bookings_location_idx ON public.bookings (location);
