-- ─────────────────────────────────────────────────────────────────────────────
-- db1_operator_locations.sql — per-operator location assignment
-- Run once in Supabase DB1 SQL editor.
--
-- Adds `locations` to operator_phones so a staff/manager phone can be scoped to
-- one or more physical locations (steamboat / north_routt / kremmling /
-- rabbit_ears). The operator briefing then STRICT-FILTERS that phone's digest
-- to its assigned location(s) — bookings, actions, and fleet work orders.
--
-- Empty array (default) = unscoped = owner view (sees everything). Backward
-- compatible: existing rows default to '{}' so behavior is unchanged until a
-- location is assigned in the portal.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.operator_phones
  ADD COLUMN IF NOT EXISTS locations TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.operator_phones.locations IS
  'Assigned locations for this phone (subset of steamboat/north_routt/kremmling/rabbit_ears). Empty = unscoped (owner view, all locations). Drives strict location filtering of the briefing + fleet work orders.';

-- Verify:
-- SELECT client_id, phone, role, locations, digest_types FROM public.operator_phones ORDER BY client_id;
