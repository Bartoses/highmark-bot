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

import crypto from "node:crypto";
import { resolvePortalClientId } from "./portalAuth.js";
import { getAllClients } from "./clients.js";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED ROLE GUARD
// Mirrors adminPortal.requireClientAdmin so we don't need a circular import.
// ─────────────────────────────────────────────────────────────────────────────
function requireClientAdmin(req, res) {
  if (!req.portalUser?.isClientAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT → COMPANY SHORTNAMES
// Resolves which `bookings.company` values belong to the requesting client.
// CSR/REA owns coloradosledrentals + rabbitearsadventures, etc.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveCompanyShortnames(clientId) {
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

export function windowFor(tab) {
  switch (tab) {
    case "today":     return { start: startOfDayMtIso(0),  end: startOfDayMtIso(1)  };
    case "tomorrow":  return { start: startOfDayMtIso(1),  end: startOfDayMtIso(2)  };
    case "week":      return { start: startOfDayMtIso(0),  end: startOfDayMtIso(7)  };
    case "past":      return { start: startOfDayMtIso(-30), end: startOfDayMtIso(0) };
    default:          return { start: startOfDayMtIso(0),  end: startOfDayMtIso(1)  };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4A — Global date range parser
// Accepts ?range=… preset OR ?start=YYYY-MM-DD&end=YYYY-MM-DD custom.
// Returns { start, end, label, days, prev: { start, end } } where prev is the
// equal-length window immediately before the current one.
// ─────────────────────────────────────────────────────────────────────────────
export function parseDateRangeQuery(query = {}) {
  const customStart = String(query.start ?? "").trim();
  const customEnd   = String(query.end   ?? "").trim();
  const range       = String(query.range ?? "").toLowerCase().trim();

  // 1. Custom range (start + end YYYY-MM-DD, both required)
  if (customStart && customEnd && /^\d{4}-\d{2}-\d{2}$/.test(customStart) && /^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
    const startMs = isoFromMtDate(customStart);
    const endMs   = isoFromMtDate(customEnd, /*addDay*/ 1); // end-exclusive (add 1 day)
    if (startMs && endMs && new Date(endMs).getTime() > new Date(startMs).getTime()) {
      const days = Math.round((new Date(endMs).getTime() - new Date(startMs).getTime()) / 86400_000);
      return {
        start: startMs, end: endMs, label: `${customStart} → ${customEnd}`, days,
        prev: prevWindow(startMs, days),
      };
    }
  }

  // 2. Named preset
  const presets = {
    "today":      { from: 0,   to: 1   },
    "tomorrow":   { from: 1,   to: 2   },
    "week":       { from: 0,   to: 7   },
    "this_week":  { from: 0,   to: 7   },
    "this_month": { from: 0,   to: daysLeftInMonth() },
    "next7":      { from: 0,   to: 7   },
    "next_7":     { from: 0,   to: 7   },
    "last7":      { from: -7,  to: 0   },
    "last_7":     { from: -7,  to: 0   },
    "last30":     { from: -30, to: 0   },
    "last_30":    { from: -30, to: 0   },
    "last90":     { from: -90, to: 0   },
    "last_90":    { from: -90, to: 0   },
    "ytd":        { from: daysSinceYearStart() * -1, to: 0 },
  };
  const p = presets[range] ?? presets["last30"];
  const start = startOfDayMtIso(p.from);
  const end   = startOfDayMtIso(p.to);
  const days  = Math.max(1, p.to - p.from);
  return {
    start, end, label: range || "last30", days,
    prev: prevWindow(start, days),
  };
}

function isoFromMtDate(yyyymmdd, addDays = 0) {
  // Build an ISO instant for 00:00 Mountain on YYYY-MM-DD (+addDays)
  try {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    const baseUtc = new Date(Date.UTC(y, m - 1, d));
    baseUtc.setUTCDate(baseUtc.getUTCDate() + addDays);
    const monthIdx = baseUtc.getUTCMonth();
    const offsetHours = (monthIdx >= 3 && monthIdx <= 9) ? 6 : 7;
    return new Date(baseUtc.getTime() + offsetHours * 3600_000).toISOString();
  } catch { return null; }
}

function daysLeftInMonth() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return Math.max(1, last.getUTCDate() - now.getUTCDate() + 1);
}

function daysSinceYearStart() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return Math.floor((now.getTime() - start.getTime()) / 86400_000);
}

function prevWindow(currentStartIso, days) {
  const startMs = new Date(currentStartIso).getTime() - days * 86400_000;
  const endMs   = new Date(currentStartIso).getTime();
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED OPERATIONAL STATUS
// Computed on-the-fly from existing fields. No DB column required.
// ─────────────────────────────────────────────────────────────────────────────
export function deriveOperationalStatus(b) {
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
export async function fetchBookingsInWindow(crmSupabase, companies, start, end, opts = {}) {
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

  // If caller passed a range/start/end, the KPI block represents that range
  // instead of "today"; the response shape stays the same so the legacy UI
  // keeps working. arriving_next stays today-anchored regardless.
  const hasRangeQuery = !!(req.query?.range || (req.query?.start && req.query?.end));
  const range = hasRangeQuery ? parseDateRangeQuery(req.query) : null;

  try {
    const today    = windowFor("today");
    const tomorrow = windowFor("tomorrow");
    const primary  = range ? { start: range.start, end: range.end } : today;

    const fetches = [
      fetchBookingsInWindow(crmSupabase, companies, primary.start, primary.end, { limit: 1000 }),
      fetchBookingsInWindow(crmSupabase, companies, tomorrow.start, tomorrow.end, { limit: 500 }),
    ];
    // Always pull "today" rows for the arriving-next list when a custom range is set
    if (range) fetches.push(fetchBookingsInWindow(crmSupabase, companies, today.start, today.end, { limit: 500 }));
    const [primaryResult, tomorrowResult, todayForArrivals] = await Promise.all(fetches);

    const primaryKpis  = summarize(primaryResult.rows);
    const tomorrowKpis = summarize(tomorrowResult.rows);
    const arrivalsRows = (todayForArrivals?.rows ?? primaryResult.rows);

    const now = Date.now();
    const arrivingNext = arrivalsRows
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

    return res.json({
      today: primaryKpis,           // Legacy field name; reflects ?range when provided
      tomorrow: tomorrowKpis,
      arriving_next: arrivingNext,
      window: range ? { start: range.start, end: range.end, label: range.label, days: range.days } : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyKpis() {
  return { bookings: 0, pax: 0, revenue_cents: 0, missing_waivers: 0, pending_checkins: 0, unpaid_balance_cents: 0 };
}

export function summarize(rows) {
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

  const search = String(req.query.search ?? "");
  const limit  = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  // Two modes: legacy `tab=today|tomorrow|week|past` OR new `range=…|start=…&end=…`
  const hasRangeQuery = !!(req.query?.range || (req.query?.start && req.query?.end));
  let start, end, label, reverse = false;
  if (hasRangeQuery) {
    const r = parseDateRangeQuery(req.query);
    start = r.start; end = r.end; label = r.label;
  } else {
    const tab = String(req.query.tab ?? "today").toLowerCase();
    if (!new Set(["today", "tomorrow", "week", "past"]).has(tab)) return res.status(400).json({ error: "invalid tab" });
    const w = windowFor(tab);
    start = w.start; end = w.end; label = tab;
    reverse = (tab === "past");
  }

  try {
    const { rows, total } = await fetchBookingsInWindow(
      crmSupabase, companies, start, end, { search, limit, offset }
    );
    if (reverse) rows.reverse();
    return res.json({ bookings: rows, total, tab: label, window: { start, end } });
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Mutating actions + aggregations
// ─────────────────────────────────────────────────────────────────────────────

// Verify the requested PK belongs to the caller's client; returns the booking
// row (with company) on success, or null after sending the error response.
async function loadBookingForCaller(req, res, crmSupabase) {
  const clientId = resolvePortalClientId(req);
  if (!clientId) { res.status(400).json({ error: "client_id required" }); return null; }
  const pk = String(req.params.pk ?? "").trim();
  if (!pk) { res.status(400).json({ error: "booking pk required" }); return null; }
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) { res.status(404).json({ error: "not found" }); return null; }
  const { data, error } = await crmSupabase
    .from("bookings")
    .select("fareharbor_pk,company")
    .eq("fareharbor_pk", pk)
    .in("company", companies)
    .maybeSingle();
  if (error)  { res.status(500).json({ error: error.message }); return null; }
  if (!data)  { res.status(404).json({ error: "not found" });   return null; }
  return data;
}

async function patchBookingFields(req, res, crmSupabase, fields) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const booking = await loadBookingForCaller(req, res, crmSupabase);
  if (!booking) return; // response already sent

  const { error } = await crmSupabase
    .from("bookings")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("fareharbor_pk", booking.fareharbor_pk);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, fareharbor_pk: booking.fareharbor_pk, updated: fields });
}

// ── POST /portal/api/operations/bookings/:pk/check-in ─────────────────────────
export async function handleOperationsCheckIn(req, res, _supabase, crmSupabase = null) {
  const checkedIn = req.body?.checked_in;
  if (typeof checkedIn !== "boolean") return res.status(400).json({ error: "checked_in (boolean) required" });
  return patchBookingFields(req, res, crmSupabase, { checked_in: checkedIn });
}

// ── POST /portal/api/operations/bookings/:pk/waiver ──────────────────────────
export async function handleOperationsWaiver(req, res, _supabase, crmSupabase = null) {
  const signed = req.body?.waiver_signed;
  if (typeof signed !== "boolean") return res.status(400).json({ error: "waiver_signed (boolean) required" });
  return patchBookingFields(req, res, crmSupabase, { waiver_signed: signed });
}

// ── POST /portal/api/operations/bookings/:pk/note ────────────────────────────
export async function handleOperationsNote(req, res, _supabase, crmSupabase = null) {
  const note = req.body?.internal_notes;
  if (note != null && typeof note !== "string") return res.status(400).json({ error: "internal_notes must be string or null" });
  if (typeof note === "string" && note.length > 4000) return res.status(400).json({ error: "internal_notes too long (max 4000 chars)" });
  return patchBookingFields(req, res, crmSupabase, { internal_notes: note ?? null });
}

// ── POST /portal/api/operations/bookings/:pk/guide ───────────────────────────
export async function handleOperationsGuide(req, res, _supabase, crmSupabase = null) {
  const name = req.body?.guide_name;
  if (name != null && typeof name !== "string") return res.status(400).json({ error: "guide_name must be string or null" });
  if (typeof name === "string" && name.length > 120) return res.status(400).json({ error: "guide_name too long (max 120 chars)" });
  const trimmed = typeof name === "string" ? name.trim() || null : null;
  return patchBookingFields(req, res, crmSupabase, { guide_name: trimmed });
}

// ── POST /portal/api/operations/bookings/:pk/prep ────────────────────────────
export async function handleOperationsPrep(req, res, _supabase, crmSupabase = null) {
  const prep = req.body?.prep_completed;
  if (typeof prep !== "boolean") return res.status(400).json({ error: "prep_completed (boolean) required" });
  return patchBookingFields(req, res, crmSupabase, { prep_completed: prep });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/tomorrow-prep
// Aggregates tomorrow's bookings into prep-friendly counts (by activity, by
// location), plus open-issue counts (waivers, payments, unassigned guides).
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsTomorrowPrep(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyPrep());

  try {
    const { start, end } = windowFor("tomorrow");
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500 });

    if (!rows.length) return res.json(emptyPrep());

    // Aggregate by activity, by location, and operational issues
    const byActivity = new Map();
    const byLocation = new Map();
    let totalPax = 0, missingWaivers = 0, unpaid = 0, unassignedGuides = 0, prepDone = 0;

    for (const b of rows) {
      const act = b.activity ?? "Unknown";
      const loc = b.location ?? "—";
      byActivity.set(act, (byActivity.get(act) ?? { bookings: 0, pax: 0 }));
      byActivity.get(act).bookings += 1;
      byActivity.get(act).pax      += Number(b.pax ?? 1);
      byLocation.set(loc, (byLocation.get(loc) ?? { bookings: 0, pax: 0 }));
      byLocation.get(loc).bookings += 1;
      byLocation.get(loc).pax      += Number(b.pax ?? 1);

      totalPax += Number(b.pax ?? 1);
      if (b.waiver_signed === false)            missingWaivers += 1;
      if (Number(b.balance_due_cents ?? 0) > 0) unpaid         += 1;
      if (!b.guide_name)                        unassignedGuides += 1;
      if (b.prep_completed === true)            prepDone        += 1;
    }

    return res.json({
      window:    { start, end },
      total_bookings: rows.length,
      total_pax: totalPax,
      open_issues: {
        missing_waivers:   missingWaivers,
        unpaid_bookings:   unpaid,
        unassigned_guides: unassignedGuides,
      },
      prep_completed:    prepDone,
      prep_remaining:    rows.length - prepDone,
      by_activity: [...byActivity.entries()]
        .map(([name, v]) => ({ name, bookings: v.bookings, pax: v.pax }))
        .sort((a, b) => b.pax - a.pax),
      by_location: [...byLocation.entries()]
        .map(([name, v]) => ({ name, bookings: v.bookings, pax: v.pax }))
        .sort((a, b) => b.pax - a.pax),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyPrep() {
  return {
    total_bookings: 0, total_pax: 0,
    open_issues: { missing_waivers: 0, unpaid_bookings: 0, unassigned_guides: 0 },
    prep_completed: 0, prep_remaining: 0,
    by_activity: [], by_location: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/guides?tab=today|tomorrow|week
// Per-guide load + an "Unassigned" bucket for bookings missing guide_name.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsGuides(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json({ guides: [], unassigned: { bookings: 0, pax: 0 } });

  const hasRangeQuery = !!(req.query?.range || (req.query?.start && req.query?.end));
  let start, end, tab;
  if (hasRangeQuery) {
    const r = parseDateRangeQuery(req.query);
    start = r.start; end = r.end; tab = r.label;
  } else {
    tab = String(req.query.tab ?? "today").toLowerCase();
    if (!["today", "tomorrow", "week"].includes(tab)) {
      return res.status(400).json({ error: "invalid tab" });
    }
    const w = windowFor(tab); start = w.start; end = w.end;
  }

  try {
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500 });

    const byGuide = new Map();
    let unassignedBookings = 0, unassignedPax = 0;
    for (const b of rows) {
      const g = (b.guide_name ?? "").trim();
      const pax = Number(b.pax ?? 1);
      if (!g) { unassignedBookings += 1; unassignedPax += pax; continue; }
      if (!byGuide.has(g)) byGuide.set(g, { name: g, bookings: 0, pax: 0 });
      byGuide.get(g).bookings += 1;
      byGuide.get(g).pax      += pax;
    }
    const guides = [...byGuide.values()].sort((a, b) => b.pax - a.pax);
    return res.json({ tab, guides, unassigned: { bookings: unassignedBookings, pax: unassignedPax } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Share links (no-auth read-only dashboards) + analytics
// ─────────────────────────────────────────────────────────────────────────────

function newShareToken() {
  // 32-char URL-safe random token
  return crypto.randomBytes(24).toString("base64url");
}

// ── POST /portal/api/operations/share-links ──────────────────────────────────
export async function handleCreateShareLink(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const label    = typeof req.body?.label === "string" ? req.body.label.slice(0, 120) : null;
  const days     = Number(req.body?.expires_in_days);
  const expires  = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + days * 86400_000).toISOString()
    : null;
  const createdBy = req.portalUser?.id ?? req.portalUser?.userId ?? null;

  const { data, error } = await supabase
    .from("operations_share_links")
    .insert({ client_id: clientId, token: newShareToken(), label, expires_at: expires, created_by: createdBy })
    .select("id,token,label,created_at,expires_at,revoked_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ link: data });
}

// ── GET /portal/api/operations/share-links ───────────────────────────────────
export async function handleListShareLinks(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const { data, error } = await supabase
    .from("operations_share_links")
    .select("id,token,label,created_at,expires_at,revoked_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ links: data ?? [] });
}

// ── DELETE /portal/api/operations/share-links/:id ────────────────────────────
export async function handleRevokeShareLink(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "id required" });

  const { error, count } = await supabase
    .from("operations_share_links")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) return res.status(500).json({ error: error.message });
  if (!count) return res.status(404).json({ error: "not found" });
  return res.json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/analytics?days=30
// Past-bookings analytics: revenue/day, by activity, by location,
// waiver-completion rate, avg party size.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsAnalytics(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  return computeAndSendAnalytics(req, res, crmSupabase, clientId);
}

export async function computeAndSendAnalytics(req, res, crmSupabase, clientId) {
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyAnalytics());

  const days = Math.min(Math.max(Number(req.query?.days ?? 30), 1), 365);
  const end   = new Date();
  const start = new Date(end.getTime() - days * 86400_000);

  try {
    const { data, error } = await crmSupabase
      .from("daily_manifest")
      .select("start_at,activity,location,pax,receipt_total_cents,waiver_signed,checked_in")
      .in("company", companies)
      .gte("start_at", start.toISOString())
      .lt("start_at",  end.toISOString())
      .order("start_at", { ascending: true });
    if (error) throw error;
    const rows = data ?? [];

    if (!rows.length) return res.json(emptyAnalytics({ days }));

    const revenueByDay = new Map();
    const byActivity   = new Map();
    const byLocation   = new Map();
    let totalPax = 0, totalRevenue = 0, waiversSigned = 0, checkedIn = 0;

    for (const r of rows) {
      const day = (r.start_at ?? "").slice(0, 10);
      revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + Number(r.receipt_total_cents ?? 0));
      const a = r.activity ?? "Unknown";
      byActivity.set(a, (byActivity.get(a) ?? { bookings: 0, pax: 0, revenue_cents: 0 }));
      byActivity.get(a).bookings      += 1;
      byActivity.get(a).pax           += Number(r.pax ?? 1);
      byActivity.get(a).revenue_cents += Number(r.receipt_total_cents ?? 0);
      const l = r.location ?? "—";
      byLocation.set(l, (byLocation.get(l) ?? { bookings: 0, pax: 0 }));
      byLocation.get(l).bookings += 1;
      byLocation.get(l).pax      += Number(r.pax ?? 1);
      totalPax     += Number(r.pax ?? 1);
      totalRevenue += Number(r.receipt_total_cents ?? 0);
      if (r.waiver_signed) waiversSigned += 1;
      if (r.checked_in)    checkedIn     += 1;
    }

    return res.json({
      window: { start: start.toISOString(), end: end.toISOString(), days },
      total_bookings:       rows.length,
      total_pax:            totalPax,
      total_revenue_cents:  totalRevenue,
      avg_party_size:       Number((totalPax / rows.length).toFixed(2)),
      waiver_completion:    Number((waiversSigned / rows.length).toFixed(3)),
      checkin_completion:   Number((checkedIn   / rows.length).toFixed(3)),
      revenue_by_day:       [...revenueByDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, cents]) => ({ date, revenue_cents: cents })),
      by_activity:          [...byActivity.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.revenue_cents - a.revenue_cents)
        .slice(0, 10),
      by_location:          [...byLocation.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.pax - a.pax),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyAnalytics(extra = {}) {
  return {
    total_bookings: 0, total_pax: 0, total_revenue_cents: 0, avg_party_size: 0,
    waiver_completion: 0, checkin_completion: 0,
    revenue_by_day: [], by_activity: [], by_location: [],
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4A — REVENUE INTELLIGENCE
// GET /portal/api/operations/revenue?range=…|start=…&end=…&compare=prev
// Returns aggregated revenue/booking/pax breakdowns + optional previous-period
// comparison for delta indicators on KPI cards.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsRevenue(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  return computeAndSendRevenue(req, res, crmSupabase, clientId);
}

export async function computeAndSendRevenue(req, res, crmSupabase, clientId) {
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyRevenue());

  const range = parseDateRangeQuery(req.query ?? {});
  const wantCompare = String(req.query?.compare ?? "").toLowerCase() === "prev";

  try {
    const fetches = [fetchBookingsForRevenue(crmSupabase, companies, range.start, range.end)];
    if (wantCompare) fetches.push(fetchBookingsForRevenue(crmSupabase, companies, range.prev.start, range.prev.end));
    const [current, previous] = await Promise.all(fetches);

    const totals  = totalsFor(current);
    const prevTot = previous ? totalsFor(previous) : null;
    const deltas  = prevTot ? deltasFor(totals, prevTot) : null;

    return res.json({
      window:      { start: range.start, end: range.end, days: range.days, label: range.label },
      compare_window: prevTot ? range.prev : null,
      totals,
      compare_totals: prevTot,
      deltas,
      revenue_by_day:      groupByDay(current),
      revenue_by_activity: groupBy(current, "activity"),
      revenue_by_location: groupBy(current, "location"),
      revenue_by_guide:    groupByGuide(current),
      best_day_of_week:    bestDayOfWeek(current),
      // Helpful for executive summary card client-side
      top_activity: topByRevenue(groupBy(current, "activity")),
      top_location: topByRevenue(groupBy(current, "location")),
      top_guide:    topByRevenue(groupByGuide(current)),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchBookingsForRevenue(crmSupabase, companies, start, end) {
  // We pull from daily_manifest for revenue/pax/activity/location, then JOIN
  // bookings for guide_name (manifest doesn't expose it).
  const { data: manifest, error } = await crmSupabase
    .from("daily_manifest")
    .select("start_at,activity,location,pax,receipt_total_cents,balance_due_cents,fareharbor_pk,waiver_signed,checked_in")
    .in("company", companies)
    .gte("start_at", start)
    .lt("start_at",  end)
    .order("start_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = manifest ?? [];
  if (!rows.length) return rows;

  const pks = rows.map(r => r.fareharbor_pk).filter(Boolean);
  let guideMap = new Map();
  if (pks.length) {
    const { data: ops } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name")
      .in("fareharbor_pk", pks);
    guideMap = new Map((ops ?? []).map(o => [o.fareharbor_pk, o.guide_name]));
  }
  return rows.map(r => ({ ...r, guide_name: guideMap.get(r.fareharbor_pk) ?? null }));
}

function totalsFor(rows) {
  let bookings = 0, pax = 0, revenue = 0, unpaid = 0, waiversSigned = 0, checkedIn = 0;
  for (const r of rows) {
    bookings += 1;
    pax      += Number(r.pax ?? 1);
    revenue  += Number(r.receipt_total_cents ?? 0);
    unpaid   += Number(r.balance_due_cents ?? 0);
    if (r.waiver_signed) waiversSigned += 1;
    if (r.checked_in)    checkedIn     += 1;
  }
  return {
    bookings, pax,
    revenue_cents:        revenue,
    avg_booking_cents:    bookings ? Math.round(revenue / bookings) : 0,
    unpaid_balance_cents: unpaid,
    waiver_completion:    bookings ? Number((waiversSigned / bookings).toFixed(3)) : 0,
    checkin_completion:   bookings ? Number((checkedIn   / bookings).toFixed(3)) : 0,
  };
}

function deltasFor(cur, prev) {
  const pct = (a, b) => {
    if (!b) return a > 0 ? 1 : 0;
    return Number(((a - b) / b).toFixed(3));
  };
  return {
    bookings:      pct(cur.bookings,             prev.bookings),
    pax:           pct(cur.pax,                  prev.pax),
    revenue:       pct(cur.revenue_cents,        prev.revenue_cents),
    avg_booking:   pct(cur.avg_booking_cents,    prev.avg_booking_cents),
    waiver:        cur.waiver_completion  - prev.waiver_completion,
    checkin:       cur.checkin_completion - prev.checkin_completion,
  };
}

function groupByDay(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = (r.start_at ?? "").slice(0, 10);
    if (!d) continue;
    if (!m.has(d)) m.set(d, { date: d, revenue_cents: 0, bookings: 0, pax: 0 });
    m.get(d).revenue_cents += Number(r.receipt_total_cents ?? 0);
    m.get(d).bookings      += 1;
    m.get(d).pax           += Number(r.pax ?? 1);
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function groupBy(rows, field) {
  const m = new Map();
  for (const r of rows) {
    const k = r[field] ?? "—";
    if (!m.has(k)) m.set(k, { name: k, bookings: 0, pax: 0, revenue_cents: 0 });
    m.get(k).bookings      += 1;
    m.get(k).pax           += Number(r.pax ?? 1);
    m.get(k).revenue_cents += Number(r.receipt_total_cents ?? 0);
  }
  return [...m.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);
}

function groupByGuide(rows) {
  const m = new Map();
  for (const r of rows) {
    const g = (r.guide_name ?? "").trim();
    const k = g || "Unassigned";
    if (!m.has(k)) m.set(k, { name: k, bookings: 0, pax: 0, revenue_cents: 0 });
    m.get(k).bookings      += 1;
    m.get(k).pax           += Number(r.pax ?? 1);
    m.get(k).revenue_cents += Number(r.receipt_total_cents ?? 0);
  }
  return [...m.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);
}

function bestDayOfWeek(rows) {
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const m = new Map(days.map(d => [d, { name: d, bookings: 0, pax: 0, revenue_cents: 0 }]));
  for (const r of rows) {
    const d = days[new Date(r.start_at).getUTCDay()];
    if (!d) continue;
    m.get(d).bookings      += 1;
    m.get(d).pax           += Number(r.pax ?? 1);
    m.get(d).revenue_cents += Number(r.receipt_total_cents ?? 0);
  }
  return [...m.values()].sort((a, b) => b.bookings - a.bookings)[0] ?? null;
}

function topByRevenue(arr) {
  return arr?.[0] ?? null;
}

function emptyRevenue() {
  return {
    window: null, compare_window: null,
    totals: { bookings: 0, pax: 0, revenue_cents: 0, avg_booking_cents: 0, unpaid_balance_cents: 0, waiver_completion: 0, checkin_completion: 0 },
    compare_totals: null, deltas: null,
    revenue_by_day: [], revenue_by_activity: [], revenue_by_location: [], revenue_by_guide: [],
    best_day_of_week: null, top_activity: null, top_location: null, top_guide: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/forecast
// Simple pacing model: month-to-date totals × (days in month / days elapsed),
// plus weekend load + unassigned-guide pressure.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsForecast(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  return computeAndSendForecast(req, res, crmSupabase, clientId);
}

export async function computeAndSendForecast(req, res, crmSupabase, clientId) {
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyForecast());

  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const daysInMonth = (monthEnd - monthStart) / 86400_000;
    const daysElapsed = Math.max(1, Math.ceil((now - monthStart) / 86400_000));

    // Pull all bookings in current month + last month for comparison
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const [thisMonth, lastMonth] = await Promise.all([
      fetchBookingsForRevenue(crmSupabase, companies, monthStart.toISOString(), monthEnd.toISOString()),
      fetchBookingsForRevenue(crmSupabase, companies, lastMonthStart.toISOString(), monthStart.toISOString()),
    ]);

    const mtd      = totalsFor(thisMonth.filter(r => new Date(r.start_at) <= now));
    const monthAll = totalsFor(thisMonth);                  // includes future bookings already on books
    const last     = totalsFor(lastMonth);

    // Projected revenue: max(MTD-paced, already-booked-in-month). Always at least
    // what's already on the books — a calendar half-empty doesn't reduce booked
    // future revenue.
    const pacedRev = Math.round(mtd.revenue_cents * (daysInMonth / daysElapsed));
    const projRev  = Math.max(pacedRev, monthAll.revenue_cents);
    const projBookings = Math.max(
      Math.round(mtd.bookings * (daysInMonth / daysElapsed)),
      monthAll.bookings
    );

    // Weekend load (next 14 days, Sat+Sun bookings)
    const today    = new Date();
    const weekendEnd = new Date(today.getTime() + 14 * 86400_000);
    const upcoming = thisMonth.concat(
      lastMonth.length ? [] : [] // Only thisMonth in scope normally
    ).filter(r => {
      const t = new Date(r.start_at);
      if (t < today || t > weekendEnd) return false;
      const dow = t.getUTCDay();
      return dow === 0 || dow === 6;
    });
    let weekendBookings = 0, weekendPax = 0, weekendUnassigned = 0;
    for (const r of upcoming) {
      weekendBookings += 1;
      weekendPax      += Number(r.pax ?? 1);
      if (!r.guide_name) weekendUnassigned += 1;
    }

    return res.json({
      month: {
        start: monthStart.toISOString(), end: monthEnd.toISOString(),
        days_in_month: daysInMonth, days_elapsed: Math.min(daysElapsed, daysInMonth),
      },
      mtd,
      booked_in_month:      monthAll,
      last_month:           last,
      projected_revenue_cents: projRev,
      projected_bookings:    projBookings,
      revenue_pacing_pct:   last.revenue_cents ? Number(((projRev - last.revenue_cents) / last.revenue_cents).toFixed(3)) : null,
      bookings_pacing_pct:  last.bookings      ? Number(((projBookings - last.bookings) / last.bookings).toFixed(3)) : null,
      weekend_load: {
        next_14_days_bookings: weekendBookings,
        next_14_days_pax:      weekendPax,
        unassigned_guides:     weekendUnassigned,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyForecast() {
  return {
    month: null, mtd: null, booked_in_month: null, last_month: null,
    projected_revenue_cents: 0, projected_bookings: 0,
    revenue_pacing_pct: null, bookings_pacing_pct: null,
    weekend_load: { next_14_days_bookings: 0, next_14_days_pax: 0, unassigned_guides: 0 },
  };
}
