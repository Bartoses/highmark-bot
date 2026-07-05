// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PORTAL — Client portal API handlers (Chunk 10)
//
// All handlers require req.portalUser (set by requirePortalAuth middleware).
// Client scoping is enforced via resolvePortalClientId(req) on every handler.
//
// Routes (registered in index.js):
//   GET  /portal/api/me
//   GET  /portal/api/dashboard
//   GET  /portal/api/leads
//   PATCH /portal/api/leads/:id
//   GET  /portal/api/campaigns
//   POST /portal/api/campaigns
//   GET  /portal/api/campaigns/:id
//   PATCH /portal/api/campaigns/:id
//   POST /portal/api/campaigns/:id/send
//   GET  /portal/api/analytics
//   GET  /portal/api/settings
//   PATCH /portal/api/settings
//
// Admin-only (protected by requireUiAccess, not JWT):
//   POST /admin/portal-users
//   GET  /admin/portal-users
// ─────────────────────────────────────────────────────────────────────────────

import { resolvePortalClientId } from "./portalAuth.js";
import { getAllClients, loadDbClients } from "./clients.js";
import { getIntegrationStatus, syncFhForClient } from "./knowledgeBase.js";
import { createCampaign, enqueueCampaign, getCampaignStats, selectAudience } from "./campaigns.js";
import { VALID_BOOKING_MODES, serializeClient, handleCreateClient, handleUpdateClient } from "./adminClients.js";
import { normalizePhone, isValidPhone, isTestPhone } from "./phoneUtils.js";
import { startAutoConfig, getDraft, updateDraft, commitDraftToDb, createClientFromWebsite, buildNextSteps } from "./onboardingConfig.js";
import {
  createIntegration, updateIntegration, deleteIntegration,
  getClientIntegrations, testEndpoint, sanitizeForPortal,
} from "./apiIntegrations.js";
import { runOptimizationAnalysis, getOptimizationInsights, dismissInsight } from "./optimizationEngine.js";
import { runRewriteGeneration, getRewriteSuggestions, updateRewriteStatus } from "./rewriteEngine.js";
import { getAttributionData, getPerformanceData } from "./webEvents.js";

const VALID_SOURCE_TYPES = ["website", "faq", "booking", "policies", "blog"];

const VALID_LEAD_STATUSES = ["new", "contacted", "engaged", "scheduled", "converted", "closed", "ignored"];

// Safe client fields a portal user can edit (DB-backed clients only).
// Text fields — values passed through as-is.
const EDITABLE_SETTINGS = {
  name:                    "name",
  bot_name:                "bot_name",
  tone:                    "tone",
  support_phone:           "support_phone",
  support_email:           "support_email",
  lead_notification_phone: "lead_notification_phone",
  owner_phone:             "owner_phone",
  website_url:             "website_url",
  booking_link:            "booking_link",
  booking_mode:            "booking_mode",
  hours:                   "hours",
  timezone:                "timezone",
  // Twilio routing fields (db1_twilio_config.sql)
  outbound_phone:          "outbound_phone",
  messaging_service_sid:   "messaging_service_sid",
  twilio_account_sid:      "twilio_account_sid",
  twilio_auth_token:       "twilio_auth_token",
};

// Boolean feature toggles — validated separately to ensure boolean type.
const EDITABLE_TOGGLES = [
  "campaigns_enabled",
  "followups_enabled",
  "fareharbor_enabled",
  "human_handoff_enabled",
  "lead_capture_enabled",
  "waitlist_enabled",
];

// Guard: mutating operations (settings PATCH, campaign create/edit/send) require client_admin+.
function requireClientAdmin(req, res) {
  if (!req.portalUser?.isClientAdmin) {
    res.status(403).json({ error: "Admin access required — client_admin or internal_admin role needed" });
    return false;
  }
  return true;
}

// ── GET /portal/api/clients ───────────────────────────────────────────────────
// internal_admin: returns all active clients
//   ?detailed=true → full serialized client objects (for Clients section)
//   default        → slim {id, name, bookingMode} (for client selector dropdown)
// client_user / client_admin: returns only their own client (always slim)
export async function handlePortalClients(req, res) {
  const { portalUser } = req;
  const clients = getAllClients();
  const detailed = req.query.detailed === "true";

  if (portalUser.role === "internal_admin") {
    const all = Object.values(clients)
      .filter(c => c.active !== false)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    if (detailed) {
      return res.json({ clients: all.map(serializeClient) });
    }
    return res.json({ clients: all.map(c => ({ id: c.id, name: c.name, bookingMode: c.bookingMode })) });
  }

  // client_user / client_admin — only their own
  const c = clients[portalUser.clientId];
  if (!c) return res.status(404).json({ error: "Client not found" });
  return res.json({ clients: [{ id: c.id, name: c.name, bookingMode: c.bookingMode }] });
}

// ── POST /portal/api/clients ──────────────────────────────────────────────────
// internal_admin only — delegates to handleCreateClient
export async function handlePortalCreateClient(req, res, supabase) {
  if (!req.portalUser?.isAdmin) return res.status(403).json({ error: "Internal admin only" });
  return handleCreateClient(req, res, supabase);
}

// ── PATCH /portal/api/clients/:id ─────────────────────────────────────────────
// internal_admin only.
// DB-backed clients: delegates to handleUpdateClient (full field set).
// Static clients:    auto-promotes to DB via handlePortalUpdateSettings (seeds from static config first).
export async function handlePortalUpdateClient(req, res, supabase) {
  if (!req.portalUser?.isAdmin) return res.status(403).json({ error: "Internal admin only" });
  const client = getAllClients()[req.params.id];
  if (!client) return res.status(404).json({ error: "Client not found" });
  if (!client._fromDb) {
    // Shim client_id into query so resolvePortalClientId picks it up, then auto-seed + update
    req.query = { ...req.query, client_id: req.params.id };
    return handlePortalUpdateSettings(req, res, supabase);
  }
  return handleUpdateClient(req, res, supabase);
}

// ── GET /portal/api/me ────────────────────────────────────────────────────────
export async function handlePortalMe(req, res) {
  const { portalUser } = req;
  const clients    = getAllClients();
  const clientName = portalUser.clientId ? (clients[portalUser.clientId]?.name ?? portalUser.clientId) : null;
  return res.json({
    email:         portalUser.email,
    role:          portalUser.role,
    clientId:      portalUser.clientId,
    clientName,
    isAdmin:       portalUser.role === "internal_admin",
    isClientAdmin: portalUser.isClientAdmin ?? false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard helpers
// ─────────────────────────────────────────────────────────────────────────────
function periodToSince(period) {
  if (!period || period === "all") return null;
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function calcTimeSaved(totalConversations) {
  // Each conversation saves ~4 minutes of staff time
  return Math.round((totalConversations * 4) / 60 * 10) / 10;
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0)               return "just now";
  if (diff < 60_000)          return "just now";
  if (diff < 3_600_000)       return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)      return `${Math.round(diff / 3_600_000)}h ago`;
  const days = Math.round(diff / 86_400_000);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

// ── GET /portal/api/dashboard ─────────────────────────────────────────────────
// Query params: period=7d|30d|90d|all (default 30d)
export async function handlePortalDashboard(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const period = ["7d","30d","90d","all"].includes(req.query.period) ? req.query.period : "30d";
  const since  = periodToSince(period);

  const clients      = getAllClients();
  const clientRow    = clients[clientId];
  const clientName   = clientRow?.name ?? clientId;
  const avgBkgValue  = clientRow?.avgBookingValue ?? 175;
  const twilioNumber = clientRow?.inboundPhones?.[0] ?? null;

  // Operators (staff) are never customers — keep them out of the funnel counts.
  let opInList = null;
  try {
    const { getOperatorPhoneSet } = await import("./operatorBriefing.js");
    const opSet = await getOperatorPhoneSet(clientId, supabase);
    if (opSet.size) opInList = "(" + [...opSet].map((p) => `"${String(p).replace(/"/g, "")}"`).join(",") + ")";
  } catch { /* non-fatal */ }
  const dropTestLeads = process.env.TEST_MODE !== "true";
  // Exclude operators + (in prod) synthetic 555/999 test numbers from lead stats.
  const exOps = (q) => {
    if (opInList) q = q.not("contact_phone", "in", opInList);
    if (dropTestLeads) q = q.not("contact_phone", "ilike", "+1555%").not("contact_phone", "ilike", "+1999%");
    return q;
  };
  // Same for conversation queries — keep test-phone convos out of the ROI/time-saved
  // counts (web: sessions are unaffected; the filter only matches phone from_numbers).
  const exTestConv = (q) =>
    dropTestLeads ? q.not("from_number", "ilike", "+1555%").not("from_number", "ilike", "+1999%") : q;

  // ── Run all queries in parallel ──────────────────────────────────────────
  const [
    smsR, webR, periodConvR,
    periodLeadsR, bookingClkR,
    actConvR, actLeadsR, actWebR,
    checklistR,
  ] = await Promise.allSettled([
    // All-time SMS conversations
    exTestConv(supabase.from("conversations").select("*", { count: "exact", head: true })
      .eq("client_id", clientId).neq("session_type", "test")
      .not("from_number", "like", "web:%")),

    // All-time web conversations
    supabase.from("conversations").select("*", { count: "exact", head: true })
      .eq("client_id", clientId).neq("session_type", "test")
      .like("from_number", "web:%"),

    // Period-filtered conversations
    (() => {
      let q = exTestConv(supabase.from("conversations").select("*", { count: "exact", head: true })
        .eq("client_id", clientId).neq("session_type", "test"));
      if (since) q = q.gte("updated_at", since);
      return q;
    })(),

    // Period-filtered leads (all, for funnel counts) — operators excluded
    (() => {
      let q = exOps(supabase.from("leads").select("status")
        .eq("client_id", clientId).limit(1000));
      if (since) q = q.gte("created_at", since);
      return q;
    })(),

    // Period-filtered booking clicks
    (() => {
      let q = supabase.from("web_events").select("*", { count: "exact", head: true })
        .eq("client_id", clientId).eq("event_type", "booking_clicked");
      if (since) q = q.gte("created_at", since);
      return q;
    })(),

    // Activity: recent conversations
    exTestConv(supabase.from("conversations")
      .select("id, from_number, handoff, updated_at")
      .eq("client_id", clientId).neq("session_type", "test")
      .order("updated_at", { ascending: false }).limit(20)),

    // Activity: recent leads — operators excluded
    exOps(supabase.from("leads").select("id, status, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }).limit(10)),

    // Activity: recent web events
    supabase.from("web_events").select("id, event_type, page_url, created_at")
      .eq("client_id", clientId)
      .in("event_type", ["booking_clicked", "lead_captured"])
      .order("created_at", { ascending: false }).limit(10),

    // Checklist dismissed + Sprint 7 onboarding state (non-fatal if columns missing)
    supabase.from("clients").select("dashboard_checklist_dismissed, onboarding_status, bot_mode, inbound_phones")
      .eq("id", clientId).maybeSingle(),
  ]);

  // ── Totals ───────────────────────────────────────────────────────────────
  const smsCount     = smsR.status === "fulfilled"      ? (smsR.value.count       ?? 0) : 0;
  const webCount     = webR.status === "fulfilled"      ? (webR.value.count       ?? 0) : 0;
  const totalConvos  = smsCount + webCount;
  const periodConvos = periodConvR.status === "fulfilled" ? (periodConvR.value.count ?? 0) : 0;
  const bookingClicks = bookingClkR.status === "fulfilled" ? (bookingClkR.value.count ?? 0) : 0;
  const timeSavedHours = calcTimeSaved(totalConvos);
  const estRevenue   = bookingClicks * avgBkgValue;

  // ── Lead funnel ───────────────────────────────────────────────────────────
  const leadsData     = periodLeadsR.status === "fulfilled" ? (periodLeadsR.value.data ?? []) : [];
  const leadsTotal    = leadsData.length;
  const leadsEngaged  = leadsData.filter(l => ["engaged","converted","closed","scheduled"].includes(l.status)).length;
  const leadsConverted = leadsData.filter(l => l.status === "converted").length;

  const leadsPct     = periodConvos > 0 ? Math.min(100, Math.round(leadsTotal    / periodConvos * 100)) : 0;
  const engagedPct   = leadsTotal   > 0 ? Math.min(100, Math.round(leadsEngaged  / leadsTotal   * 100)) : 0;
  const convertedPct = leadsEngaged > 0 ? Math.min(100, Math.round(leadsConverted / leadsEngaged * 100)) : 0;

  // ── Activity feed ─────────────────────────────────────────────────────────
  const actItems = [];
  const convRows = actConvR.status  === "fulfilled" ? (actConvR.value.data  ?? []) : [];
  const leadRows = actLeadsR.status === "fulfilled" ? (actLeadsR.value.data ?? []) : [];
  const webRows  = actWebR.status   === "fulfilled" ? (actWebR.value.data   ?? []) : [];

  for (const c of convRows) {
    const channel = c.from_number?.startsWith("web:") ? "web" : "sms";
    const ts      = c.updated_at ?? "";
    if (c.handoff) {
      actItems.push({ type: "handoff", channel, label: "Handoff — guest needs agent follow-up", ts, relative: relativeTime(ts) });
    } else {
      actItems.push({ type: "new_conversation", channel, label: `New ${channel === "web" ? "web chat" : "SMS"} conversation`, ts, relative: relativeTime(ts) });
    }
  }
  for (const l of leadRows) {
    const ts = l.created_at ?? "";
    actItems.push({ type: "lead_captured", channel: "sms", label: "Lead captured", ts, relative: relativeTime(ts) });
  }
  for (const e of webRows) {
    const ts   = e.created_at ?? "";
    const page = e.page_url   ? ` on ${e.page_url}` : "";
    if (e.event_type === "booking_clicked") {
      actItems.push({ type: "booking_click", channel: "web", label: `Booking link clicked${page}`, ts, relative: relativeTime(ts) });
    } else {
      actItems.push({ type: "lead_captured", channel: "web", label: "Lead captured via web chat", ts, relative: relativeTime(ts) });
    }
  }
  actItems.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
  const activity = actItems.slice(0, 10);

  // ── Checklist + Sprint 7 onboarding banners ──────────────────────────────
  const checklistData      = checklistR.status === "fulfilled" ? (checklistR.value.data ?? {}) : {};
  const checklistDismissed = checklistData.dashboard_checklist_dismissed ?? false;
  const onboardingStatus   = checklistData.onboarding_status ?? "live";
  const botMode            = checklistData.bot_mode ?? "live";
  const dbInboundPhones    = checklistData.inbound_phones ?? [];
  const hasInboundPhone    = dbInboundPhones.length > 0 || (twilioNumber !== null && twilioNumber !== undefined);

  // Banner kinds (the portal SPA decides how to render):
  //   "twilio_pending"  — client created but no Twilio number assigned yet
  //   "test_mode"       — Twilio number is wired but bot is still in test mode
  //   null              — no banner needed
  let onboardingBanner = null;
  if (!hasInboundPhone && (onboardingStatus === "created" || onboardingStatus === "configured" || onboardingStatus === "ready")) {
    onboardingBanner = {
      kind:    "twilio_pending",
      title:   "Your bot is being set up",
      message: "We're assigning your Twilio number — usually within 1 business day. We'll text you when it's live.",
    };
  } else if (hasInboundPhone && botMode === "test") {
    onboardingBanner = {
      kind:    "test_mode",
      title:   "Bot is in test mode",
      message: "Send a text to your Twilio number to try it out. When you're ready, switch to live in Settings.",
    };
  }

  return res.json({
    clientId,
    clientName,
    period,
    twilio_number:        twilioNumber,
    total_conversations:  totalConvos,
    sms_count:            smsCount,
    web_count:            webCount,
    time_saved_hours:     timeSavedHours,
    period_conversations: periodConvos,
    leads:                leadsTotal,
    booking_clicks:       bookingClicks,
    est_revenue:          estRevenue,
    avg_booking_value:    avgBkgValue,
    funnel: {
      conversations:  periodConvos,
      leads:          leadsTotal,
      engaged:        leadsEngaged,
      converted:      leadsConverted,
      leads_pct:      leadsPct,
      engaged_pct:    engagedPct,
      converted_pct:  convertedPct,
    },
    activity,
    checklist_dismissed: checklistDismissed,
    onboarding_status:   onboardingStatus,
    bot_mode:            botMode,
    onboarding_banner:   onboardingBanner,
  });
}

// ── GET /portal/api/dashboard/widgets ─────────────────────────────────────────
// Mission Control (Phase 2): aggregates every widget's data in one call + the
// user's saved layout. Role preset (?role=) drives the priority weighting + the
// default widget set. Client-scoped (all locations). Reuses the OI 2.0 priority
// engine + the briefing detectors.
export async function handlePortalDashboardWidgets(req, res, supabase, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const clients = getAllClients();
  const client  = clients[clientId] ?? { id: clientId, name: clientId };

  try {
    const ob   = await import("./operatorBriefing.js");
    const roles = await import("./operatorRoles.js");
    const { scorePriorities, buildTodaysPriorities } = await import("./priorityEngine.js");

    // Saved per-user layout.
    let saved = null;
    try {
      const { data } = await supabase.from("portal_users")
        .select("dashboard_layout").eq("auth_user_id", req.portalUser?.authUserId).single();
      saved = data?.dashboard_layout ?? null;
    } catch { /* none yet */ }

    const role = roles.normalizeRole(req.query.role || saved?.role_preset || "owner");
    // Revenue widget look-ahead window (days). Separate from the fixed 7-day
    // "Upcoming Week" card so owners can widen revenue to see all locations.
    const revDays = [7, 14, 30, 90].includes(Number(req.query.rev_days)) ? Number(req.query.rev_days) : 7;

    // Gather signals in parallel (same sources as the SMS briefing).
    const [
      manifest, upcomingManifest, upcomingRevenue, weekRevenue, seasonRevenue,
      workOrders, hotLeads, weather, unpaid, missingWaivers, missingPhones,
      highValue, overlaps, handoffs, pacing, leadStatus,
    ] = await Promise.all([
      ob.getTodaysManifest(clientId, crmSupabase),
      ob.getUpcomingManifest(crmSupabase, 7),
      ob.getUpcomingRevenue(clientId, crmSupabase, 7),
      ob.getWeeklyRevenueEstimate(clientId, supabase, crmSupabase),
      ob.getSeasonRevenue(client, crmSupabase, supabase),
      ob.getOpenWorkOrders(crmSupabase, null, 12),
      ob.getHotLeads(clientId, supabase, 5),
      ob.getWeatherSnapshot(supabase, clientId),
      ob.detectUnpaidBookings(crmSupabase),
      ob.detectMissingWaivers(crmSupabase),
      ob.detectMissingPhones(crmSupabase),
      ob.detectHighValueBookings(crmSupabase),
      ob.detectOverlappingArrivals(crmSupabase),
      ob.detectUnresolvedHandoffs(supabase, clientId),
      ob.detectPacingSignal(crmSupabase, supabase),
      supabase.from("leads").select("status, contact_phone").eq("client_id", clientId).limit(2000),
    ]);
    const opLeadSet = await ob.getOperatorPhoneSet(clientId, supabase); // keep operators out of the funnel

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA", { timeZone: "America/Denver" }); })();
    const ctx = {
      today, manifest, tomorrowManifest: (upcomingManifest ?? []).filter((r) => String(r.start_at ?? "").slice(0, 10) === tomorrow),
      upcomingManifest, upcomingRevenue, revenue: weekRevenue, workOrders,
      unpaid, missingWaivers, missingPhones, highValue, overlaps,
      unresolvedHandoffs: handoffs, hotLeads, pacing, weather, hasUpcomingWindow: true,
    };
    const scored = scorePriorities(ctx, { role });

    // Revenue window data — reuse the 7d fetch when revDays===7, else fetch wider.
    const revManifest = revDays === 7 ? upcomingManifest : await ob.getUpcomingManifest(crmSupabase, revDays);
    const revUpcoming = revDays === 7 ? upcomingRevenue  : await ob.getUpcomingRevenue(clientId, crmSupabase, revDays);

    // ── Widget data ──────────────────────────────────────────────────────────
    const sum = (rows, f) => (rows ?? []).reduce((s, r) => s + (Number(f(r)) || 0), 0);
    const cents = (v) => Math.round((Number(v) || 0) / 100);

    const upByLoc = {};
    for (const r of (upcomingManifest ?? [])) {
      const k = ob.capLocation(r.location);
      upByLoc[k] = (upByLoc[k] ?? 0) + 1;
    }
    const funnel = { new: 0, contacted: 0, engaged: 0, converted: 0, closed: 0 };
    const dropTestLeads = process.env.TEST_MODE !== "true";
    for (const l of (leadStatus?.data ?? [])) {
      if (!(l.status in funnel)) continue;
      if (opLeadSet.has(l.contact_phone)) continue;
      if (dropTestLeads && isTestPhone(l.contact_phone)) continue;
      funnel[l.status] += 1;
    }

    const oos = (workOrders ?? []).filter((w) => w.out_of_service).length;
    const overdue = (workOrders ?? []).filter((w) => w.estimated_completion_date && String(w.estimated_completion_date).slice(0, 10) < today).length;
    const safety = (workOrders ?? []).filter((w) => w.is_safety_issue).length;

    const widgetData = {
      priorities: scored.slice(0, 6).map((s) => ({ headline: s.headline, action: s.action, severity: s.severity, category: s.category })),
      today: {
        bookings: (manifest ?? []).length,
        guests:   sum(manifest, (r) => r.pax ?? r.customer_count),
        revenue:  cents(sum(manifest, (r) => r.receipt_total_cents ?? r.total_cents)),
        rows: (manifest ?? []).slice(0, 8).map((r) => ({
          time: r.start_at, name: r.customer_name, activity: r.activity,
          location: r.location, pax: r.pax ?? r.customer_count, waiver: r.waiver_signed !== false,
        })),
      },
      upcoming: {
        bookings: upcomingRevenue?.bookings ?? (upcomingManifest ?? []).length,
        revenue:  cents(upcomingRevenue?.revenue_cents),
        by_location: upByLoc,
      },
      fleet: {
        open: (workOrders ?? []).length, out_of_service: oos, overdue, safety,
        rows: (workOrders ?? []).slice(0, 8).map((w) => ({
          asset: w.asset_family, unit: w.unit_name, type: w.work_type,
          overdue: !!(w.estimated_completion_date && String(w.estimated_completion_date).slice(0, 10) < today),
          out_of_service: !!w.out_of_service, due: w.estimated_completion_date, url: w.url,
        })),
      },
      revenue: {
        last_7d:    weekRevenue?.estimated ?? 0,
        rev_days:   revDays,
        upcoming:   cents(revUpcoming?.revenue_cents),
        upcoming_bookings: revUpcoming?.bookings ?? (revManifest ?? []).length,
        season:     { label: seasonRevenue?.period_label ?? null, amount: cents(seasonRevenue?.revenue_cents) },
        pacing_delta: pacing?.delta_pct ?? null,
        // Upcoming revenue split by location over the chosen window — all 4 posts.
        by_location: (() => {
          const m = new Map();
          for (const r of (revManifest ?? [])) {
            const k = ob.capLocation(r.location);
            const v = m.get(k) ?? { name: k, revenue: 0, bookings: 0 };
            v.revenue += Number(r.receipt_total_cents ?? r.total_cents) || 0;
            v.bookings += 1;
            m.set(k, v);
          }
          return [...m.values()].map((v) => ({ ...v, revenue: cents(v.revenue) })).sort((a, b) => b.revenue - a.revenue);
        })(),
      },
      leads: {
        funnel,
        hot: (hotLeads ?? []).slice(0, 5).map((l) => ({ name: l.name, service: l.service, status: l.status })),
      },
      weather: { line: ob.buildConditionsLine(weather), snapshot: weather ?? null },
    };

    return res.json({
      role,
      layout: { role_preset: role, widgets: roles.resolveDashboardWidgets(role, saved) },
      available: roles.DASHBOARD_WIDGETS,
      presets: roles.DASHBOARD_PRESETS,
      data: widgetData,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── PUT /portal/api/dashboard/layout ──────────────────────────────────────────
// Saves the logged-in user's Mission Control layout (role preset + widget order).
export async function handlePortalSaveDashboardLayout(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!req.portalUser?.authUserId) return res.status(401).json({ error: "Not authenticated" });

  const roles = await import("./operatorRoles.js");
  const body  = req.body ?? {};
  const preset = roles.normalizeRole(body.role_preset || "owner");
  const widgets = Array.isArray(body.widgets)
    ? body.widgets.filter((id) => roles.DASHBOARD_WIDGET_IDS.includes(id))
    : [];
  const layout = { role_preset: preset, widgets: [...new Set(widgets)] };

  try {
    const { error } = await supabase.from("portal_users")
      .update({ dashboard_layout: layout })
      .eq("auth_user_id", req.portalUser.authUserId);
    if (error) {
      if (error.message?.includes("does not exist")) {
        return res.status(503).json({ error: "Run db1_dashboard_layout.sql migration first" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.json({ ok: true, layout });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/work-orders ───────────────────────────────────────────────
// Open fleet work orders (season-filtered) with full detail for the portal
// Operator Intelligence hub — each individually accessible via its MPWR link.
export async function handlePortalWorkOrders(req, res, supabase, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });
  try {
    const ob = await import("./operatorBriefing.js");
    const { humanizeWorkType } = await import("./mpwrWorkOrders.js");
    const rows = await ob.getOpenWorkOrders(crmSupabase, null, 50);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const orders = (rows ?? []).map((w) => ({
      id:              w.id,
      fleet:           w.fleet,
      asset_family:    w.asset_family,
      unit_name:       w.unit_name,
      work_type:       w.work_type ? humanizeWorkType(w.work_type) : null,
      notes:           w.work_to_be_done || w.notes || null,
      out_of_service:  !!w.out_of_service,
      is_safety_issue: !!w.is_safety_issue,
      overdue:         !!(w.estimated_completion_date && String(w.estimated_completion_date).slice(0, 10) < today),
      created_date:    w.created_date,
      due_date:        w.estimated_completion_date,
      url:             w.url,
    }));
    return res.json({ season: ob.currentSeason(), count: orders.length, orders });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/dashboard/dismiss-checklist ──────────────────────────────
export async function handleDismissChecklist(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  try {
    await supabase.from("clients")
      .update({ dashboard_checklist_dismissed: true })
      .eq("id", clientId);
  } catch (err) {
    console.warn("[DASH] dismiss-checklist:", err.message);
  }
  return res.json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// computeEstimatedRevenue — exported for testing (legacy)
// ─────────────────────────────────────────────────────────────────────────────
export function computeEstimatedRevenue(leadCount, avgBookingValue) {
  return Math.max(0, (leadCount ?? 0) * (avgBookingValue ?? 175));
}

// ── GET /portal/api/leads ─────────────────────────────────────────────────────
// Query params: status, lead_type, search, filter, limit (default 50), offset (default 0)
// filter=contacted_today — last_contacted_at is today (UTC)
export async function handlePortalLeads(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { status, lead_type, search, filter, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  // Operators (staff) are never customers — keep them out of the lead list.
  try {
    const { getOperatorPhoneSet } = await import("./operatorBriefing.js");
    const opSet = await getOperatorPhoneSet(clientId, supabase);
    if (opSet.size) {
      const inList = "(" + [...opSet].map((p) => `"${String(p).replace(/"/g, "")}"`).join(",") + ")";
      query = query.not("contact_phone", "in", inList);
    }
  } catch { /* non-fatal — fall back to unfiltered */ }
  // Synthetic test numbers (555 / 999 area codes from the test suite/portal) are
  // never real leads — hide them in production (kept in the test env).
  if (process.env.TEST_MODE !== "true") {
    query = query.not("contact_phone", "ilike", "+1555%").not("contact_phone", "ilike", "+1999%");
  }

  if (status)    query = query.eq("status", status);
  if (lead_type) query = query.eq("lead_type", lead_type);
  if (search) {
    const term = search.replace(/[%_]/g, "\\$&");
    query = query.or(`contact_name.ilike.%${term}%,contact_phone.ilike.%${term}%,requested_service.ilike.%${term}%`);
  }
  if (filter === "contacted_today") {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    query = query.gte("last_contacted_at", todayStart.toISOString());
  }

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ leads: data ?? [], total: count ?? 0 });
}

// ── PATCH /portal/api/leads/:id ───────────────────────────────────────────────
export async function handlePortalUpdateLead(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;

  // Ownership check — fetch first
  const { data: existing, error: fetchErr } = await supabase
    .from("leads").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Lead not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const { status, notes, contact_name, contact_email, requested_service, preferred_timeframe, last_contacted_at, channel } = req.body;
  if (status && !VALID_LEAD_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${VALID_LEAD_STATUSES.join(", ")}`,
    });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (status              !== undefined) updates.status              = status;
  if (notes               !== undefined) updates.notes               = notes;
  if (contact_name        !== undefined) updates.contact_name        = contact_name        || null;
  if (contact_email       !== undefined) updates.contact_email       = contact_email       || null;
  if (requested_service   !== undefined) updates.requested_service   = requested_service   || null;
  if (preferred_timeframe !== undefined) updates.preferred_timeframe = preferred_timeframe || null;
  if (last_contacted_at   !== undefined) updates.last_contacted_at   = last_contacted_at   || null;
  if (channel             !== undefined) updates.channel             = channel             || "sms";

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("leads").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ lead: data });
}

// ── POST /portal/api/leads/:id/suggest ────────────────────────────────────────
// AI-suggested follow-up: a one-line next step + a ready-to-send SMS draft,
// generated from the lead + its recent conversation. Caveman-simple: tells the
// owner exactly what to do and what to say. Degrades to a deterministic
// suggestion if Claude is unavailable.
export async function handleSuggestLeadFollowup(req, res, supabase, crmSupabase = null, anthropic = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: lead, error } = await supabase.from("leads").select("*").eq("id", id).single();
  if (error || !lead)                return res.status(404).json({ error: "Lead not found" });
  if (lead.client_id !== clientId)   return res.status(403).json({ error: "Access denied" });

  const clients   = getAllClients();
  const client    = clients[clientId] ?? { name: clientId };
  const bizName   = client.name ?? "the team";
  const firstName = (lead.contact_name || "").trim().split(/\s+/)[0] || "there";
  const service   = lead.requested_service || "an adventure";
  const daysOld   = lead.created_at ? Math.max(0, Math.round((Date.now() - new Date(lead.created_at)) / 86400000)) : null;

  // Deterministic fallback (also used when Claude is off).
  const fallback = {
    next_step: `Text ${firstName} to check in about ${service} and offer to lock in a date.`,
    message: `Hey ${firstName}! It's the team at ${bizName} 🏔 Still thinking about ${service}? Happy to get you booked or answer any questions — just let us know!`,
  };

  if (!anthropic) return res.json({ ...fallback, source: "fallback" });

  try {
    // Recent conversation context (best-effort).
    let convoText = "";
    try {
      const { data: convo } = await supabase.from("conversations")
        .select("messages").eq("client_id", clientId).eq("from_number", lead.contact_phone).maybeSingle();
      const msgs = Array.isArray(convo?.messages) ? convo.messages.slice(-8) : [];
      convoText = msgs.map((m) => `${m.role === "user" ? "Guest" : "Bot"}: ${String(m.content ?? "").slice(0, 160)}`).join("\n");
    } catch { /* no convo */ }

    const sys = `You help the owner of ${bizName} (a Steamboat Springs outdoor adventure business) follow up with a sales lead by text. Be warm, specific, and concise. Reply ONLY with JSON: {"next_step": "...", "message": "..."}. next_step = ONE short sentence telling the owner what to do next. message = a ready-to-send SMS (under 300 chars, friendly, signed as ${bizName}, NO placeholders or brackets, do not invent prices/dates).`;
    const usr = `Lead:\n- Name: ${lead.contact_name || "unknown"}\n- Interested in: ${service}\n- Status: ${lead.status}\n- Source: ${lead.source || lead.channel || "sms"}\n- Preferred timeframe: ${lead.preferred_timeframe || "not given"}\n- Age: ${daysOld != null ? daysOld + " day(s) old" : "unknown"}\n- Notes: ${lead.notes || "none"}\n${convoText ? `\nRecent conversation:\n${convoText}` : ""}\n\nWhat's the single best next step, and what should the owner text them?`;

    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 320,
      system: sys,
      messages: [{ role: "user", content: usr }],
    });
    const raw = resp?.content?.[0]?.text ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed?.next_step && parsed?.message) {
      return res.json({ next_step: String(parsed.next_step).trim(), message: String(parsed.message).trim(), source: "ai" });
    }
    return res.json({ ...fallback, source: "fallback" });
  } catch (err) {
    console.error("[LEADS] suggest follow-up failed:", err.message);
    return res.json({ ...fallback, source: "fallback" });
  }
}

// ── GET /portal/api/campaigns/audience-preview ────────────────────────────────
// Returns count + sample names for a given audience_type, without sending.
export async function handlePortalAudiencePreview(req, res, supabase, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const audienceType = req.query.audience_type ?? "all_leads";
  let filterConfig = {};
  if (req.query.filter_config) {
    try { filterConfig = JSON.parse(req.query.filter_config); } catch { /* ignore malformed */ }
  }
  try {
    const clients = getAllClients();
    const seasonConfig = clients[clientId]?.seasonConfig ?? null;
    const leads = await selectAudience(supabase, { clientId, audienceType, filterConfig, seasonConfig }, crmSupabase);
    const names = leads
      .map(l => (l.contact_name ?? "").split(" ")[0])
      .filter(Boolean)
      .slice(0, 5);
    return res.json({ count: leads.length, sample_names: names });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/campaigns ─────────────────────────────────────────────────
// Fixture campaign names created by the automated test suite against the live
// prod DB (test.js POSTs to the real /admin/campaigns route for csr_rea to
// exercise the event-triggered create path) — hidden from the portal so they
// don't clutter a real client's Campaigns list. Gated on TEST_MODE so the
// suite itself (which asserts against its own creates) still sees them.
const TEST_CAMPAIGN_NAMES = ["4B Test Snow Campaign"];

export async function handlePortalCampaigns(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { status, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from("campaigns")
    .select("*", { count: "exact" })
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (process.env.TEST_MODE !== "true") {
    query = query.not("name", "in", `(${TEST_CAMPAIGN_NAMES.map(n => `"${n}"`).join(",")})`);
  }

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ campaigns: data ?? [], total: count ?? 0 });
}

// ── POST /portal/api/campaigns ────────────────────────────────────────────────
export async function handlePortalCreateCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { name, message_body, audience_type, scheduled_at, filter_config } = req.body;
  if (!name)         return res.status(400).json({ error: "name is required" });
  if (!message_body) return res.status(400).json({ error: "message_body is required" });

  try {
    const campaign = await createCampaign(supabase, {
      clientId,
      name,
      messageBody:  message_body,
      audienceType: audience_type,
      scheduledAt:  scheduled_at ?? null,
      metadata:     filter_config ? { filter_config } : {},
    });
    return res.status(201).json({ campaign });
  } catch (err) {
    if (err.code === "DUPLICATE_CAMPAIGN_NAME") {
      return res.status(409).json({ error: err.message, code: err.code, existing_id: err.existingId ?? null });
    }
    return res.status(400).json({ error: err.message });
  }
}

// ── GET /portal/api/campaigns/:id ─────────────────────────────────────────────
export async function handlePortalGetCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);

  const { id } = req.params;
  const { data, error } = await supabase
    .from("campaigns").select("*").eq("id", id).single();
  if (error || !data) return res.status(404).json({ error: "Campaign not found" });
  if (clientId && data.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const stats = await getCampaignStats(supabase, id);
  return res.json({ campaign: data, stats });
}

// ── PATCH /portal/api/campaigns/:id ──────────────────────────────────────────
export async function handlePortalUpdateCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("campaigns").select("id, client_id, status").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Campaign not found" });
  if (clientId && existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });
  if (existing.status !== "draft") {
    return res.status(409).json({ error: "Only draft campaigns can be edited" });
  }

  const allowed = ["name", "message_body", "audience_type", "scheduled_at"];
  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("campaigns").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ campaign: data });
}

// ── DELETE /portal/api/campaigns/:id ─────────────────────────────────────────
// Single-campaign delete. client_admin only; client-scope enforced.
export async function handlePortalDeleteCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;
  const { data: campaign } = await supabase.from("campaigns").select("client_id").eq("id", id).maybeSingle();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (clientId && campaign.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  // Cascade: cancel any pending sends + remove campaign_recipients before the campaign row
  await supabase.from("scheduled_messages")
    .update({ status: "cancelled", error: "campaign deleted" })
    .eq("status", "pending")
    .eq("metadata->>campaign_id", id);
  await supabase.from("campaign_recipients").delete().eq("campaign_id", id);
  const { error } = await supabase.from("campaigns").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[PORTAL] campaign deleted: ${id} (by ${req.portalUser?.email ?? "?"})`);
  return res.json({ deleted: 1 });
}

// ── DELETE /portal/api/campaigns ─────────────────────────────────────────────
// Bulk delete. Body: { ids: ["uuid1", "uuid2", ...] } — ≤100 per request.
// Useful for purging duplicate test rows. client-scope enforced server-side.
export async function handlePortalBulkDeleteCampaigns(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ error: "ids (array of campaign UUIDs) required" });

  // Filter to rows owned by this client (defense in depth — RLS may not be on)
  let q = supabase.from("campaigns").select("id, client_id").in("id", ids);
  if (clientId) q = q.eq("client_id", clientId);
  const { data: scoped } = await q;
  const allowedIds = (scoped ?? []).map(r => r.id);
  if (!allowedIds.length) return res.json({ deleted: 0, skipped: ids.length, reason: "no rows in scope" });

  // Cancel pending sends + remove recipients for the entire batch
  for (const id of allowedIds) {
    await supabase.from("scheduled_messages")
      .update({ status: "cancelled", error: "campaign bulk-deleted" })
      .eq("status", "pending")
      .eq("metadata->>campaign_id", id);
  }
  await supabase.from("campaign_recipients").delete().in("campaign_id", allowedIds);
  const { error } = await supabase.from("campaigns").delete().in("id", allowedIds);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[PORTAL] campaigns bulk-deleted: ${allowedIds.length} (by ${req.portalUser?.email ?? "?"})`);
  return res.json({ deleted: allowedIds.length, skipped: ids.length - allowedIds.length });
}

// ── GET /portal/api/messaging/activity-options ───────────────────────────────
// Distinct (activity display_name, location) pairs derived from DB2 bookings —
// activity comes from the `activities` table's display_name (short friendly
// name like "RZR Experience 4-Seater"), and location prefers
// bookings.location (MPWR-enriched, surfaces sub-locations like Rabbit Ears)
// falling back to activities.location.
// Filters: archived activities + BOT- placeholder bookings excluded.
export async function handlePortalActivityOptions(req, res, crmSupabase) {
  if (!crmSupabase) return res.json({ options: [] });
  try {
    // 1. Pull bookings — we only need activity_id + (override) location
    const { data: bookings } = await crmSupabase
      .from("bookings")
      .select("activity_id, location")
      .not("activity_id", "is", null)
      .not("fareharbor_pk", "ilike", "BOT-%")
      .limit(5000);

    const activityIds = [...new Set((bookings ?? []).map(b => b.activity_id).filter(Boolean))];
    if (!activityIds.length) return res.json({ options: [] });

    // 2. Look up activity display_name + fallback location + archived flag
    const { data: activities } = await crmSupabase
      .from("activities")
      .select("id, display_name, location, is_archived")
      .in("id", activityIds);
    const actMap = new Map((activities ?? []).map(a => [a.id, a]));

    // 3. Dedup (activity, location) tuples; bookings.location wins
    const seen = new Map();
    for (const b of bookings ?? []) {
      const a = actMap.get(b.activity_id);
      if (!a || a.is_archived) continue;
      if (!a.display_name) continue;
      const location = b.location ?? a.location ?? null;
      const key = `${a.display_name}|${location ?? ""}`;
      if (!seen.has(key)) seen.set(key, { activity: a.display_name, location });
    }
    const options = [...seen.values()].sort((a, b) =>
      (a.activity ?? "").localeCompare(b.activity ?? "")
    );
    return res.json({ options });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/campaigns/:id/send ──────────────────────────────────────
export async function handlePortalSendCampaign(req, res, supabase, crmSupabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);

  const { id } = req.params;
  const { data: campaign, error: fetchErr } = await supabase
    .from("campaigns").select("*").eq("id", id).single();
  if (fetchErr || !campaign) return res.status(404).json({ error: "Campaign not found" });
  if (clientId && campaign.client_id !== clientId) return res.status(403).json({ error: "Access denied" });
  if (!["draft", "scheduled"].includes(campaign.status)) {
    return res.status(409).json({ error: `Campaign is already in status "${campaign.status}"` });
  }

  // Prefer: explicit override → client's configured outbound phone → global env var
  const client = getAllClients()[campaign.client_id];
  const fromPhone = req.body?.from_phone ?? client?.outboundPhone ?? process.env.TWILIO_PHONE_NUMBER ?? null;
  try {
    const result = await enqueueCampaign(supabase, campaign, fromPhone, crmSupabase);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/analytics ─────────────────────────────────────────────────
// Query params: since (ISO date string, default 30 days ago)
export async function handlePortalAnalytics(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const since = req.query.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Demo events
  const { data: events } = await supabase
    .from("demo_events")
    .select("event_name, created_at, source")
    .eq("client_id", clientId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const eventCounts = {};
  for (const e of (events ?? [])) {
    eventCounts[e.event_name] = (eventCounts[e.event_name] ?? 0) + 1;
  }

  // Lead funnel
  const { data: leads } = await supabase
    .from("leads")
    .select("status, lead_type, created_at")
    .eq("client_id", clientId)
    .gte("created_at", since);

  const leadFunnel = { new: 0, contacted: 0, engaged: 0, converted: 0, total: 0 };
  for (const l of (leads ?? [])) {
    leadFunnel.total++;
    if (leadFunnel[l.status] !== undefined) leadFunnel[l.status]++;
  }

  // Campaign summary
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("status")
    .eq("client_id", clientId);

  const campaignSummary = { total: 0, draft: 0, sending: 0, scheduled: 0, sent: 0 };
  for (const c of (campaigns ?? [])) {
    campaignSummary.total++;
    if (campaignSummary[c.status] !== undefined) campaignSummary[c.status]++;
  }

  return res.json({
    period: since,
    events: eventCounts,
    recentEvents: (events ?? []).slice(0, 20),
    leadFunnel,
    campaigns: campaignSummary,
  });
}

// ── GET /portal/api/settings ──────────────────────────────────────────────────
export async function handlePortalSettings(req, res, supabase) {
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const clients = getAllClients();
  const client  = clients[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  // Load scrape sources + booking options (non-fatal if tables don't exist yet)
  let scrapeSources = [];
  let bookingLinks  = [];
  if (supabase) {
    const [srcRes, bkRes] = await Promise.all([
      supabase.from("client_scrape_sources").select("*").eq("client_id", clientId).order("sort_order"),
      supabase.from("client_booking_options").select("*").eq("client_id", clientId).order("sort_order"),
    ]);
    if (!srcRes.error) scrapeSources = srcRes.data ?? [];
    if (!bkRes.error)  bookingLinks  = bkRes.data  ?? [];
  }

  // If no DB scrape sources exist, surface the static scrapeUrls so the portal
  // reflects what the bot is actually using (read-only — no id, no delete button).
  if (!scrapeSources.length && client.scrapeUrls?.length) {
    scrapeSources = client.scrapeUrls.map((url, i) => ({
      id:          null,   // no id = portal treats as read-only (can't delete)
      url,
      label:       null,
      source_type: "website",
      active:      true,
      sort_order:  i,
      _static:     true,   // flag for UI to show "(from config)" badge
    }));
  }

  return res.json({
    clientId,
    name:                    client.name,
    botName:                 client.botName ?? "Summit",
    tone:                    client.tone    ?? "",
    supportPhone:            client.supportPhone          ?? null,
    supportEmail:            client.supportEmail          ?? null,
    leadNotificationPhone:   client.leadNotificationPhone ?? null,
    ownerPhone:              client.ownerPhone            ?? null,
    websiteUrl:              client.websiteUrl            ?? null,
    hours:                   client.hours                 ?? null,
    timezone:                client.timezone              ?? "America/Denver",
    bookingMode:             client.bookingMode,
    bookingLink:             client.bookingLink           ?? null,
    // Feature toggles
    campaignsEnabled:        client.campaignsEnabled      ?? false,
    followupsEnabled:        client.followupsEnabled      ?? false,
    humanHandoffEnabled:     client.humanHandoffEnabled   ?? true,
    leadCaptureEnabled:      client.leadCaptureEnabled    ?? false,
    waitlistEnabled:         client.waitlistEnabled       ?? false,
    editable:                !!client._fromDb,
    // Twilio routing
    outboundPhone:           client.outboundPhone         ?? null,
    messagingServiceSid:     client.messagingServiceSid   ?? null,
    twilioAccountSid:        client.twilioAccountSid      ?? null,
    // Auth token intentionally omitted from GET — write-only in portal
    // Conversation settings
    conversationSettings:    client.conversationSettings  ?? {},
    // Crawl settings
    crawlSettings:           client.crawlSettings         ?? {},
    // Season config (per-client summer/winter boundaries)
    seasonConfig:            client.seasonConfig          ?? {
      summer: { start: "04-01", end: "10-31" },
      winter: { start: "12-01", end: "03-31" },
    },
    // Scrape sources + booking options
    scrapeSources,
    bookingLinks,
    // FareHarbor integration config
    fareharbor: {
      enabled:   client.fareharborEnabled ?? false,
      companies: (client.fareharborCompanies ?? []).map((co) => ({
        id:          co.id        ?? null,
        name:        co.name      ?? null,
        shortname:   co.shortname ?? null,
        has_key:     !!(co.user_key || co.userKeyEnv), // never expose actual key
        has_app_key: !!(co.app_key),                   // never expose actual key
      })),
    },
    // SNOTEL stations
    snotelStations: client.snotelStations ?? [],
    // Operator phones (additional numbers that trigger owner mode)
    operatorPhones: client.operatorPhones ?? [],
    // Custom weather locations (fetched hourly per-client)
    weatherLocations: client.weatherLocations ?? [],
    // Weather API key status (global, not per-client)
    weather: {
      enabled: !!(process.env.OPENWEATHER_API_KEY),
    },
  });
}

// ── PATCH /portal/api/settings ────────────────────────────────────────────────
// Only DB-backed clients can be edited. Static clients return 400.
// Requires client_admin or internal_admin role.
export async function handlePortalUpdateSettings(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  // Validate booking_mode early — before editability check so validation errors are distinct
  if (req.body.booking_mode !== undefined && !VALID_BOOKING_MODES.includes(req.body.booking_mode)) {
    return res.status(400).json({ error: `Invalid booking_mode. Valid: ${VALID_BOOKING_MODES.join(", ")}` });
  }

  const clients = getAllClients();
  const client  = clients[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  // If client is static (defined in clients.js, no DB row), auto-promote it to DB-backed.
  // This seeds the clients table from the static config so future edits persist.
  if (!client._fromDb) {
    if (req.portalUser?.role !== "internal_admin") {
      return res.status(400).json({
        error: "Static clients cannot be edited via portal — contact Highmark to update your configuration",
      });
    }
    // Seed the DB row from the static client config
    const seed = {
      id:                      clientId,
      slug:                    client.slug     ?? clientId,
      name:                    client.name,
      bot_name:                client.botName  ?? null,
      tone:                    client.tone     ?? null,
      inbound_phones:          client.inboundPhones ?? [],
      support_phone:           client.supportPhone  ?? null,
      handoff_phone:           client.handoffPhone  ?? null,
      support_email:           client.supportEmail  ?? null,
      address:                 client.address       ?? null,
      timezone:                client.timezone      ?? "America/Denver",
      hours:                   client.hours         ?? null,
      booking_mode:            client.bookingMode   ?? "informational",
      fareharbor_enabled:      client.fareharborEnabled  ?? false,
      crm_enabled:             client.crmEnabled         ?? false,
      lead_capture_enabled:    client.leadCaptureEnabled ?? false,
      waitlist_enabled:        client.waitlistEnabled    ?? true,
      lead_notification_phone: client.leadNotificationPhone ?? null,
      scrape_urls:             client.scrapeUrls  ?? [],
      services:                client.services    ?? [],
      website_url:             client.websiteUrl  ?? null,
      active:                  true,
      campaigns_enabled:       client.campaignsEnabled    ?? false,
      followups_enabled:       client.followupsEnabled    ?? false,
      human_handoff_enabled:   client.humanHandoffEnabled ?? true,
      booking_link:            client.bookingLink         ?? null,
      outbound_phone:          client.outboundPhone       ?? null,
      messaging_service_sid:   client.messagingServiceSid ?? null,
      twilio_account_sid:      client.twilioAccountSid    ?? null,
      twilio_auth_token:       client.twilioAuthToken     ?? null,
      conversation_settings:   client.conversationSettings ?? {},
      created_at:              new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    };
    const { error: seedErr } = await supabase.from("clients").upsert(seed, { onConflict: "id" });
    if (seedErr) return res.status(500).json({ error: `Failed to promote client to DB: ${seedErr.message}` });
  }

  // Normalize and validate operational phone fields (Twilio send targets)
  // Display phones (support_phone, handoff_phone) are left as-is — they appear in bot messages.
  const OPERATIONAL_PHONE_FIELDS = ["outbound_phone", "lead_notification_phone"];
  for (const field of OPERATIONAL_PHONE_FIELDS) {
    const val = req.body[field];
    if (val == null) continue; // not being updated
    if (val === "") continue;  // clearing the field — allow empty
    const normalized = normalizePhone(val);
    if (!normalized) {
      return res.status(400).json({
        error: `${field} must be a valid phone number (E.164 or US 10-digit). Got: "${val}"`,
      });
    }
    req.body[field] = normalized; // replace with canonical form before saving
  }

  const updates = { updated_at: new Date().toISOString() };
  // Text fields
  for (const [reqKey, dbKey] of Object.entries(EDITABLE_SETTINGS)) {
    if (req.body[reqKey] !== undefined) updates[dbKey] = req.body[reqKey];
  }
  // Boolean feature toggles
  for (const field of EDITABLE_TOGGLES) {
    if (req.body[field] !== undefined) {
      if (typeof req.body[field] !== "boolean") {
        return res.status(400).json({ error: `${field} must be a boolean` });
      }
      updates[field] = req.body[field];
    }
  }

  // conversation_settings — JSON object, validated and stored as-is
  if (req.body.conversation_settings !== undefined) {
    if (typeof req.body.conversation_settings !== "object" || Array.isArray(req.body.conversation_settings)) {
      return res.status(400).json({ error: "conversation_settings must be a JSON object" });
    }
    updates.conversation_settings = req.body.conversation_settings;
  }

  // crawl_settings — JSON object; store snake_case keys as-is (dbRowToClient normalizes)
  if (req.body.crawl_settings !== undefined) {
    if (typeof req.body.crawl_settings !== "object" || Array.isArray(req.body.crawl_settings)) {
      return res.status(400).json({ error: "crawl_settings must be a JSON object" });
    }
    updates.crawl_settings = req.body.crawl_settings;
  }

  // season_config — { summer: { start: MM-DD, end: MM-DD }, winter: { start, end } }
  if (req.body.season_config !== undefined) {
    const sc = req.body.season_config;
    if (sc === null) {
      updates.season_config = null;
    } else if (typeof sc !== "object" || Array.isArray(sc)) {
      return res.status(400).json({ error: "season_config must be a JSON object or null" });
    } else {
      const validMmDd = (v) => typeof v === "string" && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);
      for (const key of ["summer", "winter"]) {
        if (sc[key] !== undefined) {
          if (typeof sc[key] !== "object" || sc[key] === null) {
            return res.status(400).json({ error: `season_config.${key} must be an object with start/end` });
          }
          if (!validMmDd(sc[key].start) || !validMmDd(sc[key].end)) {
            return res.status(400).json({ error: `season_config.${key}.start/end must be MM-DD strings` });
          }
        }
      }
      updates.season_config = sc;
    }
  }

  // fareharbor_companies — array of { id, name, shortname, user_key?, app_key? }
  // user_key / app_key are write-only: empty string means "keep existing" (don't clear)
  if (req.body.fareharbor_companies !== undefined) {
    if (!Array.isArray(req.body.fareharbor_companies)) {
      return res.status(400).json({ error: "fareharbor_companies must be an array" });
    }
    // Read existing companies so we can preserve stored keys if not provided
    const existing = getAllClients()[clientId];
    const existingCos = existing?.fareharborCompanies ?? [];
    updates.fareharbor_companies = req.body.fareharbor_companies.map((co) => {
      const prev = existingCos.find((e) => e.id === co.id) ?? {};
      const userKey = (co.user_key ?? "").trim();
      const appKey  = (co.app_key  ?? "").trim();
      return {
        id:         co.id        ?? prev.id        ?? null,
        name:       co.name      ?? prev.name      ?? null,
        shortname:  co.shortname ?? prev.shortname ?? null,
        userKeyEnv: prev.userKeyEnv ?? null,              // preserve env var reference
        user_key:   userKey || prev.user_key || null,     // empty string = keep existing
        app_key:    appKey  || prev.app_key  || null,     // empty string = keep existing
      };
    });
  }

  // snotel_stations — array of station ID strings
  if (req.body.snotel_stations !== undefined) {
    if (!Array.isArray(req.body.snotel_stations)) {
      return res.status(400).json({ error: "snotel_stations must be an array" });
    }
    updates.snotel_stations = req.body.snotel_stations.filter(Boolean);
  }

  // operator_phones — array of E.164 phone strings
  if (req.body.operator_phones !== undefined) {
    if (!Array.isArray(req.body.operator_phones)) {
      return res.status(400).json({ error: "operator_phones must be an array" });
    }
    const phones = [];
    for (const p of req.body.operator_phones) {
      const normalized = normalizePhone(String(p ?? "").trim());
      if (p && !normalized) {
        return res.status(400).json({ error: `Invalid phone in operator_phones: "${p}"` });
      }
      if (normalized) phones.push(normalized);
    }
    updates.operator_phones = phones;
  }

  // weather_locations — array of { name, lat, lon, elevation? }
  if (req.body.weather_locations !== undefined) {
    if (!Array.isArray(req.body.weather_locations)) {
      return res.status(400).json({ error: "weather_locations must be an array" });
    }
    const locs = [];
    for (const loc of req.body.weather_locations) {
      if (!loc.name || loc.lat == null || loc.lon == null) {
        return res.status(400).json({ error: "Each weather_location requires name, lat, and lon" });
      }
      const lat = parseFloat(loc.lat);
      const lon = parseFloat(loc.lon);
      if (isNaN(lat) || isNaN(lon)) {
        return res.status(400).json({ error: `Invalid lat/lon for location "${loc.name}"` });
      }
      locs.push({ name: String(loc.name).trim(), lat, lon, elevation: loc.elevation ? String(loc.elevation).trim() : null });
    }
    updates.weather_locations = locs;
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { error } = await supabase
    .from("clients").update(updates).eq("id", clientId);
  if (error) return res.status(500).json({ error: error.message });

  // Mirror owner_phone / operator_phones writes into the operator_phones table
  // so per-phone preferences (digest_times, internal_mode_enabled, etc.) stay in sync.
  if (updates.owner_phone !== undefined || updates.operator_phones !== undefined) {
    try {
      await syncOperatorPhonesTable(clientId, supabase, {
        ownerPhone:       updates.owner_phone        ?? null,
        operatorPhones:   updates.operator_phones    ?? null,
        ownerPhoneSet:    updates.owner_phone        !== undefined,
        operatorPhonesSet: updates.operator_phones   !== undefined,
      });
    } catch (syncErr) {
      console.warn(`[SETTINGS] operator_phones sync failed for ${clientId}:`, syncErr.message);
    }
  }

  // Reload runtime client registry
  const { data: allRows } = await supabase.from("clients").select("*").eq("active", true);
  loadDbClients(allRows ?? []);

  return res.json({
    ok:      true,
    clientId,
    updated: Object.keys(updates).filter(k => k !== "updated_at"),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// syncOperatorPhonesTable — mirror legacy owner_phone + operator_phones[] into
// the operator_phones table. UPSERT new phones (preserving existing per-phone
// preferences), DELETE phones removed from the legacy set, and re-tag role:
//   • The owner_phone value → role='owner', label='Owner'
//   • Everything else → role='staff' (unless already manually set to manager/sales)
// ─────────────────────────────────────────────────────────────────────────────
async function syncOperatorPhonesTable(clientId, supabase, { ownerPhone, operatorPhones, ownerPhoneSet, operatorPhonesSet }) {
  // Read what's currently in the table so we don't blow away preferences
  const { data: existing } = await supabase
    .from("operator_phones")
    .select("id, phone, role")
    .eq("client_id", clientId);
  const existingByPhone = new Map((existing ?? []).map((r) => [r.phone, r]));

  // If a field wasn't included in this update, treat its existing value as
  // authoritative (don't touch those phones).
  let canonicalOwner   = ownerPhoneSet     ? ownerPhone : (existing?.find((r) => r.role === "owner")?.phone ?? null);
  let canonicalStaff   = operatorPhonesSet ? (operatorPhones ?? []) : (existing?.filter((r) => r.role !== "owner").map((r) => r.phone) ?? []);

  const desired = new Set();
  if (canonicalOwner) desired.add(canonicalOwner);
  for (const p of canonicalStaff) {
    if (p) desired.add(p);
  }

  // INSERT phones that are in desired but not in the table yet
  const toInsert = [];
  for (const phone of desired) {
    if (!existingByPhone.has(phone)) {
      const isOwner = phone === canonicalOwner;
      toInsert.push({
        client_id: clientId,
        phone,
        role:  isOwner ? "owner" : "staff",
        label: isOwner ? "Owner" : null,
      });
    }
  }
  if (toInsert.length) {
    await supabase.from("operator_phones").insert(toInsert);
  }

  // Note: we intentionally do NOT delete operator_phones rows that aren't in
  // the legacy set. Phones added via the Sprint C "Operator Intelligence" UI
  // may not appear in clients.operator_phones JSONB; deleting them on every
  // Settings save would silently undo the user's work. Removal happens
  // explicitly via DELETE /portal/api/operator-phones/:id.

  // Re-tag role for the owner phone (in case ownerPhone changed but the row exists)
  if (canonicalOwner && existingByPhone.has(canonicalOwner)) {
    await supabase
      .from("operator_phones")
      .update({ role: "owner", label: existingByPhone.get(canonicalOwner)?.role === "owner" ? undefined : "Owner" })
      .eq("client_id", clientId)
      .eq("phone", canonicalOwner);
  }
  // Demote any prior owner row that is no longer the owner
  for (const row of existing ?? []) {
    if (row.role === "owner" && row.phone !== canonicalOwner) {
      await supabase
        .from("operator_phones")
        .update({ role: "staff", label: null })
        .eq("id", row.id);
    }
  }
}

// ── POST /portal/api/settings/preview-opener ─────────────────────────────────
// Returns the opener text (or sends a test SMS). Body: { opener_text?: string }
// TEST_MODE → always returns { preview, sent: false }
// LIVE mode → sends Twilio SMS to client.ownerPhone if not overridden
export async function handlePortalPreviewOpener(req, res, supabase) {
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const clients = getAllClients();
  const client  = clients[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  // Resolve opener text: body override → bot_config → seasonal default
  let openerText = (req.body?.opener_text ?? "").trim();
  if (!openerText && supabase) {
    const { data: bc } = await supabase.from("bot_config").select("opener_text").eq("client_id", clientId).maybeSingle();
    if (bc?.opener_text) openerText = bc.opener_text;
  }
  if (!openerText) {
    const { getSeasonalOpener } = await import("./index.js");
    openerText = getSeasonalOpener(client);
  }

  const testMode = process.env.TEST_MODE === "true";
  if (testMode) {
    return res.json({ preview: openerText, sent: false });
  }

  // LIVE mode: send to ownerPhone
  const toPhone = client.ownerPhone ?? null;
  if (!toPhone) {
    return res.status(400).json({ error: "No owner phone configured — add one in General settings" });
  }

  try {
    const twilio = (await import("twilio")).default;
    const accountSid = client.twilioAccountSid ?? process.env.TWILIO_ACCOUNT_SID;
    const authToken  = client.twilioAuthToken  ?? process.env.TWILIO_AUTH_TOKEN;
    const fromPhone  = client.outboundPhone ?? process.env.TWILIO_PHONE_NUMBER;
    const tw = twilio(accountSid, authToken);
    await tw.messages.create({ body: `[OPENER PREVIEW]\n${openerText}`, from: fromPhone, to: toPhone });
    const masked = toPhone.slice(0, 3) + "****" + toPhone.slice(-4);
    return res.json({ sent: true, to: masked });
  } catch (err) {
    return res.status(500).json({ error: `Failed to send: ${err.message}` });
  }
}

// ── GET /portal/api/settings/usage ───────────────────────────────────────────
// Returns message count + web session count for current calendar month
export async function handlePortalUsage(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  // Exclude test sessions + (in prod) synthetic 555/999 test-phone convos.
  let convQ = supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .neq("session_type", "test")
    .gte("updated_at", monthStart);
  if (process.env.TEST_MODE !== "true") {
    convQ = convQ.not("from_number", "ilike", "+1555%").not("from_number", "ilike", "+1999%");
  }
  const [convRes, webRes] = await Promise.all([
    convQ,
    supabase
      .from("web_events")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("event_type", "chat_started")
      .gte("created_at", monthStart),
  ]);

  return res.json({
    month:              `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`,
    conversations_this_month: convRes.count  ?? 0,
    web_sessions_this_month:  webRes.count   ?? 0,
    plan:               "Growth",   // static for now — extend with billing table later
    message_limit:      null,       // null = Unlimited
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPE SOURCES CRUD — /portal/api/scrape-sources
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /portal/api/scrape-sources ───────────────────────────────────────────
export async function handlePortalScrapeSources(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("client_scrape_sources")
    .select("*")
    .eq("client_id", clientId)
    .order("sort_order", { ascending: true });

  if (error) {
    if (error.message?.includes("does not exist")) return res.json({ sources: [] });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ sources: data ?? [] });
}

// ── POST /portal/api/scrape-sources ──────────────────────────────────────────
export async function handlePortalCreateScrapeSource(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { url, label, source_type = "website", active = true, sort_order = 0 } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!VALID_SOURCE_TYPES.includes(source_type)) {
    return res.status(400).json({ error: `Invalid source_type. Valid: ${VALID_SOURCE_TYPES.join(", ")}` });
  }

  const { data, error } = await supabase
    .from("client_scrape_sources")
    .insert({ client_id: clientId, url, label: label ?? null, source_type, active, sort_order })
    .select()
    .single();

  if (error) {
    if (error.message?.includes("does not exist")) {
      return res.status(503).json({ error: "Run db1_scrape_sources.sql migration first" });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ source: data });
}

// ── PATCH /portal/api/scrape-sources/:id ─────────────────────────────────────
export async function handlePortalUpdateScrapeSource(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("client_scrape_sources").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Source not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const allowed = ["url", "label", "source_type", "active", "sort_order"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("client_scrape_sources").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ source: data });
}

// ── DELETE /portal/api/scrape-sources/:id ────────────────────────────────────
export async function handlePortalDeleteScrapeSource(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("client_scrape_sources").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Source not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const { error } = await supabase.from("client_scrape_sources").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING OPTIONS CRUD — /portal/api/booking-options
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /portal/api/booking-options ──────────────────────────────────────────
export async function handlePortalBookingOptions(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("client_booking_options")
    .select("*")
    .eq("client_id", clientId)
    .order("sort_order", { ascending: true });

  if (error) {
    if (error.message?.includes("does not exist")) return res.json({ options: [] });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ options: data ?? [] });
}

// ── POST /portal/api/booking-options ─────────────────────────────────────────
export async function handlePortalCreateBookingOption(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { url, title, description, type = "link", active = true, sort_order = 0, metadata_json } = req.body;
  if (!url)   return res.status(400).json({ error: "url is required" });
  if (!title) return res.status(400).json({ error: "title is required" });

  const { data, error } = await supabase
    .from("client_booking_options")
    .insert({ client_id: clientId, url, title, description: description ?? null, type, active, sort_order, metadata_json: metadata_json ?? null })
    .select()
    .single();

  if (error) {
    if (error.message?.includes("does not exist")) {
      return res.status(503).json({ error: "Run db1_booking_options.sql migration first" });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ option: data });
}

// ── PATCH /portal/api/booking-options/:id ────────────────────────────────────
export async function handlePortalUpdateBookingOption(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("client_booking_options").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Option not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const allowed = ["url", "title", "description", "type", "active", "sort_order", "metadata_json"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("client_booking_options").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ option: data });
}

// ── DELETE /portal/api/booking-options/:id ───────────────────────────────────
export async function handlePortalDeleteBookingOption(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("client_booking_options").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Option not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const { error } = await supabase.from("client_booking_options").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PORTAL USER MANAGEMENT (protected by requireUiAccess, not JWT)
// These routes are for internal use only — not accessible to portal users.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /admin/portal-users ──────────────────────────────────────────────────
// Creates a Supabase Auth user AND inserts the portal_users row.
// Body: { email, password, role, client_id }
export async function handleCreatePortalUser(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { email, password, role = "client_user", client_id = null } = req.body;

  if (!email)    return res.status(400).json({ error: "email is required" });
  if (!password) return res.status(400).json({ error: "password is required" });
  if (!["internal_admin", "client_admin", "client_user"].includes(role)) {
    return res.status(400).json({ error: "role must be internal_admin, client_admin, or client_user" });
  }
  if ((role === "client_user" || role === "client_admin") && !client_id) {
    return res.status(400).json({ error: "client_id is required for client_user and client_admin roles" });
  }

  // Create Supabase Auth user (auto-confirm email)
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authErr) {
    console.error("[PORTAL ADMIN] Auth user creation failed:", authErr.message);
    return res.status(400).json({ error: authErr.message });
  }

  // Insert portal_users row
  const { data, error } = await supabase
    .from("portal_users")
    .insert({
      auth_user_id: authData.user.id,
      email,
      role,
      client_id:    client_id ?? null,
      active:       true,
    })
    .select()
    .single();

  if (error) {
    console.error("[PORTAL ADMIN] portal_users insert failed:", error.message);
    return res.status(500).json({ error: error.message });
  }

  console.log(`[PORTAL ADMIN] Created portal user: ${email} (role=${role}, client=${client_id ?? "admin"})`);
  return res.status(201).json({ portalUser: data });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATIONS STATUS — /portal/api/integrations
// Returns live data-sync status for all integrations (weather, SNOTEL, FH,
// website scrape, crawler) for the scoped client.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /portal/api/integrations ─────────────────────────────────────────────
export async function handlePortalIntegrations(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  try {
    const integrations = await getIntegrationStatus(clientId, supabase);
    return res.json({ clientId, integrations });
  } catch (err) {
    console.error("[PORTAL] integrations status error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/integrations/fareharbor/test ────────────────────────────
// Validates FH credentials by making a live API call. Never stores keys.
// Body: { shortname, user_key?, app_key? }
// Returns: { ok: true, shortname, item_count, items } | { ok: false, error }
export async function handlePortalFhTest(req, res) {
  if (!requireClientAdmin(req, res)) return;

  const { shortname, user_key, app_key } = req.body ?? {};
  if (!shortname?.trim()) return res.status(400).json({ error: "shortname is required" });

  // Resolve keys: use provided key, then fall back to stored key for this company
  const clientId = resolvePortalClientId(req);
  const client   = getAllClients()[clientId];
  const existing = (client?.fareharborCompanies ?? []).find((c) => c.shortname === shortname.trim()) ?? {};
  const resolvedUserKey = (user_key ?? "").trim()
    || existing.user_key
    || (existing.userKeyEnv ? process.env[existing.userKeyEnv] : null)
    || "";
  const resolvedAppKey = (app_key ?? "").trim()
    || existing.app_key
    || process.env.FAREHARBOR_APP_KEY
    || "";

  const headers = {
    "X-FareHarbor-API-App":  resolvedAppKey,
    "X-FareHarbor-API-User": resolvedUserKey,
  };

  try {
    const resp = await fetch(
      `https://fareharbor.com/api/external/v1/companies/${shortname.trim()}/items/`,
      { headers }
    );
    if (!resp.ok) {
      const msg = resp.status === 401 ? "Invalid API key"
                : resp.status === 403 ? "Access denied — check app key"
                : resp.status === 404 ? "Company shortname not found"
                : `FareHarbor error ${resp.status}`;
      return res.json({ ok: false, error: msg });
    }
    const data  = await resp.json();
    const items = (data.items ?? []).slice(0, 20).map((i) => ({ name: i.name, pk: i.pk }));
    return res.json({ ok: true, shortname: shortname.trim(), item_count: data.items?.length ?? 0, items });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
}

// ── POST /portal/api/integrations/fareharbor/sync ────────────────────────────
// Triggers an immediate FH items + availability refresh for the scoped client.
// client_admin+ only.
export async function handlePortalFhSync(req, res, supabase) {
  if (!requireClientAdmin(req, res)) return;
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const client = getAllClients()[clientId];
  if (!client)   return res.status(404).json({ error: "Client not found" });

  const companies = client.fareharborCompanies ?? [];
  if (!companies.length) return res.json({ ok: true, companies_synced: 0 });

  try {
    await syncFhForClient(supabase, client);
    return res.json({ ok: true, companies_synced: companies.length });
  } catch (err) {
    console.error("[PORTAL] FH sync error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRAWLER PAGES — /portal/api/crawl-pages
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /portal/api/crawl-pages ───────────────────────────────────────────────
// Returns all crawled pages for the client. Gracefully empty if table not yet migrated.
export async function handlePortalCrawlPages(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const { data, error } = await supabase
    .from("client_pages")
    .select("id, url, page_type, title, status, fetched_at, summary, error_message")
    .eq("client_id", clientId)
    .order("fetched_at", { ascending: false });

  if (error) {
    if (error.message?.includes("does not exist")) return res.json({ pages: [], total: 0 });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ pages: data ?? [], total: (data ?? []).length });
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING CONFIG — /portal/api/messaging
// Per-client SMS automation toggles (confirmation texts, reminders, etc.)
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGING_DEFAULTS = {
  enable_confirmation_texts:       false,
  enable_reminders:                false,
  reminder_hours_before:           24,
  reminder_24h:                    true,
  reminder_same_day:               false,
  enable_cancellations:            true,
  enable_rebooking:                false,
  enable_post_experience_followup: false,
  post_experience_hours_after:     24,
  review_url:                      null,
  website_url:                     null,
  custom_templates:                {},
};

// ── GET /portal/api/messaging ────────────────────────────────────────────────
// Returns messaging_config row for the client, or defaults if no row exists yet.
export async function handlePortalMessaging(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("messaging_config")
    .select("client_id, enable_confirmation_texts, enable_reminders, reminder_hours_before, reminder_24h, reminder_same_day, enable_cancellations, enable_rebooking, enable_post_experience_followup, post_experience_hours_after, review_url, website_url, custom_templates")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.json({ client_id: clientId, ...MESSAGING_DEFAULTS });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.json(data ?? { client_id: clientId, ...MESSAGING_DEFAULTS });
}

// ── PATCH /portal/api/messaging ───────────────────────────────────────────────
// Upserts messaging_config for the client. client_user → 403.
export async function handlePortalUpdateMessaging(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  // Only client_admin / internal_admin may write
  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }

  const body = req.body ?? {};
  const updates = { client_id: clientId, updated_at: new Date().toISOString() };

  const boolFields = ["enable_confirmation_texts", "enable_reminders", "reminder_24h", "reminder_same_day", "enable_cancellations", "enable_rebooking", "enable_post_experience_followup"];
  for (const f of boolFields) {
    if (body[f] !== undefined) updates[f] = !!body[f];
  }

  if (body.reminder_hours_before !== undefined) {
    const hrs = Number(body.reminder_hours_before);
    if (!Number.isInteger(hrs) || hrs < 1 || hrs > 168) {
      return res.status(400).json({ error: "reminder_hours_before must be an integer between 1 and 168" });
    }
    updates.reminder_hours_before = hrs;
  }

  if (body.post_experience_hours_after !== undefined) {
    const hrs = Number(body.post_experience_hours_after);
    if (!Number.isInteger(hrs) || hrs < 1 || hrs > 168) {
      return res.status(400).json({ error: "post_experience_hours_after must be an integer between 1 and 168" });
    }
    updates.post_experience_hours_after = hrs;
  }

  for (const urlField of ["review_url", "website_url"]) {
    if (body[urlField] !== undefined) {
      const v = body[urlField];
      if (v === null || v === "") { updates[urlField] = null; continue; }
      if (typeof v !== "string" || v.length > 500 || !/^https?:\/\//i.test(v)) {
        return res.status(400).json({ error: `${urlField} must be a valid http(s) URL ≤ 500 chars` });
      }
      updates[urlField] = v;
    }
  }

  if (body.custom_templates !== undefined) {
    if (typeof body.custom_templates !== "object" || Array.isArray(body.custom_templates)) {
      return res.status(400).json({ error: "custom_templates must be an object" });
    }
    // Sanitize: only allow known template keys, values must be strings ≤ 400 chars
    const VALID_TEMPLATE_KEYS = ["confirmation", "booking_followup", "reminder_24h", "reminder_same_day", "cancellation_rebook", "post_experience"];
    const sanitized = {};
    for (const [k, v] of Object.entries(body.custom_templates)) {
      if (VALID_TEMPLATE_KEYS.includes(k) && typeof v === "string") {
        sanitized[k] = v.slice(0, 400);
      }
    }
    updates.custom_templates = sanitized;
  }

  if (Object.keys(updates).length === 2) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("messaging_config")
    .upsert(updates, { onConflict: "client_id" })
    .select()
    .single();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.status(503).json({ error: "messaging_config table not found — run db1_messaging_config.sql migration" });
    }
    return res.status(500).json({ error: error.message });
  }

  console.log(`[PORTAL] messaging config updated for ${clientId}`);
  return res.json(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAST BOOKINGS — for the "Send follow-up to selected" UI
// GET /portal/api/messaging/past-bookings?days=30  → DB2 completed bookings
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalPastBookings(req, res, supabase, crmSupabase) {
  if (!crmSupabase) return res.status(503).json({ error: "CRM DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const days = Math.max(1, Math.min(90, Number(req.query?.days) || 30));
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const now    = new Date().toISOString();

  try {
    const { data: bookings, error } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk, customer_id, start_at, end_at, status, location, product_title, vehicle, customer_count, total_cents")
      .gte("end_at", cutoff)
      .lte("end_at", now)
      .not("fareharbor_pk", "ilike", "BOT-%")
      .order("end_at", { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });

    // Resolve customer name/phone in one batched query
    const custIds = [...new Set((bookings ?? []).map(b => b.customer_id).filter(Boolean))];
    let custMap = new Map();
    if (custIds.length) {
      const { data: custs } = await crmSupabase
        .from("customers")
        .select("id, name, normalized_phone")
        .in("id", custIds);
      custMap = new Map((custs ?? []).map(c => [c.id, c]));
    }

    // Annotate with already-scheduled-or-sent state so the UI can hide/disable
    const pks = (bookings ?? []).map(b => b.fareharbor_pk);
    let scheduledByPk = new Map();
    if (pks.length) {
      const { data: scheduled } = await supabase
        .from("scheduled_messages")
        .select("status, metadata")
        .eq("message_type", "post_experience")
        .in("metadata->>booking_pk", pks);
      for (const s of scheduled ?? []) {
        const pk = s.metadata?.booking_pk;
        if (pk) scheduledByPk.set(pk, s.status);
      }
    }

    const out = (bookings ?? []).map(b => {
      const cust = custMap.get(b.customer_id) ?? {};
      return {
        booking_pk:        b.fareharbor_pk,
        customer_name:     cust.name ?? null,
        phone:             cust.normalized_phone ?? null,
        end_at:            b.end_at,
        start_at:          b.start_at,
        location:          b.location,
        product_title:     b.product_title,
        vehicle:           b.vehicle,
        customer_count:    b.customer_count,
        total_cents:       b.total_cents,
        followup_status:   scheduledByPk.get(b.fareharbor_pk) ?? null, // null | pending | sent | failed
      };
    });
    return res.json({ bookings: out, count: out.length, window_days: days });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN POST-EXPERIENCE FOLLOW-UPS for the selected booking_pks
// POST /portal/api/messaging/post-experience/run
// Body: { booking_pks: ["CO-XXX", ...] }
// Returns: { scheduled, skipped, results: [{ booking_pk, status, reason? }] }
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalRunPostExperience(req, res, supabase, crmSupabase) {
  if (!supabase || !crmSupabase) return res.status(503).json({ error: "DB unavailable" });
  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const pks = Array.isArray(req.body?.booking_pks) ? req.body.booking_pks.slice(0, 100) : [];
  if (!pks.length) return res.status(400).json({ error: "booking_pks (array) required" });

  // Load config (template + URLs + hours)
  const { data: cfg } = await supabase
    .from("messaging_config")
    .select("post_experience_hours_after, review_url, website_url, custom_templates")
    .eq("client_id", clientId)
    .maybeSingle();

  // Look up bookings + customer info
  const { data: bookings } = await crmSupabase
    .from("bookings")
    .select("fareharbor_pk, customer_id, end_at, product_title, vehicle, location, company")
    .in("fareharbor_pk", pks);
  const custIds = [...new Set((bookings ?? []).map(b => b.customer_id).filter(Boolean))];
  const { data: custs } = await crmSupabase
    .from("customers")
    .select("id, name, normalized_phone")
    .in("id", custIds);
  const custMap = new Map((custs ?? []).map(c => [c.id, c]));

  const { schedulePostExperienceFollowUp, resolveBusinessName } = await import("./messagingEngine.js");
  const fromPhone = process.env.CSR_REA_TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER || null;

  const results = [];
  for (const b of bookings ?? []) {
    const cust = custMap.get(b.customer_id);
    if (!cust?.normalized_phone || !b.end_at) {
      results.push({ booking_pk: b.fareharbor_pk, scheduled: false, reason: "missing_phone_or_end_at" });
      continue;
    }
    const r = await schedulePostExperienceFollowUp({
      booking_pk: b.fareharbor_pk,
      end_at:     b.end_at,
      phone:      cust.normalized_phone,
      name:       cust.name ?? null,
      activity:   b.vehicle ?? b.product_title ?? "your adventure",
      // company on DB2 bookings is 'coloradosledrentals' | 'rabbitearsadventures' —
      // same shortname vocabulary resolveBusinessName expects, so a Rabbit Ears
      // Adventures past booking doesn't get a Colorado Sled Rentals-branded text.
      business:   resolveBusinessName(b.company),
    }, supabase, {
      hoursAfter: cfg?.post_experience_hours_after ?? 24,
      template:   cfg?.custom_templates?.post_experience ?? null,
      reviewUrl:  cfg?.review_url ?? "",
      websiteUrl: cfg?.website_url ?? "",
      fromPhone,
      clientId,
    });
    results.push({ booking_pk: b.fareharbor_pk, ...r });
  }

  const scheduled = results.filter(r => r.scheduled).length;
  const skipped   = results.length - scheduled;
  return res.json({ scheduled, skipped, results });
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TEST MESSAGE — preview an SMS template against real phone(s)
// POST /portal/api/messaging/test-send
// Body: { type, phones: [...], vars?: { name, activity, date, time, booking_link }, custom_body? }
// Auth: client_admin / internal_admin only.
// Sends immediately via Twilio, records to scheduled_messages with
// message_type='test_<type>' for the activity report.
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalTestSend(req, res, supabase, twilioClient) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!twilioClient) return res.status(503).json({ error: "Twilio unavailable" });
  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { type, phones, vars = {}, custom_body } = req.body ?? {};
  const VALID_TYPES = [
    "confirmation", "reminder_24h", "reminder_same_day",
    "cancellation_rebook", "booking_followup", "post_experience",
  ];
  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }
  if (!Array.isArray(phones) || !phones.length) {
    return res.status(400).json({ error: "phones (array of E.164 strings) required" });
  }
  if (phones.length > 5) {
    return res.status(400).json({ error: "test sends are limited to 5 phones at a time" });
  }
  // Normalize phones to E.164 (best-effort)
  const { normalizePhone } = await import("./phoneUtils.js");
  const normalized = phones.map(p => normalizePhone(p)).filter(Boolean);
  if (!normalized.length) return res.status(400).json({ error: "no valid phone numbers in request" });

  // Load template + URLs from messaging_config (with safe defaults)
  const { data: cfg } = await supabase
    .from("messaging_config")
    .select("custom_templates, review_url, website_url")
    .eq("client_id", clientId)
    .maybeSingle();

  const { DEFAULT_TEMPLATES, resolveTemplate } = await import("./messagingEngine.js");
  let body;
  // Common substitution vars — pulled from vars{} with safe defaults so the
  // test sender works even when the operator leaves a field blank.
  const tplVars = {
    name:        vars.name        ?? "Test",
    activity:    vars.activity    ?? "your booking",
    location:    vars.location    ?? "",
    date:        vars.date        ?? "Saturday",
    time:        vars.time        ?? "10:00 AM",
    bookingLink: vars.booking_link ?? "",
    reviewUrl:   cfg?.review_url  ?? "",
    websiteUrl:  cfg?.website_url ?? "",
  };

  if (typeof custom_body === "string" && custom_body.trim().length) {
    // Allow ad-hoc copy; still pass through resolveTemplate to honor {placeholders}
    body = resolveTemplate({ custom_templates: { [type]: custom_body } }, type, tplVars);
  } else if (cfg?.custom_templates?.[type] || DEFAULT_TEMPLATES[type]) {
    body = resolveTemplate(cfg, type, tplVars);
  } else {
    return res.status(400).json({ error: `no template configured for type ${type} — set one in custom_templates or pass custom_body` });
  }
  body = body.slice(0, 320);

  // Resolve from-number, in priority order:
  //   1. clients.outbound_phone (DB) — the canonical per-client number
  //   2. {CLIENT_ID}_TWILIO_NUMBER env var — legacy convention
  //   3. TWILIO_PHONE_NUMBER — global fallback (only useful when the client
  //      shares the main Highmark Twilio account)
  // Resolve subaccount creds if the client has them, so we don't try to send
  // from a number we don't own under the wrong account.
  const { data: clientRow } = await supabase
    .from("clients")
    .select("outbound_phone, twilio_account_sid, twilio_auth_token, messaging_service_sid")
    .eq("id", clientId)
    .maybeSingle();

  const fromKey   = `${clientId.toUpperCase()}_TWILIO_NUMBER`;
  const fromPhone = clientRow?.outbound_phone || process.env[fromKey] || process.env.TWILIO_PHONE_NUMBER || null;
  const msgServiceSid = clientRow?.messaging_service_sid || process.env.TWILIO_MESSAGING_SERVICE_SID || null;

  if (!fromPhone && !msgServiceSid) {
    return res.status(503).json({
      error: `No outbound Twilio number configured for client "${clientId}". Set outbound_phone in Settings → Identity, or add ${fromKey} to Railway env.`,
    });
  }

  // If the client has its own Twilio subaccount, use those creds — otherwise
  // the inherited shared client may not be authorized to send from the number.
  let sendClient = twilioClient;
  if (clientRow?.twilio_account_sid && clientRow?.twilio_auth_token) {
    try {
      const twilio = (await import("twilio")).default;
      sendClient = twilio(clientRow.twilio_account_sid, clientRow.twilio_auth_token);
    } catch (err) {
      console.warn(`[TEST-SEND] subaccount init failed for ${clientId}: ${err.message} — falling back to shared client`);
    }
  }

  // Send + audit per phone
  const results = [];
  for (const phone of normalized) {
    try {
      // Prefer Messaging Service SID over a bare from-number when set —
      // Twilio routes through the right pool + applies the right country rules.
      const sendOpts = msgServiceSid
        ? { body, messagingServiceSid: msgServiceSid, to: phone }
        : { body, from: fromPhone, to: phone };
      const msg = await sendClient.messages.create(sendOpts);
      // Audit the test send so it appears in the activity report
      try {
        await supabase.from("scheduled_messages").insert({
          phone,
          body,
          message_type: `test_${type}`,
          client_id:    clientId,
          send_at:      new Date().toISOString(),
          sent_at:      new Date().toISOString(),
          status:       "sent",
          twilio_sid:   msg.sid,
          attempts:     1,
          metadata:     {
            from_phone:   fromPhone,
            test:         true,
            triggered_by: req.portalUser?.email ?? null,
          },
        });
      } catch (auditErr) {
        console.warn("[TEST-SEND] audit insert failed:", auditErr.message);
      }
      results.push({ phone, success: true, twilio_sid: msg.sid });
    } catch (err) {
      results.push({ phone, success: false, error: err.message });
    }
  }
  const sent = results.filter(r => r.success).length;
  console.log(`[PORTAL] test-send type=${type} client=${clientId} sent=${sent}/${normalized.length} by=${req.portalUser?.email ?? "?"}`);
  return res.json({ sent, failed: results.length - sent, body_preview: body, results });
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ACTIVITY REPORT — recent scheduled_messages for this client
// GET /portal/api/messaging/activity?days=7&type=&status=&phone=&limit=200
// Returns the most recent rows for the client with the filters applied.
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalMessagingActivity(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const days    = Math.max(1, Math.min(90, Number(req.query?.days) || 7));
  const type    = req.query?.type    || null;
  const status  = req.query?.status  || null;
  const phone   = req.query?.phone   || null;
  const limit   = Math.max(1, Math.min(500, Number(req.query?.limit) || 200));

  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  let q = supabase
    .from("scheduled_messages")
    .select("id, phone, message_type, status, body, send_at, sent_at, attempts, max_attempts, twilio_sid, error, metadata, created_at")
    .eq("client_id", clientId)
    .gte("send_at", since)
    .order("send_at", { ascending: false })
    .limit(limit);

  // Hide the automated test suite's synthetic 555/999 numbers from the
  // activity report — same convention as conversations/leads. Gated on
  // TEST_MODE so the suite (which uses these numbers on the live DB) still
  // sees its own rows.
  if (process.env.TEST_MODE !== "true") {
    q = q.not("phone", "ilike", "+1555%").not("phone", "ilike", "+1999%");
  }

  if (type)   q = q.eq("message_type", type);
  if (status) q = q.eq("status", status);
  if (phone)  q = q.ilike("phone", `%${phone}%`);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Aggregate by status + type for the summary header
  const summary = { total: data?.length ?? 0, byStatus: {}, byType: {} };
  for (const r of data ?? []) {
    summary.byStatus[r.status]      = (summary.byStatus[r.status]      ?? 0) + 1;
    summary.byType[r.message_type]  = (summary.byType[r.message_type]  ?? 0) + 1;
  }
  return res.json({ messages: data ?? [], summary, window_days: days });
}

// ── GET /portal/api/bot-config ────────────────────────────────────────────────
// Returns bot_config row for client, falling back to the clients-table values
// (bot_name, tone, opener_text) when no per-client override row exists yet.
// Matches the documented runtime behavior so newly approved self-serve clients
// see their onboarding answers in the Bot tab without a separate seed step.
export async function handlePortalBotConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const client = getAllClients()[clientId] ?? {};
  const fallback = {
    client_id:           clientId,
    bot_name:            client.botName    ?? null,
    tone:                client.tone       ?? null,
    opener_text:         client.openerText ?? null,
    system_prompt_addon: null,
    handoff_message:     null,
  };

  const { data, error } = await supabase
    .from("bot_config")
    .select("bot_name, tone, opener_text, system_prompt_addon, handoff_message")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.json(fallback);
    }
    return res.status(500).json({ error: error.message });
  }

  if (!data) return res.json(fallback);

  return res.json({
    client_id:           clientId,
    bot_name:            data.bot_name            ?? fallback.bot_name,
    tone:                data.tone                ?? fallback.tone,
    opener_text:         data.opener_text         ?? fallback.opener_text,
    system_prompt_addon: data.system_prompt_addon ?? null,
    handoff_message:     data.handoff_message     ?? null,
  });
}

// ── PATCH /portal/api/bot-config ──────────────────────────────────────────────
// Upserts bot_config for the client. client_user → 403.
export async function handlePortalUpdateBotConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }

  const body = req.body ?? {};
  const updates = { client_id: clientId, updated_at: new Date().toISOString() };

  const textFields = ["bot_name", "tone", "opener_text", "system_prompt_addon", "handoff_message"];
  for (const f of textFields) {
    if (body[f] !== undefined) updates[f] = body[f] === "" ? null : String(body[f]);
  }

  if (Object.keys(updates).length === 2) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("bot_config")
    .upsert(updates, { onConflict: "client_id" })
    .select()
    .single();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.status(503).json({ error: "bot_config table not found — run db1_bot_config.sql migration" });
    }
    return res.status(500).json({ error: error.message });
  }

  console.log(`[PORTAL] bot config updated for ${clientId}`);
  return res.json(data);
}

// ── GET /portal/api/booking-config ────────────────────────────────────────────
// Returns booking_config row for client, or defaults.
export async function handlePortalBookingConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("booking_config")
    .select("booking_mode, booking_link, call_cta_text")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.json({ client_id: clientId, booking_mode: null, booking_link: null, call_cta_text: null });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.json(data ?? { client_id: clientId, booking_mode: null, booking_link: null, call_cta_text: null });
}

// ── PATCH /portal/api/booking-config ──────────────────────────────────────────
// Upserts booking_config for the client. client_user → 403.
export async function handlePortalUpdateBookingConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) {
    return res.status(403).json({ error: "Forbidden — admin role required" });
  }

  const body = req.body ?? {};
  const updates = { client_id: clientId, updated_at: new Date().toISOString() };

  const textFields = ["booking_mode", "booking_link", "call_cta_text"];
  for (const f of textFields) {
    if (body[f] !== undefined) updates[f] = body[f] === "" ? null : String(body[f]);
  }

  if (Object.keys(updates).length === 2) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("booking_config")
    .upsert(updates, { onConflict: "client_id" })
    .select()
    .single();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return res.status(503).json({ error: "booking_config table not found — run db1_booking_config.sql migration" });
    }
    return res.status(500).json({ error: error.message });
  }

  console.log(`[PORTAL] booking config updated for ${clientId}`);
  return res.json(data);
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING — Phase 3 (AI Auto-Config)
// internal_admin only for all three routes
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /portal/api/onboarding/analyze ───────────────────────────────────────
// Triggers the AI auto-config pipeline for a given URL.
// Body: { url: "https://..." }
// Returns: { draftId, draft, confidence, warnings, pagesCrawled }
export async function handleOnboardingAnalyze(req, res, supabase, anthropic) {
  if (!req.portalUser?.isAdmin) {
    return res.status(403).json({ error: "Internal admin only" });
  }

  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    new URL(url); // validate
  } catch {
    return res.status(400).json({ error: "Invalid URL — must include https://" });
  }

  try {
    const result = await startAutoConfig(
      url,
      anthropic,
      supabase,
      req.portalUser?.email ?? null
    );
    return res.json(result);
  } catch (err) {
    console.error("[ONBOARDING] analyze error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/onboarding/drafts/:id ─────────────────────────────────────
// Returns a draft by ID. internal_admin only.
export async function handleOnboardingGetDraft(req, res, supabase) {
  if (!req.portalUser?.isAdmin) {
    return res.status(403).json({ error: "Internal admin only" });
  }
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  const draft = await getDraft(id, supabase);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  return res.json({ draft });
}

// ── PATCH /portal/api/onboarding/drafts/:id ───────────────────────────────────
// Updates editable draft fields before committing.
// Body: { draft_client: {...}, draft_bot: {...}, draft_booking: {...} }
export async function handleOnboardingUpdateDraft(req, res, supabase) {
  if (!req.portalUser?.isAdmin) {
    return res.status(403).json({ error: "Internal admin only" });
  }
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  const updated = await updateDraft(id, req.body ?? {}, supabase);
  if (!updated) return res.status(404).json({ error: "Draft not found or no valid fields provided" });
  return res.json({ draft: updated });
}

// ── POST /portal/api/onboarding/drafts/:id/save ───────────────────────────────
// Commits the draft to a real client record.
// Returns: { clientId }
export async function handleOnboardingSave(req, res, supabase) {
  if (!req.portalUser?.isAdmin) {
    return res.status(403).json({ error: "Internal admin only" });
  }
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  try {
    const committed = await commitDraftToDb(id, supabase);
    await loadDbClients(supabase).catch(() => {});
    console.log(`[ONBOARDING] Client ${committed.clientId} now live`);

    // Enrich response with demo link + next steps so success UI works for review-then-save flow too
    const draft = await getDraft(id, supabase).catch(() => null);
    const facts  = draft?.extracted_facts ?? {};
    const appUrl = process.env.APP_URL ?? "https://highmark-bot-production.up.railway.app";
    const uiKey  = process.env.UI_SECRET ?? "highmark2026";
    return res.json({
      ...committed,
      demoLink:      `${appUrl}/ui?key=${uiKey}&client=${committed.clientId}`,
      nextSteps:     buildNextSteps(facts),
      pagesAnalyzed: draft?.pages_crawled ?? 0,
      onboardingStatus: "created",
      botMode:          "test",
    });
  } catch (err) {
    console.error("[ONBOARDING] save error:", err.message);
    const status = err.message.includes("not found") ? 404
                 : err.message.includes("already") ? 409
                 : 500;
    return res.status(status).json({ error: err.message });
  }
}

// ── POST /portal/api/onboarding/create-client ─────────────────────────────────
// Phase 4: One-click client creation from website URL.
// Runs auto-config (or reuses existing draft), creates client record, returns demo link.
// Body: { url, existingDraftId? }
// Returns: { clientId, clientName, draftId, demoLink, nextSteps, onboardingStatus, botMode,
//            pagesAnalyzed, confidence, warnings }
export async function handleOnboardingCreateClient(req, res, supabase, anthropic) {
  if (!req.portalUser?.isAdmin) {
    return res.status(403).json({ error: "Internal admin only" });
  }
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { url, existingDraftId } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });
  try { new URL(url); } catch {
    return res.status(400).json({ error: "Invalid URL — must include https://" });
  }

  try {
    const result = await createClientFromWebsite(url, anthropic, supabase, {
      createdBy:      req.portalUser.email,
      existingDraftId: existingDraftId ?? null,
    });
    await loadDbClients(supabase).catch(() => {});
    return res.status(201).json(result);
  } catch (err) {
    console.error("[ONBOARDING] create-client error:", err.message);
    const body = { error: err.message };
    if (err.existingClientId) body.existingClientId = err.existingClientId;
    return res.status(err.status ?? 500).json(body);
  }
}

// ── GET /admin/portal-users ───────────────────────────────────────────────────
export async function handleListPortalUsers(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const { data, error } = await supabase
    .from("portal_users")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: data ?? [] });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Custom API Integration handlers
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /portal/api/custom-integrations ──────────────────────────────────────
export async function handleGetCustomIntegrations(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });
  try {
    const rows = await getClientIntegrations(supabase, clientId);
    return res.json({ integrations: rows.map(sanitizeForPortal) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/custom-integrations ─────────────────────────────────────
export async function handleCreateCustomIntegration(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });
  try {
    const { data, error } = await createIntegration(supabase, clientId, req.body ?? {});
    if (error) return res.status(400).json({ error });
    return res.status(201).json({ integration: sanitizeForPortal(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── PATCH /portal/api/custom-integrations/:id ────────────────────────────────
export async function handleUpdateCustomIntegration(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });
  const { id } = req.params;
  try {
    const { data, error } = await updateIntegration(supabase, id, clientId, req.body ?? {});
    if (error) return res.status(400).json({ error });
    if (!data)  return res.status(404).json({ error: "Integration not found" });
    return res.json({ integration: sanitizeForPortal(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── DELETE /portal/api/custom-integrations/:id ───────────────────────────────
export async function handleDeleteCustomIntegration(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });
  const { id } = req.params;
  try {
    const { error } = await deleteIntegration(supabase, id, clientId);
    if (error) return res.status(500).json({ error });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/custom-integrations/:id/test ────────────────────────────
// Body: { endpoint_index: 0, params: {} }
export async function handleTestCustomIntegration(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const endpointIdx    = req.body?.endpoint_index ?? 0;
  const overrideParams = req.body?.params ?? {};

  try {
    // Fetch full row (including auth secrets) from DB for the test
    const rows = await getClientIntegrations(supabase, clientId);
    const integration = rows.find((r) => r.id === id);
    if (!integration) return res.status(404).json({ error: "Integration not found" });

    const result = await testEndpoint(integration, endpointIdx, overrideParams);

    // Persist test result + schema if successful
    const updates = {
      last_tested_at:   new Date().toISOString(),
      last_test_status: result.ok ? "connected" : "failed",
    };
    if (result.ok && result.schema)  updates.response_schema = result.schema;
    if (result.ok && result.sample)  updates.sample_response = result.sample;
    await supabase.from("client_api_integrations").update(updates).eq("id", id);

    // Never expose full response body through portal — return schema + summary
    return res.json({
      ok:           result.ok,
      status:       result.status ?? null,
      error:        result.error  ?? null,
      schema:       result.schema ?? null,
      sample:       result.sample ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Phase 7 — Optimization Engine ────────────────────────────────────────────

// GET /portal/api/optimization
// Returns latest insights + score for the requesting client.
export async function handleGetOptimization(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  try {
    const result = await getOptimizationInsights(supabase, clientId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /portal/api/optimization/run
// Triggers a fresh analysis run. Requires internal_admin or client_admin.
export async function handleRunOptimizationAnalysis(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const user = req.portalUser;
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.role === "client_user") return res.status(403).json({ error: "Forbidden" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  // Resolve the client object (needed by analysis engine for config gap checks)
  const allClients = getAllClients();
  const client = allClients[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const result = await runOptimizationAnalysis(supabase, client);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /portal/api/optimization/dismiss/:id
// Marks an insight as dismissed so it no longer appears.
export async function handleDismissInsight(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "id required" });

  try {
    const result = await dismissInsight(supabase, id, clientId);
    if (result.error) return res.status(500).json({ error: result.error });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Phase 8 — Rewrite Engine ───────────────────────────────────────────────

// GET /portal/api/rewrites
// Returns all non-rejected rewrite suggestions for the client.
export async function handleGetRewrites(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  try {
    const result = await getRewriteSuggestions(supabase, clientId);
    if (result.error) return res.status(500).json({ error: result.error });
    return res.json({ suggestions: result.suggestions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// POST /portal/api/rewrites/run
// Generates new rewrite suggestions. Requires client_admin or internal_admin.
export async function handleRunRewrites(req, res, supabase, anthropic) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!anthropic) return res.status(503).json({ error: "AI unavailable" });

  const user = req.portalUser;
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.role === "client_user") return res.status(403).json({ error: "Forbidden" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const allClients = getAllClients();
  const client = allClients[clientId];
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    const result = await runRewriteGeneration(supabase, anthropic, client);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// PATCH /portal/api/rewrites/:id
// Accept (optionally with edited message), reject, or reset to pending.
// Requires client_admin or internal_admin.
export async function handleUpdateRewriteStatus(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const user = req.portalUser;
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.role === "client_user") return res.status(403).json({ error: "Forbidden" });

  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "id required" });

  const { status, edited_message } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "status required" });

  try {
    const result = await updateRewriteStatus(
      supabase, id, clientId, status,
      edited_message ?? null,
      user.email ?? null,
    );
    if (result.error) return res.status(500).json({ error: result.error });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBED CONFIG — Phase 11.2: Widget Embed Builder
// GET  /portal/api/embed-config  → load config (defaults if no row yet)
// PATCH /portal/api/embed-config → upsert config
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_DEFAULTS = {
  primary_color:   "#2563eb",
  button_color:    "#2563eb",
  text_color:      "#ffffff",
  button_text:     "Chat with us",
  show_icon:       true,
  size:            "medium",
  border_radius:   "16",
  logo_url:        null,
  welcome_message: null,
  delay_seconds:   0,
  auto_open:       false,
  position:        "bottom_right",
  bottom_offset:   20,
};

const EMBED_ALLOWED_FIELDS = Object.keys(EMBED_DEFAULTS);

export async function handlePortalEmbedConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  try {
    const { data, error } = await supabase
      .from("embed_config")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();

    if (error) {
      // Table not yet created — return defaults so the portal still renders
      if (error.code === "42P01" || error.message?.includes("does not exist")) {
        return res.json({ ...EMBED_DEFAULTS, clientId, _tableNotReady: true });
      }
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ...EMBED_DEFAULTS, ...(data ?? {}), clientId });
  } catch (err) {
    return res.json({ ...EMBED_DEFAULTS, clientId, _tableNotReady: true });
  }
}

export async function handlePortalUpdateEmbedConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });

  const updates = { client_id: clientId, updated_at: new Date().toISOString() };
  for (const field of EMBED_ALLOWED_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length <= 2) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  try {
    const { error } = await supabase
      .from("embed_config")
      .upsert(updates, { onConflict: "client_id" });

    if (error) {
      if (error.code === "42P01" || error.message?.includes("does not exist")) {
        return res.status(503).json({ error: "embed_config table not set up yet — run db1_embed_config.sql in Supabase to enable saving." });
      }
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, clientId, updated: Object.keys(updates).filter(k => k !== "client_id" && k !== "updated_at") });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handlePortalPerformance — GET /portal/api/performance
// Phase 11.10: primary analytics metrics for the Analytics tab.
// Returns chatStarts, leadsWeb, bookingClicks, conversionRate, channelBreakdown,
// topPages, insights.
// Query params: ?days=7 (default 7; supports 1 | 7 | 30 | 90)
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalPerformance(req, res, supabase, resolveClientId) {
  if (!supabase) return res.status(503).json({ error: "Database unavailable." });
  const clientId = await resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: "Client not found." });

  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

  try {
    const data = await getPerformanceData(supabase, clientId, days);
    if (!data) return res.status(503).json({ error: "Performance data unavailable." });
    return res.json({ ...data, clientId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// handlePortalAttribution — GET /portal/api/attribution
// Phase 11.5: visitor tracking + page-level attribution data.
// Returns top pages, summary counts, and plain-language insights.
// Query params: ?days=30 (default 30, supports 7 | 30 | 90)
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePortalAttribution(req, res, supabase, resolveClientId) {
  if (!supabase) return res.status(503).json({ error: "Database unavailable." });
  const clientId = await resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: "Client not found." });

  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));

  try {
    const data = await getAttributionData(supabase, clientId, days);
    if (!data) return res.status(503).json({ error: "Attribution data unavailable." });
    return res.json({ ...data, days, clientId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTNER ACTIVITIES CRUD (Sprint 5)  — /portal/api/partners
// Read: any portal user (client-scoped).  Mutating: client_admin+.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_PARTNER_CATEGORIES = ["tour", "rental", "lodging", "dining", "transport", "other"];
const VALID_PARTNER_SEASONS    = ["all", "winter", "summer", "shoulder"];

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function validatePartnerInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (body.partner_name !== undefined) {
    const v = String(body.partner_name ?? "").trim();
    if (!v) errors.push("partner_name is required");
    out.partner_name = v;
  } else if (!partial) errors.push("partner_name is required");

  if (body.activity_name !== undefined) {
    const v = String(body.activity_name ?? "").trim();
    if (!v) errors.push("activity_name is required");
    out.activity_name = v;
  } else if (!partial) errors.push("activity_name is required");

  if (body.booking_url !== undefined) {
    const v = String(body.booking_url ?? "").trim();
    try { new URL(v); } catch { errors.push("booking_url must be a valid URL"); }
    out.booking_url = v;
  } else if (!partial) errors.push("booking_url is required");

  if (body.category !== undefined) {
    const v = String(body.category ?? "").trim().toLowerCase();
    if (!VALID_PARTNER_CATEGORIES.includes(v)) {
      errors.push(`category must be one of: ${VALID_PARTNER_CATEGORIES.join(", ")}`);
    }
    out.category = v;
  } else if (!partial) errors.push("category is required");

  if (body.description !== undefined) out.description = String(body.description ?? "").trim();
  if (body.price_range !== undefined) out.price_range = body.price_range ? String(body.price_range).trim() : null;
  if (body.location    !== undefined) out.location    = body.location    ? String(body.location).trim()    : null;

  if (body.commission_pct !== undefined && body.commission_pct !== null && body.commission_pct !== "") {
    const n = Number(body.commission_pct);
    if (Number.isNaN(n) || n < 0 || n > 100) errors.push("commission_pct must be 0–100");
    else out.commission_pct = n;
  } else if (body.commission_pct === null || body.commission_pct === "") {
    out.commission_pct = null;
  }

  if (body.seasons !== undefined) {
    const arr = normalizeStringArray(body.seasons).map((s) => s.toLowerCase());
    for (const s of arr) {
      if (!VALID_PARTNER_SEASONS.includes(s)) { errors.push(`seasons: "${s}" invalid`); break; }
    }
    out.seasons = arr.length ? arr : ["all"];
  }

  if (body.keywords !== undefined) out.keywords = normalizeStringArray(body.keywords);
  if (body.enabled  !== undefined) out.enabled  = !!body.enabled;
  if (body.metadata !== undefined && typeof body.metadata === "object" && body.metadata !== null) {
    out.metadata = body.metadata;
  }

  return { errors, values: out };
}

// GET /portal/api/partners
export async function handlePortalPartners(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("partner_activities")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });

  if (error) {
    if (error.message?.includes("does not exist")) return res.json({ partners: [] });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ partners: data ?? [] });
}

// POST /portal/api/partners
export async function handlePortalCreatePartner(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { errors, values } = validatePartnerInput(req.body ?? {}, { partial: false });
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const row = { client_id: clientId, enabled: true, seasons: ["all"], keywords: [], ...values };

  const { data, error } = await supabase.from("partner_activities").insert(row).select().single();
  if (error) {
    if (error.message?.includes("does not exist")) {
      return res.status(503).json({ error: "Run db1_partner_activities.sql migration first" });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ partner: data });
}

// PATCH /portal/api/partners/:id
export async function handlePortalUpdatePartner(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("partner_activities").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Partner not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const { errors, values } = validatePartnerInput(req.body ?? {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  if (Object.keys(values).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }
  values.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("partner_activities").update(values).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ partner: data });
}

// DELETE /portal/api/partners/:id
export async function handlePortalDeletePartner(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("partner_activities").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing) return res.status(404).json({ error: "Partner not found" });
  if (existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const { error } = await supabase.from("partner_activities").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// GET /portal/api/partners/analytics — click counts per partner over ?days=30
export async function handlePortalPartnerAnalytics(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const days  = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [{ data: partners }, { data: events }] = await Promise.all([
      supabase.from("partner_activities").select("id, partner_name, activity_name, category").eq("client_id", clientId),
      supabase.from("web_events").select("event_type, metadata, created_at")
        .eq("client_id", clientId)
        .in("event_type", ["partner_link_sent", "partner_link_clicked"])
        .gte("created_at", since),
    ]);

    const totals = new Map(); // partner_id -> { sent, clicked }
    for (const e of events ?? []) {
      const pid = e.metadata?.partner_id;
      if (!pid) continue;
      if (!totals.has(pid)) totals.set(pid, { sent: 0, clicked: 0 });
      const bucket = totals.get(pid);
      if (e.event_type === "partner_link_sent")    bucket.sent++;
      if (e.event_type === "partner_link_clicked") bucket.clicked++;
    }

    const rows = (partners ?? []).map((p) => {
      const t = totals.get(p.id) ?? { sent: 0, clicked: 0 };
      const ctr = t.sent > 0 ? Math.round((t.clicked / t.sent) * 1000) / 10 : 0;
      return { ...p, sent: t.sent, clicked: t.clicked, click_through_rate: ctr };
    }).sort((a, b) => b.clicked - a.clicked);

    const summary = rows.reduce((acc, r) => {
      acc.totalSent    += r.sent;
      acc.totalClicked += r.clicked;
      return acc;
    }, { totalSent: 0, totalClicked: 0 });

    return res.json({ days, rows, summary, clientId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR PHONES CRUD (Sprint C) — /portal/api/operator-phones
// Read: any portal user (client-scoped). Mutating: client_admin+.
// Each row drives:
//   • internal-mode SMS access for that phone (detectOwner consults the table)
//   • per-phone daily digest preferences (times + types + timezone)
//   • last_digest_sent_at stamp (read-only; updated by the dispatcher)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_OPERATOR_ROLES        = [
  "owner", "manager", "sales", "staff", // legacy (back-compat)
  "general_manager", "operations_manager", "reservations", "fleet", "mechanic", "guide", "marketing", // 2.0
];
const VALID_DIGEST_TYPES          = ["all", "bookings", "revenue", "leads", "staffing", "issues", "weather", "fleet", "maintenance", "safety"];
const VALID_OPERATOR_LOCATIONS    = ["steamboat", "north_routt", "kremmling", "rabbit_ears"];
const VALID_BRIEFING_DETAIL       = ["auto", "summary", "detailed", "executive", "standard", "operational", "diagnostic"];
const DIGEST_TIME_RE              = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM 24-hour

function validateOperatorPhoneInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (body.phone !== undefined) {
    const normalized = normalizePhone(String(body.phone ?? "").trim());
    if (!normalized) errors.push("phone must be a valid US phone number");
    else out.phone = normalized;
  } else if (!partial) {
    errors.push("phone is required");
  }

  if (body.label !== undefined) {
    out.label = body.label ? String(body.label).trim().slice(0, 60) : null;
  }

  if (body.display_name !== undefined) {
    out.display_name = body.display_name ? String(body.display_name).trim().slice(0, 40) : null;
  }

  if (body.role !== undefined) {
    const v = String(body.role).toLowerCase().trim();
    if (!VALID_OPERATOR_ROLES.includes(v)) {
      errors.push(`role must be one of: ${VALID_OPERATOR_ROLES.join(", ")}`);
    } else out.role = v;
  }

  if (body.internal_mode_enabled !== undefined) {
    if (typeof body.internal_mode_enabled !== "boolean") {
      errors.push("internal_mode_enabled must be a boolean");
    } else out.internal_mode_enabled = body.internal_mode_enabled;
  }

  if (body.daily_digest_enabled !== undefined) {
    if (typeof body.daily_digest_enabled !== "boolean") {
      errors.push("daily_digest_enabled must be a boolean");
    } else out.daily_digest_enabled = body.daily_digest_enabled;
  }

  if (body.digest_times !== undefined) {
    const arr = Array.isArray(body.digest_times) ? body.digest_times : [];
    const cleaned = [];
    for (const t of arr) {
      const v = String(t ?? "").trim();
      if (!DIGEST_TIME_RE.test(v)) {
        errors.push(`digest_times: "${t}" is not HH:MM (24-hour)`);
        break;
      }
      cleaned.push(v);
    }
    if (!cleaned.length && !partial) errors.push("digest_times must have at least one HH:MM entry");
    if (cleaned.length) out.digest_times = cleaned;
  }

  if (body.digest_types !== undefined) {
    const arr = Array.isArray(body.digest_types) ? body.digest_types : [];
    const cleaned = [];
    for (const t of arr) {
      const v = String(t ?? "").toLowerCase().trim();
      if (!VALID_DIGEST_TYPES.includes(v)) {
        errors.push(`digest_types: "${t}" must be one of ${VALID_DIGEST_TYPES.join(", ")}`);
        break;
      }
      cleaned.push(v);
    }
    if (cleaned.length) out.digest_types = cleaned;
  }

  if (body.locations !== undefined) {
    const arr = Array.isArray(body.locations) ? body.locations : [];
    const cleaned = [];
    for (const l of arr) {
      const v = String(l ?? "").toLowerCase().trim();
      if (v === "all") continue; // 'all' is represented as empty (unscoped)
      if (!VALID_OPERATOR_LOCATIONS.includes(v)) {
        errors.push(`locations: "${l}" must be one of ${VALID_OPERATOR_LOCATIONS.join(", ")}`);
        break;
      }
      if (!cleaned.includes(v)) cleaned.push(v);
    }
    if (!errors.length) out.locations = cleaned; // empty array = unscoped (all)
  }

  if (body.briefing_detail !== undefined) {
    const v = String(body.briefing_detail ?? "").toLowerCase().trim();
    if (!VALID_BRIEFING_DETAIL.includes(v)) {
      errors.push(`briefing_detail must be one of: ${VALID_BRIEFING_DETAIL.join(", ")}`);
    } else out.briefing_detail = v;
  }

  if (body.timezone !== undefined) {
    const tz = String(body.timezone ?? "").trim();
    if (!tz) errors.push("timezone cannot be empty");
    else {
      // Validate via Intl.DateTimeFormat — throws on unknown zones
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date()); out.timezone = tz; }
      catch { errors.push(`timezone "${tz}" is not a valid IANA zone`); }
    }
  }

  return { errors, values: out };
}

// GET /portal/api/operator-phones
export async function handlePortalOperatorPhones(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("operator_phones")
    .select("id, client_id, phone, label, display_name, role, internal_mode_enabled, daily_digest_enabled, digest_times, digest_types, locations, briefing_detail, timezone, last_digest_sent_at, created_at, updated_at")
    .eq("client_id", clientId)
    .order("role", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    if (error.message?.includes("does not exist")) return res.json({ phones: [] });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ phones: data ?? [] });
}

// POST /portal/api/operator-phones
export async function handlePortalCreateOperatorPhone(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { errors, values } = validateOperatorPhoneInput(req.body ?? {}, { partial: false });
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  const row = {
    client_id:              clientId,
    role:                   "staff",
    internal_mode_enabled:  true,
    daily_digest_enabled:   true,
    digest_times:           ["06:30"],
    digest_types:           ["all"],
    locations:              [],
    briefing_detail:        "auto",
    display_name:           null,
    timezone:               "America/Denver",
    ...values,
  };

  const { data, error } = await supabase
    .from("operator_phones")
    .insert(row)
    .select()
    .single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That phone is already configured for this client." });
    if (error.message?.includes("does not exist")) {
      return res.status(503).json({ error: "Run db1_operator_phones.sql migration first" });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ phone: data });
}

// PATCH /portal/api/operator-phones/:id
export async function handlePortalUpdateOperatorPhone(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("operator_phones").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing)             return res.status(404).json({ error: "Operator phone not found" });
  if (existing.client_id !== clientId)   return res.status(403).json({ error: "Access denied" });

  const { errors, values } = validateOperatorPhoneInput(req.body ?? {}, { partial: true });
  if (errors.length)                     return res.status(400).json({ error: errors.join("; ") });
  if (Object.keys(values).length === 0)  return res.status(400).json({ error: "No updatable fields provided" });

  const { data, error } = await supabase
    .from("operator_phones").update(values).eq("id", id).select().single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That phone is already configured for this client." });
    return res.status(500).json({ error: error.message });
  }
  return res.json({ phone: data });
}

// DELETE /portal/api/operator-phones/:id
export async function handlePortalDeleteOperatorPhone(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: existing, error: fetchErr } = await supabase
    .from("operator_phones").select("id, client_id").eq("id", id).single();
  if (fetchErr || !existing)             return res.status(404).json({ error: "Operator phone not found" });
  if (existing.client_id !== clientId)   return res.status(403).json({ error: "Access denied" });

  const { error } = await supabase.from("operator_phones").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// POST /portal/api/operator-phones/:id/test — send a one-off briefing right now
export async function handlePortalTestOperatorPhone(req, res, supabase, twilioClient, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { id } = req.params;
  const { data: row, error: fetchErr } = await supabase
    .from("operator_phones")
    .select("id, client_id, phone, role, label, display_name, digest_types, locations, briefing_detail")
    .eq("id", id)
    .single();
  if (fetchErr || !row)             return res.status(404).json({ error: "Operator phone not found" });
  if (row.client_id !== clientId)   return res.status(403).json({ error: "Access denied" });

  const clients = getAllClients();
  const client  = clients[clientId];
  if (!client)  return res.status(404).json({ error: `Client '${clientId}' not found` });

  try {
    const { generateDailyBriefing } = await import("./operatorBriefing.js");
    const result = await generateDailyBriefing(client, supabase, twilioClient, crmSupabase, {
      toPhone:     row.phone,
      dedupKey:    `${clientId}:${row.id}:test:${Date.now()}`,
      opRowId:        row.id,
      role:           row.role ?? "owner",
      displayName:    row.display_name ?? null,
      label:          row.label ?? null,
      digestTypes:    row.digest_types ?? ["all"],
      locations:      row.locations ?? null,
      briefingDetail: row.briefing_detail ?? "auto",
    });
    return res.json({
      ok:      !!result.success,
      sent:    result.sent ?? false,
      preview: result.preview ?? null,
      reason:  result.reason ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /portal/api/operator/preview-briefing — generate but do not send
export async function handlePortalPreviewBriefing(req, res, supabase, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const clients = getAllClients();
  const client  = clients[clientId];
  if (!client)  return res.status(404).json({ error: `Client '${clientId}' not found` });

  try {
    const {
      buildBriefingText,
      getTodaysAvailability,
      getTodaysManifest,
      getUpcomingManifest,
      getHotLeads,
      getWeatherSnapshot,
      getWeeklyRevenueEstimate,
      getUpcomingRevenue,
      getSeasonRevenue,
      getNewBookingsStats,
      detectOperationalIssues,
      detectUnpaidBookings,
      detectMissingWaivers,
      detectOverlappingArrivals,
      detectHighValueBookings,
      detectDuplicateBookings,
      detectMissingPhones,
      detectPacingSignal,
      detectLocationConcentration,
      detectUnresolvedHandoffs,
    } = await import("./operatorBriefing.js");

    const [
      todaySlots, manifest, upcomingManifest, hotLeads, weatherSnap, revenue, upcomingRevenue, seasonRevenue, newBookings, issues,
      unpaid, missingWaivers, overlaps, highValue, duplicates, missingPhones, pacing, locationMix, unresolvedHandoffs,
    ] = await Promise.all([
      getTodaysAvailability(clientId, supabase),
      getTodaysManifest(clientId, crmSupabase),
      getUpcomingManifest(crmSupabase, 7),
      getHotLeads(clientId, supabase, 3),
      getWeatherSnapshot(supabase, clientId),
      getWeeklyRevenueEstimate(clientId, supabase, crmSupabase),
      getUpcomingRevenue(clientId, crmSupabase, 7),
      getSeasonRevenue(client, crmSupabase, supabase),
      getNewBookingsStats(crmSupabase, supabase),
      detectOperationalIssues(client, supabase, crmSupabase),
      detectUnpaidBookings(crmSupabase),
      detectMissingWaivers(crmSupabase),
      detectOverlappingArrivals(crmSupabase),
      detectHighValueBookings(crmSupabase),
      detectDuplicateBookings(crmSupabase),
      detectMissingPhones(crmSupabase),
      detectPacingSignal(crmSupabase, supabase),
      detectLocationConcentration(crmSupabase),
      detectUnresolvedHandoffs(supabase, clientId),
    ]);

    const preview = buildBriefingText(client, todaySlots, hotLeads, weatherSnap, {
      manifest, upcomingManifest, upcomingRevenue,
      revenue, seasonRevenue, newBookings, issues,
      unpaid, missingWaivers, overlaps, highValue, duplicates, missingPhones, pacing, locationMix, unresolvedHandoffs,
    });
    return res.json({
      preview,
      chars:         preview.length,
      issues,
      hotLeadsCount: hotLeads.length,
      manifestCount: manifest.length,
      signals: {
        unpaid:           unpaid.length,
        missingWaivers:   missingWaivers.length,
        overlaps:         overlaps.length,
        highValue:        highValue.length,
        duplicates:       duplicates.length,
        missingPhones:    missingPhones.length,
        unresolvedHandoffs: unresolvedHandoffs.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
