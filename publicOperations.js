// ─────────────────────────────────────────────────────────────────────────────
// publicOperations.js — Public (no-auth) read-only operator dashboards
//
// All routes accept a share token in the URL path. The token is looked up in
// operations_share_links (DB1) and validated for revocation/expiration before
// any data is returned.
//
// The token resolves to a client_id; from there we reuse the same per-client
// helpers used by the authenticated portal routes (resolveCompanyShortnames,
// fetchBookingsInWindow, windowFor, summarize) so public and portal views see
// the same data shape.
//
// Routes:
//   GET /public/api/operator-dashboard/:token/summary
//   GET /public/api/operator-dashboard/:token/bookings?tab=…
//   GET /public/api/operator-dashboard/:token/tomorrow-prep
//   GET /public/api/operator-dashboard/:token/guides?tab=…
//   GET /public/api/operator-dashboard/:token/analytics?days=…
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveCompanyShortnames,
  fetchBookingsInWindow,
  windowFor,
  summarize,
  computeAndSendAnalytics,
  computeAndSendRevenue,
  computeAndSendForecast,
  parseDateDim,
  parseSeasonFilter,
  parseDateRangeQuery,
} from "./adminOperations.js";

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN RESOLUTION
// Returns { clientId } on success, or null after sending the error response.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveShareToken(req, res, supabase) {
  if (!supabase) { res.status(503).json({ error: "DB unavailable" }); return null; }
  const token = String(req.params.token ?? "").trim();
  if (!token) { res.status(400).json({ error: "token required" }); return null; }

  const { data, error } = await supabase
    .from("operations_share_links")
    .select("client_id,revoked_at,expires_at")
    .eq("token", token)
    .maybeSingle();
  if (error)  { res.status(500).json({ error: error.message }); return null; }
  if (!data)  { res.status(404).json({ error: "link not found" }); return null; }
  if (data.revoked_at) { res.status(410).json({ error: "link revoked" }); return null; }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    res.status(410).json({ error: "link expired" }); return null;
  }
  return { clientId: data.client_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /public/api/operator-dashboard/:token/summary
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicSummary(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });

  const companies = resolveCompanyShortnames(auth.clientId);
  if (!companies.length) {
    return res.json({ today: emptyKpis(), tomorrow: emptyKpis(), arriving_next: [] });
  }

  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});
  const hasRange = !!(req.query?.range || (req.query?.start && req.query?.end));
  const range  = hasRange ? parseDateRangeQuery(req.query) : null;

  try {
    const today    = windowFor("today");
    const tomorrow = windowFor("tomorrow");
    const primary  = range ? { start: range.start, end: range.end } : today;
    const [t, tm]  = await Promise.all([
      fetchBookingsInWindow(crmSupabase, companies, primary.start, primary.end, { limit: 1000, dim, season }),
      fetchBookingsInWindow(crmSupabase, companies, tomorrow.start, tomorrow.end, { limit: 500 }),
    ]);

    const arrivingNext = t.rows
      .filter(b => !b.checked_in && b.start_at && new Date(b.start_at).getTime() >= Date.now() - 30 * 60_000)
      .slice(0, 8)
      .map(b => ({
        fareharbor_pk:   b.fareharbor_pk,
        customer_name:   b.customer_name,
        activity:        b.activity,
        pax:             b.pax,
        start_at:        b.start_at,
        arrival_display: b.arrival_display,
        waiver_signed:   b.waiver_signed,
        checked_in:      b.checked_in,
        operational_status: b.operational_status,
      }));

    return res.json({
      today:    summarize(t.rows),
      tomorrow: summarize(tm.rows),
      arriving_next: arrivingNext,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function emptyKpis() {
  return { bookings: 0, pax: 0, revenue_cents: 0, missing_waivers: 0, pending_checkins: 0, unpaid_balance_cents: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /public/api/operator-dashboard/:token/bookings?tab=…
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicBookings(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });

  const companies = resolveCompanyShortnames(auth.clientId);
  if (!companies.length) return res.json({ bookings: [], total: 0 });

  const tab = String(req.query.tab ?? "today").toLowerCase();
  if (!["today", "tomorrow", "week", "past"].includes(tab)) {
    return res.status(400).json({ error: "invalid tab" });
  }

  const search = String(req.query.search ?? "");
  const limit  = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});

  try {
    const { start, end } = windowFor(tab);
    const { rows, total } = await fetchBookingsInWindow(
      crmSupabase, companies, start, end, { search, limit, offset, dim, season }
    );
    if (tab === "past") rows.reverse();
    return res.json({ bookings: rows, total, tab, window: { start, end } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /public/api/operator-dashboard/:token/tomorrow-prep
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicTomorrowPrep(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });

  const companies = resolveCompanyShortnames(auth.clientId);
  if (!companies.length) return res.json({ total_bookings: 0, total_pax: 0, by_activity: [], by_location: [], open_issues: { missing_waivers: 0, unpaid_bookings: 0, unassigned_guides: 0 }, prep_completed: 0, prep_remaining: 0 });

  const season = parseSeasonFilter(req.query ?? {});

  try {
    const { start, end } = windowFor("tomorrow");
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500, season });

    const byActivity = new Map(), byLocation = new Map();
    let totalPax = 0, missingW = 0, unpaid = 0, unassigned = 0, prepDone = 0;
    for (const b of rows) {
      const a = b.activity ?? "Unknown", l = b.location ?? "—";
      byActivity.set(a, (byActivity.get(a) ?? { bookings: 0, pax: 0 }));
      byActivity.get(a).bookings += 1; byActivity.get(a).pax += Number(b.pax ?? 1);
      byLocation.set(l, (byLocation.get(l) ?? { bookings: 0, pax: 0 }));
      byLocation.get(l).bookings += 1; byLocation.get(l).pax += Number(b.pax ?? 1);
      totalPax += Number(b.pax ?? 1);
      if (b.waiver_signed === false)            missingW   += 1;
      if (Number(b.balance_due_cents ?? 0) > 0) unpaid     += 1;
      if (!b.guide_name)                        unassigned += 1;
      if (b.prep_completed === true)            prepDone   += 1;
    }

    return res.json({
      window: { start, end },
      total_bookings: rows.length, total_pax: totalPax,
      open_issues: { missing_waivers: missingW, unpaid_bookings: unpaid, unassigned_guides: unassigned },
      prep_completed: prepDone, prep_remaining: rows.length - prepDone,
      by_activity: [...byActivity.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.pax - a.pax),
      by_location: [...byLocation.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.pax - a.pax),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /public/api/operator-dashboard/:token/guides?tab=…
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicGuides(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });

  const companies = resolveCompanyShortnames(auth.clientId);
  if (!companies.length) return res.json({ guides: [], unassigned: { bookings: 0, pax: 0 } });

  const tab = String(req.query.tab ?? "today").toLowerCase();
  if (!["today", "tomorrow", "week"].includes(tab)) {
    return res.status(400).json({ error: "invalid tab" });
  }

  const dim    = parseDateDim(req.query ?? {});
  const season = parseSeasonFilter(req.query ?? {});

  try {
    const { start, end } = windowFor(tab);
    const { rows } = await fetchBookingsInWindow(crmSupabase, companies, start, end, { limit: 500, dim, season });
    const byGuide = new Map();
    let unBookings = 0, unPax = 0;
    for (const b of rows) {
      const g = (b.guide_name ?? "").trim(), pax = Number(b.pax ?? 1);
      if (!g) { unBookings += 1; unPax += pax; continue; }
      if (!byGuide.has(g)) byGuide.set(g, { name: g, bookings: 0, pax: 0 });
      byGuide.get(g).bookings += 1; byGuide.get(g).pax += pax;
    }
    return res.json({
      tab,
      guides: [...byGuide.values()].sort((a, b) => b.pax - a.pax),
      unassigned: { bookings: unBookings, pax: unPax },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /public/api/operator-dashboard/:token/analytics?days=…
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicAnalytics(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });
  return computeAndSendAnalytics(req, res, crmSupabase, auth.clientId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4A — public mirrors of revenue + forecast
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePublicRevenue(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });
  return computeAndSendRevenue(req, res, crmSupabase, auth.clientId);
}

export async function handlePublicForecast(req, res, supabase, crmSupabase) {
  const auth = await resolveShareToken(req, res, supabase);
  if (!auth) return;
  if (!crmSupabase) return res.status(503).json({ error: "CRM unavailable" });
  return computeAndSendForecast(req, res, crmSupabase, auth.clientId);
}
