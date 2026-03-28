// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CLIENTS — Internal client provisioning routes (Chunk 6)
//
// Routes (all protected by requireUiAccess in index.js):
//   GET  /admin/clients            — list all clients (static + DB) with readiness
//   GET  /admin/clients/:id        — single client with readiness
//   POST /admin/clients            — create new client
//   PATCH /admin/clients/:id       — update existing DB-backed client
//
// Static clients (clients.js) are read-only via API.
// New clients created here are stored in the Supabase DB1 clients table.
// ─────────────────────────────────────────────────────────────────────────────

import { getAllClients, loadDbClients } from "./clients.js";

export const VALID_BOOKING_MODES = ["fareharbor", "informational", "lead_capture"];
const PHONE_RE = /^\+\d{7,15}$/;
const SLUG_RE  = /^[a-z0-9_]+$/;

// ── Readiness check ───────────────────────────────────────────────────────────
// Returns { checks: {}, score: "N/5", ready: bool }
// A client must pass all 5 checks before going live.
export function computeReadiness(client) {
  const inboundPhones = client.inboundPhones ?? client.inbound_phones ?? [];
  const scrapeUrls    = client.scrapeUrls    ?? client.scrape_urls    ?? [];
  const checks = {
    inbound_phone:    inboundPhones.length > 0,
    website_or_scrape: !!(client.websiteUrl ?? client.website_url) || scrapeUrls.length > 0,
    support_contact:  !!(client.supportPhone ?? client.support_phone ?? client.handoffPhone ?? client.handoff_phone),
    booking_mode:     VALID_BOOKING_MODES.includes(client.bookingMode ?? client.booking_mode),
    bot_identity:     !!(client.botName ?? client.bot_name),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { checks, score: `${passed}/${Object.keys(checks).length}`, ready: passed === Object.keys(checks).length };
}

// ── Serialize a client config for API response ────────────────────────────────
function serializeClient(client) {
  return {
    id:            client.id,
    slug:          client.slug,
    name:          client.name,
    bot_name:      client.botName,
    tone:          client.tone,
    booking_mode:  client.bookingMode,
    inbound_phones: client.inboundPhones ?? [],
    support_phone: client.supportPhone  ?? null,
    handoff_phone: client.handoffPhone  ?? null,
    support_email: client.supportEmail  ?? null,
    address:       client.address       ?? null,
    timezone:      client.timezone,
    hours:         client.hours         ?? null,
    active:        client.active        ?? true,
    fareharbor_enabled:   client.fareharborEnabled   ?? false,
    crm_enabled:          client.crmEnabled          ?? false,
    lead_capture_enabled: client.leadCaptureEnabled  ?? false,
    waitlist_enabled:     client.waitlistEnabled      ?? true,
    scrape_urls:   client.scrapeUrls   ?? [],
    services:      client.services     ?? [],
    website_url:   client.websiteUrl   ?? null,
    is_static:     !client._fromDb,
    readiness:     computeReadiness(client),
  };
}

// ── Gather every inbound phone across all clients (for uniqueness checks) ─────
function getAllInboundPhones(excludeId = null) {
  const phones = [];
  for (const [id, c] of Object.entries(getAllClients())) {
    if (id === excludeId) continue;
    for (const p of (c.inboundPhones ?? [])) phones.push(p);
  }
  return phones;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/clients
// Query params: active (optional, "true"/"false")
// ─────────────────────────────────────────────────────────────────────────────
export async function handleListClients(req, res) {
  let clients = Object.values(getAllClients());
  if (req.query.active !== undefined) {
    const wantActive = req.query.active !== "false";
    clients = clients.filter((c) => (c.active ?? true) === wantActive);
  }
  return res.json({ clients: clients.map(serializeClient), total: clients.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/clients/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function handleGetClient(req, res) {
  const client = getAllClients()[req.params.id];
  if (!client) return res.status(404).json({ error: "Client not found" });
  return res.json({ client: serializeClient(client) });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/clients
// Required: id, name
// Optional: all other fields; sane defaults applied automatically
// ─────────────────────────────────────────────────────────────────────────────
export async function handleCreateClient(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const body = req.body ?? {};
  const id   = (body.id   ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();

  if (!id)   return res.status(400).json({ error: "id is required" });
  if (!name) return res.status(400).json({ error: "name is required" });

  if (!SLUG_RE.test(id)) {
    return res.status(400).json({ error: "id must be lowercase alphanumeric + underscores only" });
  }

  const bookingMode = (body.booking_mode ?? "informational").trim();
  if (!VALID_BOOKING_MODES.includes(bookingMode)) {
    return res.status(400).json({ error: `booking_mode must be one of: ${VALID_BOOKING_MODES.join(", ")}` });
  }

  const slug = (body.slug ?? id).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: "slug must be lowercase alphanumeric + underscores only" });
  }

  // Uniqueness: id and slug
  const all = getAllClients();
  if (all[id])  return res.status(409).json({ error: `Client id "${id}" already exists` });
  if (Object.values(all).some((c) => c.slug === slug)) {
    return res.status(409).json({ error: `Slug "${slug}" is already in use` });
  }

  // Inbound phone validation + uniqueness
  const inboundPhones = (body.inbound_phones ?? []).map((p) => p.trim());
  for (const p of inboundPhones) {
    if (!PHONE_RE.test(p)) {
      return res.status(400).json({ error: `Invalid phone format: ${p}. Must be E.164 (e.g. +18001234567)` });
    }
  }
  const takenPhones = getAllInboundPhones();
  for (const p of inboundPhones) {
    if (takenPhones.includes(p)) {
      return res.status(409).json({ error: `Phone ${p} is already assigned to another client` });
    }
  }

  // Apply defaults and build DB row
  const row = {
    id,
    slug,
    name,
    bot_name:                  (body.bot_name  ?? "Summit").trim() || "Summit",
    tone:                      (body.tone      ?? "warm, helpful, and knowledgeable").trim(),
    inbound_phones:            inboundPhones,
    support_phone:             body.support_phone            ?? null,
    handoff_phone:             body.handoff_phone            ?? body.support_phone ?? null,
    support_email:             body.support_email            ?? null,
    address:                   body.address                  ?? null,
    timezone:                  body.timezone                 ?? "America/Denver",
    hours:                     body.hours                    ?? null,
    booking_mode:              bookingMode,
    fareharbor_enabled:        body.fareharbor_enabled       ?? false,
    crm_enabled:               body.crm_enabled              ?? false,
    confirmation_texts_enabled: body.confirmation_texts_enabled ?? false,
    waitlist_enabled:          body.waitlist_enabled          ?? true,
    lead_capture_enabled:      body.lead_capture_enabled      ?? false,
    lead_notification_phone:   body.lead_notification_phone   ?? null,
    fareharbor_companies:      body.fareharbor_companies      ?? [],
    scrape_urls:               body.scrape_urls               ?? [],
    snotel_stations:           body.snotel_stations           ?? [],
    booking_urls:              body.booking_urls              ?? {},
    services:                  body.services                  ?? [],
    faq:                       body.faq                       ?? [],
    opener_text:               body.opener_text               ?? null,
    handoff_reply_template:    body.handoff_reply_template    ?? null,
    active:                    body.active                    ?? true,
    website_url:               body.website_url               ?? (body.scrape_urls?.[0] ?? null),
    static_facts:              body.static_facts              ?? null,
  };

  const { error } = await supabase.from("clients").insert(row);
  if (error) {
    console.error("[ADMIN CLIENTS] create error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  // Reload runtime registry so resolveClient() picks up the new entry immediately
  const { data: allRows } = await supabase.from("clients").select("*").eq("active", true);
  loadDbClients(allRows ?? []);

  console.log(`[ADMIN CLIENTS] Created: ${id}`);
  return res.status(201).json({ client: serializeClient(getAllClients()[id]) });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/clients/:id
// Only DB-backed clients can be updated via API. Static clients → 400.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleUpdateClient(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  const body   = req.body ?? {};

  const client = getAllClients()[id];
  if (!client)        return res.status(404).json({ error: "Client not found" });
  if (!client._fromDb) {
    return res.status(400).json({ error: "Static clients cannot be updated via API — edit clients.js" });
  }

  const updates = { updated_at: new Date().toISOString() };

  const scalarFields = [
    "name", "bot_name", "tone", "support_phone", "handoff_phone", "support_email",
    "address", "timezone", "hours", "opener_text", "handoff_reply_template",
    "active", "website_url", "crm_enabled", "lead_capture_enabled",
    "lead_notification_phone", "waitlist_enabled", "static_facts",
  ];
  for (const f of scalarFields) {
    if (body[f] !== undefined) updates[f] = body[f];
  }

  // booking_mode — validate
  if (body.booking_mode !== undefined) {
    if (!VALID_BOOKING_MODES.includes(body.booking_mode)) {
      return res.status(400).json({ error: `booking_mode must be one of: ${VALID_BOOKING_MODES.join(", ")}` });
    }
    updates.booking_mode = body.booking_mode;
  }

  // inbound_phones — validate format + uniqueness
  if (body.inbound_phones !== undefined) {
    const phones = body.inbound_phones.map((p) => p.trim());
    for (const p of phones) {
      if (!PHONE_RE.test(p)) {
        return res.status(400).json({ error: `Invalid phone format: ${p}` });
      }
    }
    const takenPhones = getAllInboundPhones(id); // exclude this client's own phones
    for (const p of phones) {
      if (takenPhones.includes(p)) {
        return res.status(409).json({ error: `Phone ${p} is already assigned to another client` });
      }
    }
    updates.inbound_phones = phones;
  }

  // array / JSONB fields
  if (body.scrape_urls          !== undefined) updates.scrape_urls          = body.scrape_urls;
  if (body.services             !== undefined) updates.services             = body.services;
  if (body.faq                  !== undefined) updates.faq                  = body.faq;
  if (body.booking_urls         !== undefined) updates.booking_urls         = body.booking_urls;
  if (body.fareharbor_companies !== undefined) updates.fareharbor_companies = body.fareharbor_companies;
  if (body.snotel_stations      !== undefined) updates.snotel_stations      = body.snotel_stations;

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await supabase
    .from("clients")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[ADMIN CLIENTS] update error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  // Reload runtime registry
  const { data: allRows } = await supabase.from("clients").select("*").eq("active", true);
  loadDbClients(allRows ?? []);

  console.log(`[ADMIN CLIENTS] Updated: ${id}`);
  return res.json({ client: serializeClient(getAllClients()[id]) });
}
