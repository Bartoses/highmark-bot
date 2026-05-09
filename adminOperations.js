// ─────────────────────────────────────────────────────────────────────────────
// adminOperations.js — Operator Dashboard API (Phase 1: read-only)
//
// Routes:
//   GET /portal/api/operations/summary           — KPI bar + arrivals next
//   GET /portal/api/operations/bookings          — tab-filtered table
//   GET /portal/api/operations/bookings/:pk      — single booking drawer
//
// All routes are scoped to the requesting portal user's client_id by mapping
// to that client's fareharborCompanies[].shortname → bookings.company.
// Source data comes from DB2 (crmSupabase) — daily_manifest view for joined
// guest/activity data, falling back to the bookings table for new operational
// columns (guide_name, internal_notes, prep_completed) added in
// db2_bookings_operations.sql.
// ─────────────────────────────────────────────────────────────────────────────

import { resolvePortalClientId } from "./portalAuth.js";
import { getAllClients } from "./clients.js";

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT → COMPANY SHORTNAMES
// Resolves which `bookings.company` values belong to the requesting client.
// CSR/REA owns coloradosledrentals + rabbitearsadventures, etc.
// ─────────────────────────────────────────────────────────────────────────────
function resolveCompanyShortnames(clientId) {
  const clients = getAllClients();
  const client  = clients[clientId];
  const fhs     = Array.isArray(client?.fareharborCompanies) ? client.fareharborCompanies : [];
  const names   = fhs.map(c => c?.shortname).filter(Boolean);
  return names.length ? names : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMEZONE WINDOWS — Mountain time, day boundaries
// All booking start_at values are stored in UTC; we filter by client-local day.
// ─────────────────────────────────────────────────────────────────────────────
function mountainNow() {
  // Mountain time = UTC-6 (MDT) Apr-Oct, UTC-7 (MST) Nov-Mar
  const now = new Date();
  const m   = now.getUTCMonth(); // 0-indexed
  const offsetHours = (m >= 3 && m <= 9) ? 6 : 7;
  return { now, offsetHours };
}

function startOfDayMtIso(daysFromToday = 0) {
  const { now, offsetHours } = mountainNow();
  const mt = new Date(now.getTime() - offsetHours * 3600_000);
  mt.setUTCHours(0, 0, 0, 0);
  mt.setUTCDate(mt.getUTCDate() + daysFromToday);
  return new Date(mt.getTime() + offsetHours * 3600_000).toISOString();
}

function windowFor(tab) {
  switch (tab) {
    case "today":     return { start: startOfDayMtIso(0),  end: startOfDayMtIso(1)  };
    case "tomorrow":  return { start: startOfDayMtIso(1),  end: startOfDayMtIso(2)  };
    case "week":      return { start: startOfDayMtIso(0),  end: startOfDayMtIso(7)  };
    case "past":      return { start: startOfDayMtIso(-30), end: startOfDayMtIso(0) };
    default:          return { start: startOfDayMtIso(0),  end: startOfDayMtIso(1)  };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED OPERATIONAL STATUS
// Computed on-the-fly from existing fields. No DB column required.
// ─────────────────────────────────────────────────────────────────────────────
function deriveOperationalStatus(b) {
  const now    = Date.now();
  const startMs = b.start_at ? new Date(b.start_at).getTime() : null;
  const dueCents = Number(b.balance_due_cents ?? 0);

  if (b.checked_in)                               return "checked_in";
  if (startMs && startMs < now - 3600_000)        return "late";
  if (startMs && startMs < now + 3600_000)        return "arriving_soon";
  if (dueCents > 0)                               return "needs_payment";
  if (b.waiver_signed === false)                  return "needs_waiver";
  return "ready";
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH BOOKINGS — daily_manifest view + bookings join for ops columns
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBookingsInWindow(crmSupabase, companies, start, end, opts = {}) {
  const { search = "", limit = 200, offset = 0 } = opts;

  // 1. Pull from manifest view (already joined customer + activity + payment)
  let q = crmSupabase
    .from("daily_manifest")
    .select("*", { count: "exact" })
    .in("company", companies)
    .gte("start_at", start)
    .lt("start_at",  end)
    .order("start_at", { ascending: true })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (search) {
    const s = String(search).trim();
    if (s) q = q.or(`customer_name.ilike.%${s}%,phone.ilike.%${s}%,fareharbor_pk.ilike.%${s}%,activity.ilike.%${s}%`);
  }

  const { data: manifest, error, count } = await q;
  if (error) throw error;
  if (!manifest?.length) return { rows: [], total: count ?? 0 };

  // 2. Pull operational columns from bookings table by fareharbor_pk
  const pks = manifest.map(b => b.fareharbor_pk).filter(Boolean);
  let opsRows = [];
  if (pks.length) {
    const { data: ops } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name,internal_notes,prep_completed")
      .in("fareharbor_pk", pks);
    opsRows = ops ?? [];
  }
  const opsByPk = new Map(opsRows.map(r => [r.fareharbor_pk, r]));

  const rows = manifest.map(b => {
    const ops = opsByPk.get(b.fareharbor_pk) ?? {};
    const enriched = {
      ...b,
      guide_name:     ops.guide_name     ?? null,
      internal_notes: ops.internal_notes ?? null,
      prep_completed: ops.prep_completed ?? false,
    };
    enriched.operational_status = deriveOperationalStatus(enriched);
    return enriched;
  });

  return { rows, total: count ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/summary
// KPI bar + arriving-next list. Computed across today's bookings.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsSummary(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });

  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) {
    return res.json({
      today:    emptyKpis(),
      tomorrow: emptyKpis(),
      arriving_next: [],
    });
  }

  try {
    const today    = windowFor("today");
    const tomorrow = windowFor("tomorrow");

    const [todayResult, tomorrowResult] = await Promise.all([
      fetchBookingsInWindow(crmSupabase, companies, today.start, today.end, { limit: 500 }),
      fetchBookingsInWindow(crmSupabase, companies, tomorrow.start, tomorrow.end, { limit: 500 }),
    ]);

    const todayKpis    = summarize(todayResult.rows);
    const tomorrowKpis = summarize(tomorrowResult.rows);

    const now = Date.now();
    const arrivingNext = todayResult.rows
      .filter(b => {
        const t = new Date(b.start_at).getTime();
        return !b.checked_in && t >= now - 30 * 60_000;
      })
      .slice(0, 8)
      .map(b => ({
        fareharbor_pk:   b.fareharbor_pk,
        customer_name:   b.customer_name,
        phone:           b.phone,
        activity:        b.activity,
        pax:             b.pax,
        start_at:        b.start_at,
        arrival_display: b.arrival_display,
        waiver_signed:   b.waiver_signed,
        checked_in:      b.checked_in,
        operational_status: b.operational_status,
      }));

    return res.json({ today: todayKpis, tomorrow: tomorrowKpis, arriving_next: arrivingNext });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyKpis() {
  return { bookings: 0, pax: 0, revenue_cents: 0, missing_waivers: 0, pending_checkins: 0, unpaid_balance_cents: 0 };
}

function summarize(rows) {
  let pax = 0, revenue = 0, waiverMissing = 0, checkInPending = 0, unpaid = 0;
  for (const b of rows) {
    pax     += Number(b.pax ?? 0);
    revenue += Number(b.receipt_total_cents ?? 0);
    unpaid  += Number(b.balance_due_cents ?? 0);
    if (b.waiver_signed === false) waiverMissing  += 1;
    if (b.checked_in    === false) checkInPending += 1;
  }
  return {
    bookings:             rows.length,
    pax,
    revenue_cents:        revenue,
    missing_waivers:      waiverMissing,
    pending_checkins:     checkInPending,
    unpaid_balance_cents: unpaid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/bookings?tab=today|tomorrow|week|past
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsBookings(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });

  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json({ bookings: [], total: 0 });

  const tab    = String(req.query.tab ?? "today").toLowerCase();
  const search = String(req.query.search ?? "");
  const limit  = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  const validTabs = new Set(["today", "tomorrow", "week", "past"]);
  if (!validTabs.has(tab)) return res.status(400).json({ error: "invalid tab" });

  try {
    const { start, end } = windowFor(tab);
    const { rows, total } = await fetchBookingsInWindow(
      crmSupabase, companies, start, end, { search, limit, offset }
    );
    // For past, sort newest first
    if (tab === "past") rows.reverse();
    return res.json({ bookings: rows, total, tab, window: { start, end } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/bookings/:pk
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsBookingDetail(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });

  const pk = String(req.params.pk ?? "").trim();
  if (!pk) return res.status(400).json({ error: "booking pk required" });

  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.status(404).json({ error: "not found" });

  try {
    const { data: manifestRow, error: mErr } = await crmSupabase
      .from("daily_manifest")
      .select("*")
      .eq("fareharbor_pk", pk)
      .in("company", companies)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!manifestRow) return res.status(404).json({ error: "not found" });

    const { data: opsRow } = await crmSupabase
      .from("bookings")
      .select("guide_name,internal_notes,prep_completed,booked_at,end_at,line_items,raw_payload,booking_notes")
      .eq("fareharbor_pk", pk)
      .maybeSingle();

    const booking = {
      ...manifestRow,
      guide_name:     opsRow?.guide_name     ?? null,
      internal_notes: opsRow?.internal_notes ?? null,
      prep_completed: opsRow?.prep_completed ?? false,
      booked_at:      opsRow?.booked_at      ?? null,
      end_at:         opsRow?.end_at         ?? null,
      line_items:     opsRow?.line_items     ?? null,
      booking_notes:  opsRow?.booking_notes  ?? manifestRow.booking_notes ?? null,
    };
    booking.operational_status = deriveOperationalStatus(booking);
    return res.json({ booking });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
