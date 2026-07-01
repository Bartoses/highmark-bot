-- db2_booking_source.sql — Booking source + true creation date (DB2, run once)
-- Applied to DB2 via MCP on 2026-06-30. Captures, for every MPWR booking:
--   booked_at      — the real booking-creation timestamp (order.createdDate),
--                    distinct from start_at (when the trip takes place)
--   booking_method — raw MPWR order.bookingMethod (outfitter/advWhiteLabel/adv)
--   booking_source — normalized bucket: walkin_phone | online | marketplace
-- Populated by mpwrSync.upsertOrder going forward; the active 90-day window is
-- kept current every :00/:30 sync.

alter table public.bookings add column if not exists booked_at      timestamptz;
alter table public.bookings add column if not exists booking_method text;
alter table public.bookings add column if not exists booking_source text;

create index if not exists idx_bookings_booked_at      on public.bookings (booked_at);
create index if not exists idx_bookings_booking_source on public.bookings (booking_source);

-- daily_manifest view exposes the new fields (booked_at + booked_date in
-- Denver-local to mirror start_at; booking_source + booking_method raw).
-- See migration daily_manifest_add_source_and_booked for the full CREATE OR
-- REPLACE VIEW (adds these four columns to the end of the SELECT list).

-- Normalization (mirrors mpwrSync.normalizeBookingSource), for reference:
--   outfitter     -> walkin_phone   (staff booked it: walk-in / over the phone)
--   advWhiteLabel -> online         (outfitter's own Polaris-powered site)
--   adv           -> marketplace    (Polaris Adventures consumer marketplace)
--   <other>       -> lower(method)
