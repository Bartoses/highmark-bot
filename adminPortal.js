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
import { normalizePhone, isValidPhone } from "./phoneUtils.js";
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

  // ── Run all queries in parallel ──────────────────────────────────────────
  const [
    smsR, webR, periodConvR,
    periodLeadsR, bookingClkR,
    actConvR, actLeadsR, actWebR,
    checklistR,
  ] = await Promise.allSettled([
    // All-time SMS conversations
    supabase.from("conversations").select("*", { count: "exact", head: true })
      .eq("client_id", clientId).neq("session_type", "test")
      .not("from_number", "like", "web:%"),

    // All-time web conversations
    supabase.from("conversations").select("*", { count: "exact", head: true })
      .eq("client_id", clientId).neq("session_type", "test")
      .like("from_number", "web:%"),

    // Period-filtered conversations
    (() => {
      let q = supabase.from("conversations").select("*", { count: "exact", head: true })
        .eq("client_id", clientId).neq("session_type", "test");
      if (since) q = q.gte("updated_at", since);
      return q;
    })(),

    // Period-filtered leads (all, for funnel counts)
    (() => {
      let q = supabase.from("leads").select("status")
        .eq("client_id", clientId).limit(1000);
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
    supabase.from("conversations")
      .select("id, from_number, handoff, updated_at")
      .eq("client_id", clientId).neq("session_type", "test")
      .order("updated_at", { ascending: false }).limit(20),

    // Activity: recent leads
    supabase.from("leads").select("id, status, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }).limit(10),

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
    const leads = await selectAudience(supabase, { clientId, audienceType, filterConfig }, crmSupabase);
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

  // Reload runtime client registry
  const { data: allRows } = await supabase.from("clients").select("*").eq("active", true);
  loadDbClients(allRows ?? []);

  return res.json({
    ok:      true,
    clientId,
    updated: Object.keys(updates).filter(k => k !== "updated_at"),
  });
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

  const [convRes, webRes] = await Promise.all([
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .gte("updated_at", monthStart),
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
  enable_confirmation_texts: false,
  enable_reminders:          false,
  reminder_hours_before:     24,
  reminder_24h:              true,
  reminder_same_day:         false,
  enable_cancellations:      true,
  enable_rebooking:          false,
  custom_templates:          {},
};

// ── GET /portal/api/messaging ────────────────────────────────────────────────
// Returns messaging_config row for the client, or defaults if no row exists yet.
export async function handlePortalMessaging(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("messaging_config")
    .select("client_id, enable_confirmation_texts, enable_reminders, reminder_hours_before, reminder_24h, reminder_same_day, enable_cancellations, enable_rebooking, custom_templates")
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

  const boolFields = ["enable_confirmation_texts", "enable_reminders", "reminder_24h", "reminder_same_day", "enable_cancellations", "enable_rebooking"];
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

  if (body.custom_templates !== undefined) {
    if (typeof body.custom_templates !== "object" || Array.isArray(body.custom_templates)) {
      return res.status(400).json({ error: "custom_templates must be an object" });
    }
    // Sanitize: only allow known template keys, values must be strings ≤ 400 chars
    const VALID_TEMPLATE_KEYS = ["reminder_24h", "reminder_same_day", "cancellation_rebook"];
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
