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
import { createCampaign, enqueueCampaign, getCampaignStats } from "./campaigns.js";
import { VALID_BOOKING_MODES, serializeClient, handleCreateClient, handleUpdateClient } from "./adminClients.js";
import { normalizePhone, isValidPhone } from "./phoneUtils.js";
import { startAutoConfig, getDraft, updateDraft, commitDraftToDb, createClientFromWebsite, buildNextSteps } from "./onboardingConfig.js";
import {
  createIntegration, updateIntegration, deleteIntegration,
  getClientIntegrations, testEndpoint, sanitizeForPortal,
} from "./apiIntegrations.js";
import { runOptimizationAnalysis, getOptimizationInsights, dismissInsight } from "./optimizationEngine.js";

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
  website_url:             "website_url",
  booking_link:            "booking_link",
  booking_mode:            "booking_mode",
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

// ── GET /portal/api/dashboard ─────────────────────────────────────────────────
export async function handlePortalDashboard(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const clients    = getAllClients();
  const clientName = clients[clientId]?.name ?? clientId;

  // Lead summary (last 200 for counts + recent 5)
  const { data: leads } = await supabase
    .from("leads")
    .select("id, status, contact_name, contact_phone, lead_type, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(200);

  const leadCounts = { new: 0, contacted: 0, engaged: 0, converted: 0, scheduled: 0, total: 0 };
  for (const l of (leads ?? [])) {
    leadCounts.total++;
    if (leadCounts[l.status] !== undefined) leadCounts[l.status]++;
  }

  // Campaign summary (recent 5)
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name, status, created_at, metadata")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(5);

  // Demo analytics (last 30 days, non-blocking)
  let demoStarts = 0;
  let demoLeadsCaptured = 0;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: events } = await supabase
      .from("demo_events")
      .select("event_name")
      .eq("client_id", clientId)
      .gte("created_at", since);
    for (const e of (events ?? [])) {
      if (e.event_name === "demo_started")       demoStarts++;
      if (e.event_name === "demo_lead_captured") demoLeadsCaptured++;
    }
  } catch { /* non-fatal */ }

  return res.json({
    clientId,
    clientName,
    leads: {
      ...leadCounts,
      recent: (leads ?? []).slice(0, 5),
    },
    campaigns: {
      total:  (campaigns ?? []).length,
      recent: campaigns ?? [],
    },
    analytics: {
      demoStarts,
      demoLeadsCaptured,
      period: "30d",
    },
  });
}

// ── GET /portal/api/leads ─────────────────────────────────────────────────────
// Query params: status, lead_type, limit (default 50), offset (default 0)
export async function handlePortalLeads(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { status, lead_type, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status)    query = query.eq("status", status);
  if (lead_type) query = query.eq("lead_type", lead_type);

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

  const { status, notes } = req.body;
  if (status && !VALID_LEAD_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${VALID_LEAD_STATUSES.join(", ")}`,
    });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (notes  !== undefined) updates.notes  = notes;

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided (status or notes)" });
  }

  const { data, error } = await supabase
    .from("leads").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ lead: data });
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

  const { name, message_body, audience_type, scheduled_at } = req.body;
  if (!name)         return res.status(400).json({ error: "name is required" });
  if (!message_body) return res.status(400).json({ error: "message_body is required" });

  try {
    const campaign = await createCampaign(supabase, {
      clientId,
      name,
      messageBody:  message_body,
      audienceType: audience_type,
      scheduledAt:  scheduled_at ?? null,
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
    websiteUrl:              client.websiteUrl            ?? null,
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
  enable_cancellations:      true,
  enable_rebooking:          false,
};

// ── GET /portal/api/messaging ────────────────────────────────────────────────
// Returns messaging_config row for the client, or defaults if no row exists yet.
export async function handlePortalMessaging(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("messaging_config")
    .select("client_id, enable_confirmation_texts, enable_reminders, reminder_hours_before, enable_cancellations, enable_rebooking")
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

  const boolFields = ["enable_confirmation_texts", "enable_reminders", "enable_cancellations", "enable_rebooking"];
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
// Returns bot_config row for client, or defaults from the client object.
export async function handlePortalBotConfig(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { data, error } = await supabase
    .from("bot_config")
    .select("bot_name, tone, opener_text, system_prompt_addon, handoff_message")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      // Table not yet created — return empty defaults
      return res.json({ client_id: clientId, bot_name: null, tone: null, opener_text: null, system_prompt_addon: null, handoff_message: null });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.json(data ?? { client_id: clientId, bot_name: null, tone: null, opener_text: null, system_prompt_addon: null, handoff_message: null });
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
  const client = allClients.find(c => c.id === clientId);
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
