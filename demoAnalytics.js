// ─────────────────────────────────────────────────────────────────────────────
// DEMO ANALYTICS — Lightweight funnel event tracking for Highmark demo
//
// trackDemoEvent() is the only write path — called from demoFlow.js.
// All writes are fire-and-forget (never awaited by callers) so a slow DB
// or full table never impacts demo response latency.
//
// Admin read routes:
//   GET /admin/demo-analytics/summary  — funnel totals + conversion rates
//   GET /admin/demo-analytics/events   — recent raw events (latest-first)
//
// Schema: demo_events table in DB1 — see db1_demo_analytics.sql
//
// To add a new tracked event:
//   1. Call trackDemoEvent({ eventName: "your_event_name", ... }) at the point
//      in demoFlow.js where the event occurs.
//   2. Document the event name in db1_demo_analytics.sql comments.
//   3. Add a test assertion in test32 if needed.
//   No schema changes required.
// ─────────────────────────────────────────────────────────────────────────────

// ── Write helper ──────────────────────────────────────────────────────────────
// Safe to call without await — errors are logged but never thrown.

export async function trackDemoEvent(supabase, {
  eventName,
  fromNumber  = null,
  clientId    = "highmark_demo",
  demoPath    = null,
  stepKey     = null,
  vertical    = null,
  subtypeKey  = null,
  source      = "sms",
  metadata    = null,
} = {}) {
  if (!supabase) return; // no-op when supabase unavailable (TEST_MODE without DB)
  try {
    await supabase.from("demo_events").insert({
      event_name:  eventName,
      client_id:   clientId,
      from_number: fromNumber,
      demo_path:   demoPath   ?? null,
      step_key:    stepKey    ?? null,
      vertical:    vertical   ?? null,
      subtype_key: subtypeKey ?? null,
      source,
      metadata:    metadata   ?? null,
    });
  } catch (err) {
    // Never throw — analytics must never break the demo flow
    console.error(`[ANALYTICS] trackDemoEvent(${eventName}) failed:`, err.message);
  }
}

// ── Summary endpoint ──────────────────────────────────────────────────────────
// GET /admin/demo-analytics/summary
// Optional query params: since=YYYY-MM-DD
//
// Returns:
// {
//   period, totals{event→count}, path_breakdown{1→n,2→n,3→n},
//   vertical_breakdown{outdoor→n,...}, subtype_breakdown{bike→n,...},
//   source_breakdown{sms→n,ui→n},
//   conversion_rates{started_to_cta, started_to_lead, cta_to_lead}
// }

export async function handleDemoAnalyticsSummary(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "No DB connection" });

  const { since } = req.query;

  try {
    let query = supabase
      .from("demo_events")
      .select("event_name, demo_path, vertical, subtype_key, source");

    if (since) query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];

    // Aggregate
    const totals           = {};
    const pathCounts       = {};
    const verticalCounts   = {};
    const subtypeCounts    = {};
    const sourceCounts     = {};

    for (const row of rows) {
      totals[row.event_name] = (totals[row.event_name] || 0) + 1;
      if (row.demo_path    != null) pathCounts[row.demo_path]         = (pathCounts[row.demo_path]         || 0) + 1;
      if (row.vertical)             verticalCounts[row.vertical]      = (verticalCounts[row.vertical]      || 0) + 1;
      if (row.subtype_key)          subtypeCounts[row.subtype_key]    = (subtypeCounts[row.subtype_key]    || 0) + 1;
      if (row.source)               sourceCounts[row.source]          = (sourceCounts[row.source]          || 0) + 1;
    }

    const started      = totals.demo_started              || 0;
    const ctaShown     = totals.demo_cta_shown            || 0;
    const leadCaptured = totals.demo_lead_captured        || 0;

    const pct = (n, d) => d > 0 ? `${Math.round(n / d * 100)}%` : "n/a";

    res.json({
      period: since ? `since ${since}` : "all_time",
      totals,
      path_breakdown:    pathCounts,
      vertical_breakdown: verticalCounts,
      subtype_breakdown:  subtypeCounts,
      source_breakdown:   sourceCounts,
      conversion_rates: {
        started_to_cta:  pct(ctaShown,     started),
        started_to_lead: pct(leadCaptured, started),
        cta_to_lead:     pct(leadCaptured, ctaShown),
      },
    });
  } catch (err) {
    console.error("[ANALYTICS] summary error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Events listing endpoint ───────────────────────────────────────────────────
// GET /admin/demo-analytics/events
// Optional query params: event_name, demo_path, source, since, limit (max 200)
//
// Returns: { events: [...], count: n }

export async function handleDemoAnalyticsEvents(req, res, supabase) {
  if (!supabase) return res.json({ events: [], count: 0 });

  const limit      = Math.min(parseInt(req.query.limit) || 50, 200);
  const { event_name, demo_path, source, since } = req.query;

  try {
    let query = supabase
      .from("demo_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (event_name) query = query.eq("event_name", event_name);
    if (demo_path)  query = query.eq("demo_path", parseInt(demo_path, 10));
    if (source)     query = query.eq("source", source);
    if (since)      query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) throw error;

    const events = data || [];
    res.json({ events, count: events.length });
  } catch (err) {
    console.error("[ANALYTICS] events error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
