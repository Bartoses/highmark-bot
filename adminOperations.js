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
    "ytd":        { from: daysSinceYearStart() * -1, to: daysUntilYearEnd() },
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

function daysUntilYearEnd() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
  return Math.ceil((end.getTime() - now.getTime()) / 86400_000);
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
// Date dimension parser — selects which timestamp the date range filters on.
//   dim=start  (default): filter on bookings.start_at  — "when does the trip happen"
//   dim=booked          : filter on bookings.booked_at — "when did the customer reserve"
// ─────────────────────────────────────────────────────────────────────────────
export function parseDateDim(query = {}) {
  const v = String(query.dim ?? "").toLowerCase().trim();
  return v === "booked" || v === "created" ? "booked" : "start";
}

// ─────────────────────────────────────────────────────────────────────────────
// Season filter — narrows results by start_at month.
//   summer   : Apr–Oct  (months 4..10)
//   winter   : Nov–Mar  (months 11, 12, 1, 2, 3)
//   shoulder : Apr–May  (months 4..5)  — when the bot serves both
//   null     : no filter
// ─────────────────────────────────────────────────────────────────────────────
const SEASON_MONTHS = {
  summer:   new Set([4, 5, 6, 7, 8, 9, 10]),
  winter:   new Set([11, 12, 1, 2, 3]),
  shoulder: new Set([4, 5]),
};

export function parseSeasonFilter(query = {}) {
  const v = String(query.season ?? "").toLowerCase().trim();
  return SEASON_MONTHS[v] ? v : null;
}

export function applySeasonFilter(rows, season) {
  if (!season) return rows;
  const months = SEASON_MONTHS[season];
  if (!months) return rows;
  return rows.filter(r => {
    if (!r?.start_at) return false;
    const m = new Date(r.start_at).getUTCMonth() + 1;
    return months.has(m);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4B — Filter param parsing
// Accepts multi-select filters from the operations bookings list. All optional.
// activity / location / guide / company:   comma-separated values
// waiver:    'signed' | 'missing'
// payment:   'paid' | 'due'
// status:    comma-separated booking statuses
// affiliate: comma-separated affiliate names
// min_pax / max_pax: integers
// ─────────────────────────────────────────────────────────────────────────────
export function parseBookingFilters(query = {}) {
  const csv = (s) => String(s ?? "").split(",").map(v => v.trim()).filter(Boolean);
  return {
    activity:  csv(query.activity),
    location:  csv(query.location),
    guide:     csv(query.guide),
    company:   csv(query.company),
    status:    csv(query.status),
    affiliate: csv(query.affiliate),
    waiver:    query.waiver  === "signed" || query.waiver  === "missing" ? query.waiver  : null,
    payment:   query.payment === "paid"   || query.payment === "due"     ? query.payment : null,
    min_pax:   Number.isFinite(Number(query.min_pax)) ? Number(query.min_pax) : null,
    max_pax:   Number.isFinite(Number(query.max_pax)) ? Number(query.max_pax) : null,
  };
}

function applyFilters(rows, f) {
  if (!f) return rows;
  return rows.filter(r => {
    if (f.activity?.length  && !f.activity.includes(r.activity))   return false;
    if (f.location?.length  && !f.location.includes(r.location))   return false;
    if (f.guide?.length     && !f.guide.includes(r.guide_name))    return false;
    if (f.company?.length   && !f.company.includes(r.company))     return false;
    if (f.status?.length    && !f.status.includes(r.status))       return false;
    if (f.affiliate?.length && !f.affiliate.includes(r.affiliate)) return false;
    if (f.waiver  === "signed"  && r.waiver_signed !== true)       return false;
    if (f.waiver  === "missing" && r.waiver_signed === true)       return false;
    if (f.payment === "paid"    && Number(r.balance_due_cents ?? 0) > 0)  return false;
    if (f.payment === "due"     && Number(r.balance_due_cents ?? 0) <= 0) return false;
    if (f.min_pax != null && Number(r.pax ?? 0) < f.min_pax)       return false;
    if (f.max_pax != null && Number(r.pax ?? 0) > f.max_pax)       return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH BOOKINGS — daily_manifest view + bookings join for ops columns
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchBookingsInWindow(crmSupabase, companies, start, end, opts = {}) {
  const { search = "", limit = 200, offset = 0, dim = "start", season = null } = opts;

  // ── DIM = "booked" — filter the date range on bookings.booked_at instead of
  // start_at. The manifest view doesn't expose booked_at, so we lead with the
  // bookings table to satisfy the date filter, then enrich from the manifest.
  if (dim === "booked") {
    let bq = crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name,internal_notes,prep_completed,booked_at,created_at,company,status", { count: "exact" })
      .in("company", companies)
      // booked_at can be null on rows imported manually; treat created_at as the
      // fallback "when the booking entered our system".
      .or(`and(booked_at.gte.${start},booked_at.lt.${end}),and(booked_at.is.null,created_at.gte.${start},created_at.lt.${end})`)
      .order("booked_at", { ascending: false })
      .limit(Math.min(Number(limit) + Number(offset), 2000));
    const { data: ops, error: opsErr, count } = await bq;
    if (opsErr) throw opsErr;
    const pks = (ops ?? []).map(o => o.fareharbor_pk).filter(Boolean);
    if (!pks.length) return { rows: [], total: count ?? 0 };

    let mq = crmSupabase.from("daily_manifest").select("*").in("fareharbor_pk", pks).limit(2000);
    if (search?.trim()) {
      mq = mq.or(`customer_name.ilike.%${search.trim()}%,phone.ilike.%${search.trim()}%,fareharbor_pk.ilike.%${search.trim()}%,activity.ilike.%${search.trim()}%`);
    }
    const { data: manifest, error: mErr } = await mq;
    if (mErr) throw mErr;
    const opsByPk      = new Map((ops ?? []).map(o => [o.fareharbor_pk, o]));
    const manifestByPk = new Map((manifest ?? []).map(m => [m.fareharbor_pk, m]));
    let rows = (ops ?? [])
      .map(o => {
        const m = manifestByPk.get(o.fareharbor_pk);
        if (!m) return null; // search may have filtered it out
        const enriched = {
          ...m,
          booked_at:      o.booked_at  ?? o.created_at ?? null,
          guide_name:     o.guide_name ?? null,
          internal_notes: o.internal_notes ?? null,
          prep_completed: o.prep_completed ?? false,
          status:         o.status ?? m.status ?? null,
        };
        enriched.operational_status = deriveOperationalStatus(enriched);
        return enriched;
      })
      .filter(Boolean);
    rows = applySeasonFilter(rows, season);
    return { rows, total: rows.length };
  }

  // ── DIM = "start" (default) — original path: filter date range on start_at
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

  // Pull operational columns from bookings table by fareharbor_pk
  const pks = manifest.map(b => b.fareharbor_pk).filter(Boolean);
  let opsRows = [];
  if (pks.length) {
    const { data: ops } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name,internal_notes,prep_completed,booked_at,created_at")
      .in("fareharbor_pk", pks);
    opsRows = ops ?? [];
  }
  const opsByPk = new Map(opsRows.map(r => [r.fareharbor_pk, r]));

  let rows = manifest.map(b => {
    const ops = opsByPk.get(b.fareharbor_pk) ?? {};
    const enriched = {
      ...b,
      booked_at:      ops.booked_at  ?? ops.created_at ?? null,
      guide_name:     ops.guide_name ?? null,
      internal_notes: ops.internal_notes ?? null,
      prep_completed: ops.prep_completed ?? false,
    };
    enriched.operational_status = deriveOperationalStatus(enriched);
    return enriched;
  });
  rows = applySeasonFilter(rows, season);
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
  const dim    = parseDateDim(req.query);
  const season = parseSeasonFilter(req.query);

  try {
    const today    = windowFor("today");
    const tomorrow = windowFor("tomorrow");
    const primary  = range ? { start: range.start, end: range.end } : today;

    const fetches = [
      fetchBookingsInWindow(crmSupabase, companies, primary.start, primary.end, { limit: 1000, dim, season }),
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

  const filters = parseBookingFilters(req.query);
  const format  = String(req.query.format ?? "json").toLowerCase();
  const dim     = parseDateDim(req.query);
  const season  = parseSeasonFilter(req.query);

  try {
    // For filtered views we need a wider initial pull because the manifest-side
    // count is post-DB-filter only on company/start_at. We then apply filters
    // in-memory on the returned page.
    const pullLimit = format === "csv" ? 2000 : Math.max(limit, 500);
    const { rows, total } = await fetchBookingsInWindow(
      crmSupabase, companies, start, end, { search, limit: pullLimit, offset: 0, dim, season }
    );
    let filtered = applyFilters(rows, filters);
    if (reverse) filtered = filtered.slice().reverse();

    if (format === "csv") {
      const csv = bookingsToCsv(filtered);
      const fname = `bookings_${(label || "range").replace(/[^a-z0-9]+/gi, "_")}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      return res.send(csv);
    }

    // JSON: paginate the filtered set client-side-style
    const page = filtered.slice(offset, offset + limit);
    return res.json({
      bookings: page,
      total: filtered.length,
      total_unfiltered: total,
      tab: label,
      window: { start, end },
      filters,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function bookingsToCsv(rows) {
  const headers = [
    "start_at", "arrival_display", "customer_name", "phone", "activity",
    "location", "company", "pax", "guide_name", "operational_status",
    "waiver_signed", "checked_in", "receipt_total_cents", "amount_paid_cents",
    "balance_due_cents", "agent", "affiliate", "fareharbor_pk",
  ];
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(","));
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/bookings/:pk
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsBookingDetail(req, res, supabase = null, crmSupabase = null) {
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
      .select("guide_name,internal_notes,prep_completed,booked_at,end_at,line_items,raw_payload,booking_notes,customer_id")
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

    // Phase 4B — guest intelligence + revenue breakdown
    const phone = manifestRow.phone ?? null;
    const customerId = opsRow?.customer_id ?? null;
    const [prevBookings, smsHistory] = await Promise.all([
      // Previous bookings for the same customer (excluding this one)
      customerId
        ? crmSupabase.from("bookings")
            .select("fareharbor_pk,start_at,activity_id,receipt_total_cents,status", { count: "exact" })
            .eq("customer_id", customerId)
            .neq("fareharbor_pk", pk)
            .order("start_at", { ascending: false })
            .limit(5)
            .then(r => ({ count: r.count ?? 0, rows: r.data ?? [] }))
        : Promise.resolve({ count: 0, rows: [] }),
      // Recent SMS messages from the customer's phone (DB1 conversations)
      (supabase && phone)
        ? supabase.from("conversations")
            .select("messages,updated_at,client_id")
            .eq("from_number", phone)
            .eq("client_id", clientId)
            .order("updated_at", { ascending: false })
            .limit(1)
            .then(r => {
              const conv = r.data?.[0];
              if (!conv?.messages?.length) return null;
              const recent = conv.messages.slice(-5).map(m => ({
                role: m.role, content: String(m.content ?? "").slice(0, 220), timestamp: m.timestamp,
              }));
              return { last_at: conv.updated_at, recent };
            })
        : Promise.resolve(null),
    ]);

    booking.previous_bookings_count = prevBookings.count;
    booking.previous_bookings       = prevBookings.rows;
    booking.is_repeat_guest         = prevBookings.count > 0;
    booking.sms_history             = smsHistory;
    booking.revenue_breakdown       = buildRevenueBreakdown(opsRow?.raw_payload, manifestRow);

    return res.json({ booking });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildRevenueBreakdown(raw, manifestRow) {
  // Default fallback: just the totals we already have on the manifest row
  const fallback = {
    subtotal_cents:        null,
    tax_cents:             null,
    fees_cents:            null,
    affiliate_fee_cents:   null,
    total_cents:           Number(manifestRow?.receipt_total_cents ?? 0),
    paid_cents:            Number(manifestRow?.amount_paid_cents   ?? 0),
    due_cents:             Number(manifestRow?.balance_due_cents   ?? 0),
    payments:              [],
  };
  if (!raw || typeof raw !== "object") return fallback;

  // FareHarbor raw_payload shape: customers[].total_cost.{tax,price,total,fees,...}
  let subtotal = 0, tax = 0, fees = 0;
  try {
    for (const c of raw.customers ?? []) {
      const t = c?.total_cost ?? {};
      subtotal += Number(t.price ?? 0);
      tax      += Number(t.tax   ?? 0);
      // FH stores per-customer fees inside cost_breakdown / fees if present
      const lineFees = (t.line_items ?? []).filter(li => /fee|surcharge/i.test(li?.name ?? ""));
      for (const li of lineFees) fees += Number(li?.amount ?? 0);
    }
  } catch { /* leave at 0 */ }

  const payments = Array.isArray(raw.payments) ? raw.payments.map(p => ({
    type:        p?.type ?? null,
    status:      p?.status ?? null,
    amount_paid: Number(p?.amount_paid ?? 0),
    created_at:  p?.created_at ?? null,
  })) : [];

  return {
    ...fallback,
    subtotal_cents:      subtotal || null,
    tax_cents:           tax      || null,
    fees_cents:          fees     || null,
    affiliate_fee_cents: null,
    payments,
  };
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

  const season = parseSeasonFilter(req.query ?? {});

  try {
    const { start, end } = windowFor("tomorrow");
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500, season });

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

  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});

  try {
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500, dim, season });

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
  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});

  try {
    let rows = await fetchBookingsForRevenue(
      crmSupabase, companies, start.toISOString(), end.toISOString(), { dim, season }
    );

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

  const range  = parseDateRangeQuery(req.query ?? {});
  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});
  const wantCompare = String(req.query?.compare ?? "").toLowerCase() === "prev";

  try {
    const fetches = [fetchBookingsForRevenue(crmSupabase, companies, range.start, range.end, { dim, season })];
    if (wantCompare) fetches.push(fetchBookingsForRevenue(crmSupabase, companies, range.prev.start, range.prev.end, { dim, season }));
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

async function fetchBookingsForRevenue(crmSupabase, companies, start, end, opts = {}) {
  const { dim = "start", season = null } = opts;

  // ── DIM = "booked" — date filter on bookings.booked_at then enrich
  if (dim === "booked") {
    const { data: ops, error: opsErr } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name,booked_at,created_at")
      .in("company", companies)
      .or(`and(booked_at.gte.${start},booked_at.lt.${end}),and(booked_at.is.null,created_at.gte.${start},created_at.lt.${end})`)
      .limit(2000);
    if (opsErr) throw opsErr;
    const pks = (ops ?? []).map(o => o.fareharbor_pk).filter(Boolean);
    if (!pks.length) return [];

    const { data: manifest } = await crmSupabase
      .from("daily_manifest")
      .select("start_at,activity,location,pax,receipt_total_cents,balance_due_cents,fareharbor_pk,waiver_signed,checked_in,company")
      .in("fareharbor_pk", pks)
      .limit(2000);
    const opsByPk = new Map((ops ?? []).map(o => [o.fareharbor_pk, o]));
    let rows = (manifest ?? []).map(m => ({
      ...m,
      guide_name: opsByPk.get(m.fareharbor_pk)?.guide_name ?? null,
      booked_at:  opsByPk.get(m.fareharbor_pk)?.booked_at ?? opsByPk.get(m.fareharbor_pk)?.created_at ?? null,
    }));
    rows = applySeasonFilter(rows, season);
    return rows;
  }

  // ── DIM = "start" — original path
  const { data: manifest, error } = await crmSupabase
    .from("daily_manifest")
    .select("start_at,activity,location,pax,receipt_total_cents,balance_due_cents,fareharbor_pk,waiver_signed,checked_in,company")
    .in("company", companies)
    .gte("start_at", start)
    .lt("start_at",  end)
    .order("start_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rowsRaw = manifest ?? [];
  if (!rowsRaw.length) return rowsRaw;

  const pks = rowsRaw.map(r => r.fareharbor_pk).filter(Boolean);
  let guideMap = new Map();
  if (pks.length) {
    const { data: ops } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk,guide_name,booked_at,created_at")
      .in("fareharbor_pk", pks);
    guideMap = new Map((ops ?? []).map(o => [o.fareharbor_pk, o]));
  }
  let rows = rowsRaw.map(r => {
    const o = guideMap.get(r.fareharbor_pk);
    return { ...r, guide_name: o?.guide_name ?? null, booked_at: o?.booked_at ?? o?.created_at ?? null };
  });
  rows = applySeasonFilter(rows, season);
  return rows;
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/operations/filter-options
// Returns distinct values for the filter drawer (activity, location, guide,
// status, affiliate, company). Computed from the last 90 days of bookings.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsFilterOptions(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyFilterOptions());

  try {
    // Pull a 90-day window — wide enough to surface all common activities/guides
    const start = startOfDayMtIso(-90);
    const end   = startOfDayMtIso(7);  // include upcoming week so future-only guides surface too

    const [{ data: manifest, error: mErr }, { data: opsRows, error: oErr }] = await Promise.all([
      crmSupabase.from("daily_manifest")
        .select("activity,location,company,fareharbor_pk,affiliate")
        .in("company", companies)
        .gte("start_at", start)
        .lt("start_at",  end)
        .limit(2000),
      crmSupabase.from("bookings")
        .select("guide_name,status,fareharbor_pk")
        .in("company", companies)
        .gte("start_at", start)
        .lt("start_at",  end)
        .limit(2000),
    ]);
    if (mErr) throw mErr;
    if (oErr) throw oErr;

    const activities = uniqSorted((manifest ?? []).map(r => r.activity));
    const locations  = uniqSorted((manifest ?? []).map(r => r.location));
    const compsOut   = uniqSorted((manifest ?? []).map(r => r.company));
    const affiliates = uniqSorted((manifest ?? []).map(r => r.affiliate));
    const guides     = uniqSorted((opsRows  ?? []).map(r => (r.guide_name ?? "").trim()).filter(Boolean));
    const statuses   = uniqSorted((opsRows  ?? []).map(r => r.status));
    return res.json({ activities, locations, companies: compsOut, affiliates, guides, statuses });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function uniqSorted(arr) {
  return [...new Set((arr ?? []).filter(v => v != null && v !== ""))].sort((a, b) => String(a).localeCompare(String(b)));
}

function emptyFilterOptions() {
  return { activities: [], locations: [], companies: [], affiliates: [], guides: [], statuses: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4C — Operations Intelligence
// Aggregates today + tomorrow + 14-day-forward bookings into actionable risk
// signals: staffing risk, waiver risk, inventory load. No new schema required.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleOperationsIntelligence(req, res, _supabase, crmSupabase = null) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM database unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id required" });
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return res.json(emptyIntelligence());

  const season = parseSeasonFilter(req.query ?? {});

  try {
    const todayWindow    = windowFor("today");
    const tomorrowWindow = windowFor("tomorrow");
    const next14End      = startOfDayMtIso(14);

    const [today, tomorrow, next14] = await Promise.all([
      fetchBookingsInWindow(crmSupabase, companies, todayWindow.start, todayWindow.end, { limit: 500, season }),
      fetchBookingsInWindow(crmSupabase, companies, tomorrowWindow.start, tomorrowWindow.end, { limit: 500, season }),
      fetchBookingsInWindow(crmSupabase, companies, todayWindow.start, next14End, { limit: 1000, season }),
    ]);

    // Waiver risk: bookings within next 2h missing waivers
    const now = Date.now();
    const waiverRisk = today.rows.filter(b => {
      const startMs = new Date(b.start_at).getTime();
      return startMs >= now - 30 * 60_000 && startMs <= now + 2 * 3600_000 && b.waiver_signed === false;
    }).map(b => ({
      fareharbor_pk: b.fareharbor_pk, customer_name: b.customer_name, phone: b.phone,
      activity: b.activity, start_at: b.start_at, pax: b.pax,
    }));

    // Staffing risk: count tomorrow + next 7 weekend days, surface unassigned guide load
    const tomorrowUnassigned = tomorrow.rows.filter(b => !b.guide_name);
    const weekendForward = next14.rows.filter(b => {
      const t = new Date(b.start_at);
      const dow = t.getUTCDay();
      return (dow === 0 || dow === 6) && t.getTime() > now;
    });
    const weekendUnassigned = weekendForward.filter(b => !b.guide_name);
    const staffingFlags = [];
    if (tomorrowUnassigned.length >= 3) {
      staffingFlags.push({
        severity: "warn",
        label: `${tomorrowUnassigned.length} bookings tomorrow without an assigned guide`,
      });
    }
    if (weekendUnassigned.length >= 5) {
      staffingFlags.push({
        severity: "warn",
        label: `${weekendUnassigned.length} weekend bookings (next 14 days) without an assigned guide`,
      });
    }

    // Inventory load by activity: pax_total / activity_count_in_window
    // Treat "vehicles" as customer_count proxy (we don't have a true inventory cap yet)
    const inventory = new Map();
    for (const b of next14.rows) {
      const a = b.activity ?? "Unknown";
      const cur = inventory.get(a) ?? { activity: a, bookings: 0, pax: 0 };
      cur.bookings += 1;
      cur.pax      += Number(b.pax ?? 1);
      inventory.set(a, cur);
    }
    const inventoryRows = [...inventory.values()].sort((a, b) => b.pax - a.pax).slice(0, 10);

    return res.json({
      generated_at: new Date().toISOString(),
      waiver_risk: { count: waiverRisk.length, bookings: waiverRisk },
      staffing: {
        tomorrow_unassigned:  tomorrowUnassigned.length,
        weekend_total:        weekendForward.length,
        weekend_unassigned:   weekendUnassigned.length,
        flags:                staffingFlags,
      },
      inventory_load: inventoryRows,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyIntelligence() {
  return {
    generated_at: new Date().toISOString(),
    waiver_risk: { count: 0, bookings: [] },
    staffing: { tomorrow_unassigned: 0, weekend_total: 0, weekend_unassigned: 0, flags: [] },
    inventory_load: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4C — AI Insights (Claude-generated, 24h cached per client)
// GET  /portal/api/operations/ai-insights         — read-through cache
// POST /portal/api/operations/ai-insights/refresh — force regeneration
// ─────────────────────────────────────────────────────────────────────────────
const AI_CACHE_TTL_MS = 24 * 3600_000;
const AI_INSIGHTS_MODEL = "claude-haiku-4-5-20251001";

export async function handleOperationsAiInsights(req, res, supabase, crmSupabase, anthropic) {
  if (!supabase || !crmSupabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });
  const force = req.method === "POST";
  if (force && !req.portalUser?.isClientAdmin) return res.status(403).json({ error: "Admin access required" });

  try {
    // 1. Cache lookup
    if (!force) {
      const { data: cached } = await supabase
        .from("ops_ai_insights")
        .select("insights,generated_at")
        .eq("client_id", clientId)
        .order("generated_at", { ascending: false })
        .limit(1);
      const top = cached?.[0];
      if (top && Date.now() - new Date(top.generated_at).getTime() < AI_CACHE_TTL_MS) {
        return res.json({ ...top.insights, generated_at: top.generated_at, cached: true });
      }
    }

    if (!anthropic) return res.status(503).json({ error: "Claude API unavailable" });

    // 2. Build context: a compact JSON summary of last 30 days + tomorrow + forecast
    const ctx = await buildInsightsContext(crmSupabase, clientId);
    if (!ctx) return res.json({ headline: null, bullets: [], generated_at: new Date().toISOString(), cached: false });

    // 3. Prompt Claude Haiku for 4-6 operator-facing observations
    const systemPrompt = `You are an analyst writing concise operator-facing observations for an outdoor adventure company's operations dashboard. Read the JSON data and return EXACTLY 4-6 short bullets (each <= 140 chars) that surface non-obvious patterns about pacing, staffing risk, revenue mix, or operational risk. Avoid generic statements ("revenue is good"). Each bullet must be specific to the data. Output JSON only: { "headline": "<one sentence summary>", "bullets": ["...", "..."] }`;

    let parsed = { headline: null, bullets: [] };
    try {
      const response = await anthropic.messages.create({
        model:      AI_INSIGHTS_MODEL,
        max_tokens: 500,
        system:     systemPrompt,
        messages: [{ role: "user", content: `OPERATIONS DATA (JSON):\n${JSON.stringify(ctx)}` }],
      });
      const raw = response?.content?.[0]?.text ?? "{}";
      // Strip code fences if Claude wrapped them
      const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj === "object") {
        parsed.headline = typeof obj.headline === "string" ? obj.headline.slice(0, 280) : null;
        parsed.bullets  = Array.isArray(obj.bullets)
          ? obj.bullets.filter(b => typeof b === "string").slice(0, 6).map(b => b.slice(0, 200))
          : [];
      }
    } catch (e) {
      console.error("[ai-insights] Claude error:", e.message);
      return res.status(500).json({ error: "ai generation failed" });
    }

    // 4. Persist
    const insights = { ...parsed, model: AI_INSIGHTS_MODEL, prompt_window: ctx.window };
    await supabase.from("ops_ai_insights").insert({
      client_id: clientId,
      insights,
    });

    return res.json({ ...insights, generated_at: new Date().toISOString(), cached: false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function buildInsightsContext(crmSupabase, clientId) {
  const companies = resolveCompanyShortnames(clientId);
  if (!companies.length) return null;

  const last30Start = startOfDayMtIso(-30);
  const todayStart  = startOfDayMtIso(0);
  const next14End   = startOfDayMtIso(14);

  const [past30, upcoming14] = await Promise.all([
    fetchBookingsForRevenue(crmSupabase, companies, last30Start, todayStart),
    fetchBookingsForRevenue(crmSupabase, companies, todayStart,  next14End),
  ]);

  const totals30 = totalsFor(past30);
  const byActivity30 = groupBy(past30, "activity").slice(0, 5).map(({ name, bookings, pax, revenue_cents }) => ({ name, bookings, pax, revenue_cents }));
  const byLocation30 = groupBy(past30, "location").slice(0, 5).map(({ name, bookings, pax, revenue_cents }) => ({ name, bookings, pax, revenue_cents }));
  const byGuide30    = groupByGuide(past30).slice(0, 5).map(({ name, bookings, pax, revenue_cents }) => ({ name, bookings, pax, revenue_cents }));
  const dow          = bestDayOfWeek(past30);

  // Upcoming snapshot: counts, weekend share, unassigned guides
  const totalsUp = totalsFor(upcoming14);
  const weekendUp = upcoming14.filter(r => {
    const dow = new Date(r.start_at).getUTCDay();
    return dow === 0 || dow === 6;
  });
  const unassignedUp = upcoming14.filter(r => !r.guide_name).length;

  return {
    window: { past_days: 30, upcoming_days: 14, generated_at: new Date().toISOString() },
    last_30_days: {
      ...totals30,
      best_day_of_week: dow,
      top_activities: byActivity30,
      top_locations:  byLocation30,
      top_guides:     byGuide30,
    },
    next_14_days: {
      bookings:           upcoming14.length,
      pax:                totalsUp.pax,
      revenue_cents:      totalsUp.revenue_cents,
      weekend_bookings:   weekendUp.length,
      unassigned_guides:  unassignedUp,
    },
  };
}

function emptyForecast() {
  return {
    month: null, mtd: null, booked_in_month: null, last_month: null,
    projected_revenue_cents: 0, projected_bookings: 0,
    revenue_pacing_pct: null, bookings_pacing_pct: null,
    weekend_load: { next_14_days_bookings: 0, next_14_days_pax: 0, unassigned_guides: 0 },
  };
}
