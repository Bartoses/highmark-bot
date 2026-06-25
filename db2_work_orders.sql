-- ─────────────────────────────────────────────────────────────────────────────
-- db2_work_orders.sql — MPWR fleet work orders (DB2 / CRM project)
-- Run once in the DB2 (CRM) Supabase SQL editor.
--
-- Populated by mpwrWorkOrders.runWorkOrderSync() from the MPWR
-- /work-orders.data + /work-orders/{id}.data routes. Surfaces open fleet
-- maintenance in the operator briefing, scoped per fleet (Kremmling / Steamboat).
-- Additive + non-breaking — no existing table is touched.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_orders (
  id                        TEXT        PRIMARY KEY,           -- MPWR shortId, e.g. "WO-DVQ-QQB"
  mpwr_id                   UUID,                              -- MPWR internal id
  outfitter_id              INTEGER,                           -- MPWR operatorId (541 Kremmling / 58 Steamboat)
  fleet                     TEXT,                              -- 'kremmling' | 'steamboat'
  work_type                 TEXT,                              -- raw MPWR enum (DamageRepair, ...)
  is_closed                 BOOLEAN     NOT NULL DEFAULT FALSE,
  is_safety_issue           BOOLEAN     NOT NULL DEFAULT FALSE,
  out_of_service            BOOLEAN,                           -- derived from vehicle rentability (null = unknown)
  asset_family              TEXT,                              -- model family, e.g. "RZR PRO S4 PREMIUM"
  model_year                INTEGER,
  rentability_status        TEXT,
  unit_name                 TEXT,                              -- vehicle unit number / nickname, e.g. "Pamela"
  vin                       TEXT,
  mileage                   NUMERIC,
  engine_hours              NUMERIC,
  work_to_be_done           TEXT,
  notes                     TEXT,
  created_date              TIMESTAMPTZ,
  estimated_completion_date DATE,
  closed_date               TIMESTAMPTZ,
  url                       TEXT,                              -- deep link to the MPWR work order
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Open work orders are queried per fleet for the briefing.
CREATE INDEX IF NOT EXISTS idx_work_orders_open_fleet
  ON public.work_orders(fleet)
  WHERE is_closed = FALSE;

COMMENT ON TABLE public.work_orders IS
  'MPWR fleet work orders synced hourly. Open rows (is_closed=false) drive the operator briefing FLEET section, scoped by fleet.';
COMMENT ON COLUMN public.work_orders.out_of_service IS
  'Derived from the vehicle rentability at detail-fetch time (Not Rentable / dispositioned / flagged). NULL = detail not yet enriched.';

-- Verify:
-- SELECT id, fleet, work_type, out_of_service, asset_family, unit_name, estimated_completion_date
-- FROM public.work_orders WHERE is_closed = FALSE ORDER BY fleet, out_of_service DESC NULLS LAST;
