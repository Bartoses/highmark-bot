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
import { createCampaign, enqueueCampaign, getCampaignStats } from "./campaigns.js";
import { VALID_BOOKING_MODES } from "./adminClients.js";

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
// internal_admin: returns all active clients (id + name)
// client_user: returns only their own client
export async function handlePortalClients(req, res) {
  const { portalUser } = req;
  const clients = getAllClients();

  if (portalUser.role === "internal_admin") {
    const list = Object.values(clients)
      .filter(c => c.active !== false)
      .map(c => ({ id: c.id, name: c.name, bookingMode: c.bookingMode }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ clients: list });
  }

  // client_user — only their own
  const c = clients[portalUser.clientId];
  if (!c) return res.status(404).json({ error: "Client not found" });
  return res.json({ clients: [{ id: c.id, name: c.name, bookingMode: c.bookingMode }] });
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

  const fromPhone = req.body?.from_phone ?? process.env.TWILIO_PHONE_NUMBER ?? null;
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
    // Twilio routing (db1_twilio_config.sql — null if migration not yet run)
    outboundPhone:           client.outboundPhone         ?? null,
    messagingServiceSid:     client.messagingServiceSid   ?? null,
    twilioAccountSid:        client.twilioAccountSid      ?? null,
    // Auth token intentionally omitted from GET — write-only in portal
    // Scrape sources + booking options (from DB; empty if tables not yet migrated)
    scrapeSources,
    bookingLinks,
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
      created_at:              new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    };
    const { error: seedErr } = await supabase.from("clients").upsert(seed, { onConflict: "id" });
    if (seedErr) return res.status(500).json({ error: `Failed to promote client to DB: ${seedErr.message}` });
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
