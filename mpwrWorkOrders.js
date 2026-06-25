// mpwrWorkOrders.js — MPWR (Polaris Adventures) work-order sync
//
// Pulls OPEN fleet work orders for each CSR outfitter (Kremmling + Steamboat)
// and upserts them into DB2 `work_orders` so the operator briefing can surface
// per-location, actionable maintenance items (e.g. "RZR PRO S4 down — power
// steering loss"). Idempotent — safe to run repeatedly.
//
// Reuses the MPWR auth + turbo-stream decoder from mpwrSync.js. Auth is the
// shared MPWR_TOKEN (auto-refreshed by mpwrTokenRefresh.js).
//
// Endpoints (React Router v7 data routes, per __outfitter_session cookie):
//   GET /work-orders.data              → list (all WOs for the outfitter)
//   GET /work-orders/{shortId}.data    → detail (+ vehicle: model + rentability)
//
// The "Out of Service" badge in MPWR is NOT a work-order field — it's derived
// from the vehicle's rentability (rentabilityStatus / dispositionStatus), so we
// enrich each OPEN work order from its detail route.

import { getToken, decodeMpwrStream } from './mpwrSync.js';

const MPWR_BASE = 'https://mpwr-hq.poladv.com';

// Outfitter id → our fleet slug. Mirrors mpwrSync's outfitter set.
function fleetForOutfitter(outfitterId) {
  if (Number(outfitterId) === Number(process.env.MPWR_OUTFITTER_KREMMLING)) return 'kremmling';
  if (Number(outfitterId) === Number(process.env.MPWR_OUTFITTER_STEAMBOAT)) return 'steamboat';
  return null;
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

// MPWR workType is PascalCase enum: DamageRepair, CheckEngineLight,
// PreventativeMaintenance, TireRotationOrReplacement, MechanicalFailure,
// OilChange, AccidentDamage, MachineBreakIn. Humanize → "Damage Repair".
export function humanizeWorkType(workType) {
  if (!workType) return 'Work order';
  return String(workType).replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
}

// A retired vehicle (dispositioned / inactive — sold or pulled from the fleet)
// whose work order was never formally closed. These are never-closed cruft, not
// actionable maintenance, so they're flagged and excluded from the briefing.
export function isVehicleRetired(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return false;
  if (vehicle.isActive === false) return true;
  const disp = String(vehicle.dispositionStatus ?? '').toLowerCase().trim();
  return disp !== '' && disp !== 'none';
}

// Derive "out of service" = a vehicle still in the fleet that is currently down
// (Not Rentable for a maintenance/safety reason). rentabilityStatus is
// "Available" / "Rentable" when usable and "Not Rentable" when down. Retired
// vehicles are NOT out-of-service (they're gone) — they're handled separately.
export function deriveOutOfService(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return false;
  if (isVehicleRetired(vehicle)) return false;
  const status = String(vehicle.rentabilityStatus ?? '').toLowerCase();
  if (/not\s*rentable/.test(status)) return true;
  // Any non-disposition not-rentable reason means the unit is flagged/down.
  if (Array.isArray(vehicle.notRentableReasons) &&
      vehicle.notRentableReasons.some((r) => !/disposition/i.test(String(r)))) return true;
  return false;
}

export function buildWorkOrderUrl(shortId) {
  return shortId ? `${MPWR_BASE}/work-orders/${shortId}` : null;
}

// Map a raw MPWR list row (+ optional detail) into a DB2 `work_orders` record.
// `detail` is the decoded detail-route data ({ workOrder, vehicle, ... }) when
// available; null otherwise. Pure — no I/O.
export function normalizeWorkOrderRow(row, { fleet, outfitterId, detail = null } = {}) {
  const vehicle = detail?.vehicle ?? null;
  return {
    id:                        row.shortId,
    mpwr_id:                   row.id ?? null,
    outfitter_id:              outfitterId ?? null,
    fleet:                     fleet ?? null,
    work_type:                 row.workType ?? null,
    is_closed:                 !!row.isClosed,
    is_safety_issue:           !!row.isSafetyIssue,
    out_of_service:            vehicle ? deriveOutOfService(vehicle) : null,
    retired:                   vehicle ? isVehicleRetired(vehicle) : null,
    asset_family:              vehicle?.assetFamilyName ?? null,
    model_year:                vehicle?.modelYear ?? null,
    rentability_status:        vehicle?.rentabilityStatus ?? null,
    disposition_status:        vehicle?.dispositionStatus ?? null,
    unit_name:                 (row.vehicleUnitNumber ?? vehicle?.unitNumber ?? '').toString().trim() || null,
    vin:                       row.vin ?? vehicle?.vin ?? null,
    mileage:                   row.mileage ?? null,
    engine_hours:              row.engineHours ?? null,
    work_to_be_done:           row.workToBeDone ?? null,
    notes:                     row.notes ?? null,
    created_date:              row.createdDate ?? null,
    estimated_completion_date: row.estimatedCompletionDate ?? null,
    closed_date:               row.isClosed ? (row.closedDate ?? null) : null,
    url:                       buildWorkOrderUrl(row.shortId),
    synced_at:                 new Date().toISOString(),
  };
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchWorkOrders(outfitterId, token) {
  const res = await fetch(`${MPWR_BASE}/work-orders.data`, {
    headers: {
      'Accept':  '*/*',
      'Cookie':  `__xauth=Bearer ${token}; __outfitter_session=${outfitterId}`,
      'Referer': `${MPWR_BASE}/work-orders`,
    },
  });
  if (!res.ok) throw new Error(`MPWR work-orders list returned ${res.status}`);
  const root = decodeMpwrStream(await res.text());
  const rows = root?.['routes/_authenticated/work-orders/_layout']?.data?.tableState?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function fetchWorkOrderDetail(shortId, outfitterId, token) {
  const res = await fetch(`${MPWR_BASE}/work-orders/${shortId}.data`, {
    headers: {
      'Accept':  '*/*',
      'Cookie':  `__xauth=Bearer ${token}; __outfitter_session=${outfitterId}`,
      'Referer': `${MPWR_BASE}/work-orders/${shortId}`,
    },
  });
  if (!res.ok) throw new Error(`MPWR work-order detail ${shortId} returned ${res.status}`);
  const root = decodeMpwrStream(await res.text());
  return root?.['routes/_authenticated/work-orders.$workOrderId/_layout']?.data ?? null;
}

// ── Sync one outfitter ──────────────────────────────────────────────────────

async function syncWorkOrdersForOutfitter(outfitterId, fleet, db2, token) {
  const all  = await fetchWorkOrders(outfitterId, token);
  const open = all.filter((r) => r?.shortId && !r.isClosed);

  let upserted = 0, errors = 0;
  const openIds = [];

  for (const row of open) {
    openIds.push(row.shortId);
    let detail = null;
    try {
      detail = await fetchWorkOrderDetail(row.shortId, outfitterId, token);
    } catch (err) {
      // Detail failure must not block the upsert — we still record the open WO
      // (out_of_service stays null until a later sync enriches it).
      console.warn(`[mpwrWorkOrders] detail ${row.shortId}: ${err.message}`);
    }
    const record = normalizeWorkOrderRow(row, { fleet, outfitterId, detail });
    try {
      const { error } = await db2.from('work_orders').upsert(record, { onConflict: 'id' });
      if (error) throw error;
      upserted++;
    } catch (err) {
      console.error(`[mpwrWorkOrders] upsert ${row.shortId}: ${err.message}`);
      errors++;
    }
  }

  // Stale-close: any row still marked open for this fleet that's no longer in
  // the current open set has been completed/closed in MPWR — flag it so it
  // drops out of the briefing. Skip when the open set is empty to avoid wiping
  // everything on a transient fetch hiccup.
  if (openIds.length) {
    try {
      let q = db2.from('work_orders').update({ is_closed: true, synced_at: new Date().toISOString() })
        .eq('fleet', fleet).eq('is_closed', false);
      // PostgREST "not in" filter
      q = q.not('id', 'in', `(${openIds.map((id) => `"${id}"`).join(',')})`);
      await q;
    } catch (err) {
      console.warn(`[mpwrWorkOrders] stale-close ${fleet}: ${err.message}`);
    }
  }

  return { fleet, outfitterId, total: all.length, open: open.length, upserted, errors };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runWorkOrderSync(db2) {
  if (!process.env.MPWR_TOKEN) {
    console.log('[mpwrWorkOrders] Skipping — MPWR_TOKEN not set');
    return null;
  }
  if (!db2) {
    console.log('[mpwrWorkOrders] Skipping — no DB2 client');
    return null;
  }

  const outfitters = [
    { id: Number(process.env.MPWR_OUTFITTER_KREMMLING), fleet: 'kremmling' },
    { id: Number(process.env.MPWR_OUTFITTER_STEAMBOAT), fleet: 'steamboat' },
  ].filter((o) => o.id && !Number.isNaN(o.id));

  if (!outfitters.length) {
    console.warn('[mpwrWorkOrders] No outfitter IDs configured');
    return null;
  }

  const token   = getToken();
  const results = [];
  for (const o of outfitters) {
    try {
      const r = await syncWorkOrdersForOutfitter(o.id, o.fleet, db2, token);
      console.log(`[mpwrWorkOrders] ${o.fleet}: total=${r.total} open=${r.open} upserted=${r.upserted} errors=${r.errors}`);
      results.push(r);
    } catch (err) {
      console.error(`[mpwrWorkOrders] ${o.fleet} failed: ${err.message}`);
      results.push({ fleet: o.fleet, error: err.message });
    }
  }
  return results;
}

export { fleetForOutfitter };
