// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG — Runtime configuration loader (Chunk 14)
//
// Merges DB-backed settings with static config from clients.js.
// Called once per SMS request (after resolveClient, after opted-out gate)
// to apply portal settings to live bot behavior.
//
// For DB-backed clients (_fromDb: true):
//   Settings already merged via dbRowToClient() + loadDbClients() at startup.
//   Only adds normalized scrapeSources + bookingLinks arrays.
//
// For static clients (csr_rea, lone_pine, highmark_demo):
//   Fetches DB row to apply any manually seeded overrides.
//   Falls back silently if no DB row exists.
//
// New tables (client_scrape_sources, client_booking_options) are optional —
// if they don't exist yet, falls back to scrapeUrls / bookingUrls on the client.
// ─────────────────────────────────────────────────────────────────────────────

// Module-level flags — set false after first "table doesn't exist" error
// to avoid noisy repeated failures on every SMS request.
let _scrapesTableExists     = true;
let _bookingOptsTableExists = true;
let _botConfigTableExists   = true;
let _bookingConfigTableExists = true;

// Fetch bot_config row for a client (bot identity + system_prompt_addon overrides).
// Returns null if table doesn't exist or no row found.
async function fetchBotConfig(clientId, supabase) {
  if (!_botConfigTableExists) return null;
  try {
    const { data, error } = await supabase
      .from("bot_config")
      .select("bot_name, tone, opener_text, system_prompt_addon, handoff_message")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) {
      if (error.message?.includes("does not exist") || error.code === "42P01") {
        _botConfigTableExists = false;
      }
      return null;
    }
    return data ?? null;
  } catch {
    return null;
  }
}

// Fetch booking_config row for a client (booking behavior overrides).
// Returns null if table doesn't exist or no row found.
async function fetchBookingConfig(clientId, supabase) {
  if (!_bookingConfigTableExists) return null;
  try {
    const { data, error } = await supabase
      .from("booking_config")
      .select("booking_mode, booking_link, call_cta_text")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) {
      if (error.message?.includes("does not exist") || error.code === "42P01") {
        _bookingConfigTableExists = false;
      }
      return null;
    }
    return data ?? null;
  } catch {
    return null;
  }
}

// Fetch the clients DB row for a given client ID (used for static client overrides)
async function fetchDbRow(clientId, supabase) {
  try {
    const { data } = await supabase
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .maybeSingle();
    return data ?? null;
  } catch (err) {
    console.error(`[CONFIG] DB row fetch failed for ${clientId}:`, err.message);
    return null;
  }
}

// Fetch active scrape sources from client_scrape_sources table.
// Returns null if table doesn't exist or no rows found (caller falls back to scrapeUrls).
async function fetchScrapeSources(clientId, supabase) {
  if (!_scrapesTableExists) return null;
  try {
    const { data, error } = await supabase
      .from("client_scrape_sources")
      .select("url, label, source_type, sort_order")
      .eq("client_id", clientId)
      .eq("active", true)
      .order("sort_order");
    if (error) {
      if (error.message?.includes("does not exist") || error.code === "42P01") {
        _scrapesTableExists = false; // suppress until restart
        console.log("[CONFIG] client_scrape_sources table not found — falling back to scrapeUrls");
      }
      return null;
    }
    return data?.length ? data : null;
  } catch {
    return null;
  }
}

// Fetch active booking options from client_booking_options table.
// Returns null if table doesn't exist or no rows found (caller falls back to bookingUrls).
async function fetchBookingOptions(clientId, supabase) {
  if (!_bookingOptsTableExists) return null;
  try {
    const { data, error } = await supabase
      .from("client_booking_options")
      .select("type, title, description, url, metadata_json, sort_order")
      .eq("client_id", clientId)
      .eq("active", true)
      .order("sort_order");
    if (error) {
      if (error.message?.includes("does not exist") || error.code === "42P01") {
        _bookingOptsTableExists = false;
        console.log("[CONFIG] client_booking_options table not found — falling back to bookingUrls");
      }
      return null;
    }
    return data?.length ? data : null;
  } catch {
    return null;
  }
}

// Apply DB column values onto a static client object.
// Only overrides fields where DB has a non-null, non-empty value.
function applyDbOverrides(client, dbRow) {
  if (!dbRow) return client;
  const merged = { ...client };

  // Identity fields — only override if DB has a real value
  if (dbRow.bot_name)    merged.botName     = dbRow.bot_name;
  if (dbRow.tone)        merged.tone        = dbRow.tone;
  if (dbRow.name)        merged.name        = dbRow.name;
  if (dbRow.support_phone) merged.supportPhone = dbRow.support_phone;
  if (dbRow.handoff_phone) merged.handoffPhone  = dbRow.handoff_phone;
  if (dbRow.support_email) merged.supportEmail  = dbRow.support_email;
  if (dbRow.owner_phone)   merged.ownerPhone    = dbRow.owner_phone;
  if (dbRow.booking_link)  merged.bookingLink   = dbRow.booking_link;
  if (Array.isArray(dbRow.operator_phones)   && dbRow.operator_phones.length)   merged.operatorPhones   = dbRow.operator_phones;
  if (Array.isArray(dbRow.weather_locations) && dbRow.weather_locations.length) merged.weatherLocations = dbRow.weather_locations;
  // Don't override bookingMode for demo clients — it's identity, not configurable setting
  if (dbRow.booking_mode && !client.isDemo)  merged.bookingMode = dbRow.booking_mode;

  // Twilio routing — db1_twilio_config.sql columns
  if (dbRow.outbound_phone)         merged.outboundPhone       = dbRow.outbound_phone;
  if (dbRow.messaging_service_sid)  merged.messagingServiceSid = dbRow.messaging_service_sid;
  if (dbRow.twilio_account_sid)     merged.twilioAccountSid    = dbRow.twilio_account_sid;
  if (dbRow.twilio_auth_token)      merged.twilioAuthToken     = dbRow.twilio_auth_token;

  // Conversation settings — db1_conversation_settings.sql
  if (dbRow.conversation_settings != null) {
    merged.conversationSettings = dbRow.conversation_settings;
  }

  // Season config — db1_season_config.sql (per-client summer/winter boundaries)
  if (dbRow.season_config != null) {
    merged.seasonConfig = dbRow.season_config;
  }

  // Feature toggles — preserve false values (explicit null/undefined check)
  if (dbRow.campaigns_enabled     != null) merged.campaignsEnabled    = dbRow.campaigns_enabled;
  if (dbRow.followups_enabled     != null) merged.followupsEnabled    = dbRow.followups_enabled;
  if (dbRow.human_handoff_enabled != null) merged.humanHandoffEnabled = dbRow.human_handoff_enabled;
  if (dbRow.lead_capture_enabled  != null) merged.leadCaptureEnabled  = dbRow.lead_capture_enabled;
  if (dbRow.waitlist_enabled      != null) merged.waitlistEnabled     = dbRow.waitlist_enabled;

  return merged;
}

// Extracts structured metadata from a bookingUrls key name.
// Allows findRelevantBookingLink to score fallback bookingUrls correctly
// when no portal-managed client_booking_options rows exist.
// Examples:
//   "rzr_kremmling"           → { location: "kremmling", category: "rzr", season: "summer", keywords: [...] }
//   "csr_steamboat_unguided"  → { location: "steamboat", category: "self_guided", keywords: [...] }
//   "rea_2hr_tour"            → { category: "guided_tour", keywords: ["guided", "tour"] }
export function metaFromBookingKey(key) {
  const parts  = (key ?? "").toLowerCase().split("_");
  const meta   = { keywords: [] };

  // Location
  if (parts.includes("kremmling") || parts.includes("kremm")) {
    meta.location = "kremmling";
  } else if (parts.includes("steamboat") || parts.includes("steam")) {
    meta.location = "steamboat";
  }

  // Category + season
  if (parts.includes("rzr") || parts.includes("offroad") || parts.includes("off")) {
    meta.category = "rzr";
    meta.season   = "summer";
  } else if (parts.includes("unguided") || parts.includes("rental") || parts.includes("self")) {
    meta.category = "self_guided";
  } else if (parts.includes("proride") || parts.includes("guided") || parts.includes("tour") || parts.includes("private")) {
    meta.category = "guided_tour";
  } else if (parts.includes("browse")) {
    meta.category = "browse_all";
  }

  // Keywords: meaningful terms (skip short prefixes + numbers)
  const skip = new Set(["csr", "rea", "all", "1", "2", "3", "4", "5", "6", "7", "8", "9", "hr", "min"]);
  for (const p of parts) {
    if (!skip.has(p) && p.length > 2) meta.keywords.push(p);
  }

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// getRuntimeClientConfig — primary export
//
// Returns an enriched client config object. Always backward-compatible
// with the existing client interface — all existing fields preserved.
//
// New normalized fields added:
//   client.scrapeSources  — [{ url, label, source_type, sort_order }]
//   client.bookingLinks   — [{ type, title, description, url, metadata_json, sort_order }]
//   client.humanHandoffEnabled — always boolean (defaults to true)
//   client.bookingMode    — "api_live_booking" normalized to "fareharbor"
// ─────────────────────────────────────────────────────────────────────────────
export async function getRuntimeClientConfig(client, supabase) {
  let merged = { ...client };

  // Static clients: check for DB overrides (portal writes; or manually seeded)
  // DB-backed clients already have settings applied via dbRowToClient() at startup.
  if (!client._fromDb && supabase) {
    const dbRow = await fetchDbRow(client.id, supabase);
    merged = applyDbOverrides(merged, dbRow);
  }

  // Scrape sources: DB table → scrapeUrls fallback → empty array
  if (supabase) {
    const dbSources = await fetchScrapeSources(client.id, supabase);
    if (dbSources?.length) {
      merged.scrapeSources = dbSources;
      merged.scrapeUrls    = dbSources.map((s) => s.url); // keep scrapeUrls in sync
    } else {
      merged.scrapeSources = (merged.scrapeUrls ?? []).map((url, i) => ({
        url, label: null, source_type: "website", active: true, sort_order: i,
      }));
    }
  } else {
    merged.scrapeSources = (merged.scrapeUrls ?? []).map((url, i) => ({
      url, label: null, source_type: "website", active: true, sort_order: i,
    }));
  }

  // Booking links: DB table → bookingUrls fallback → empty array
  if (supabase) {
    const dbOptions = await fetchBookingOptions(client.id, supabase);
    if (dbOptions?.length) {
      merged.bookingLinks = dbOptions;
    } else {
      merged.bookingLinks = Object.entries(merged.bookingUrls ?? {}).map(([title, url], i) => ({
        type: "link", title, description: null, url, metadata_json: metaFromBookingKey(title), sort_order: i,
      }));
    }
  } else {
    merged.bookingLinks = Object.entries(merged.bookingUrls ?? {}).map(([title, url], i) => ({
      type: "link", title, description: null, url, metadata_json: null, sort_order: i,
    }));
  }

  // humanHandoffEnabled — always a boolean, default true
  if (merged.humanHandoffEnabled == null) {
    merged.humanHandoffEnabled = true;
  }

  // Bot config overrides — applied last so portal edits take precedence over all other sources
  if (supabase) {
    const botCfg = await fetchBotConfig(client.id, supabase);
    if (botCfg) {
      if (botCfg.bot_name)            merged.botName           = botCfg.bot_name;
      if (botCfg.tone)                merged.tone              = botCfg.tone;
      if (botCfg.opener_text)         merged.openerText        = botCfg.opener_text;
      if (botCfg.system_prompt_addon) merged.systemPromptAddon = botCfg.system_prompt_addon;
      if (botCfg.handoff_message)     merged.handoffMessage    = botCfg.handoff_message;
    }
  }

  // Booking config overrides — applied last so portal edits take precedence
  if (supabase) {
    const bookCfg = await fetchBookingConfig(client.id, supabase);
    if (bookCfg) {
      if (bookCfg.booking_mode)  merged.bookingMode  = bookCfg.booking_mode;
      if (bookCfg.booking_link)  merged.bookingLink  = bookCfg.booking_link;
      if (bookCfg.call_cta_text) merged.callCtaText  = bookCfg.call_cta_text;
    }
  }

  // Re-normalize booking mode after all overrides applied
  if (merged.bookingMode === "api_live_booking") {
    merged.bookingMode = "fareharbor";
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-AGENT CLIENT PROFILE SYSTEM (Phase 3)
//
// getClientProfile(clientId, supabase?)  — normalized profile for agentCore/prompts
// getClientKnowledge(clientId, supabase?) — concise KB string ≤ 400 chars
//
// These are additive — they do NOT replace getRuntimeClientConfig().
// getRuntimeClientConfig() serves the SMS flow (per-request enrichment).
// getClientProfile() serves the multi-agent layer (static, normalized shape).
// ─────────────────────────────────────────────────────────────────────────────

// Default profile returned when client is unknown or DB unavailable.
const DEFAULT_PROFILE = (clientId) => ({
  id:           clientId ?? "unknown",
  name:         "Unknown Business",
  industry:     "general",
  tone:         "friendly",
  services:     [],
  bookingLinks: {},
  locations:    [],
  contact: {
    phone: null,
    email: null,
  },
  features: {
    bookings:  false,
    crm:       false,
    campaigns: false,
    reporting: false,
  },
});

// Safely parse a JSON value (string or already-parsed object).
// Returns fallback on any error.
export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Trim text to maxLength without cutting mid-word.
export function truncateText(text, maxLength) {
  if (!text || typeof text !== "string") return "";
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.7 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

// Build a normalized profile from any client object (static or DB-backed shape).
function normalizeClientProfile(raw, clientId) {
  if (!raw) return DEFAULT_PROFILE(clientId);
  try {
    return {
      id:           raw.id       ?? clientId ?? "unknown",
      name:         raw.name     ?? "Unknown Business",
      industry:     raw.industry ?? "general",
      tone:         raw.tone     ?? "friendly",
      services:     Array.isArray(raw.services) ? raw.services : [],
      // bookingLinks: normalize from array (portal shape) or object (static shape)
      bookingLinks: Array.isArray(raw.bookingLinks)
        ? Object.fromEntries(raw.bookingLinks.map((l) => [l.title ?? l.url, l.url]))
        : (raw.bookingUrls ?? {}),
      locations: Array.isArray(raw.locations)
        ? raw.locations
        : (raw.address ? [raw.address] : []),
      contact: {
        phone: raw.supportPhone ?? raw.contact_phone ?? null,
        email: raw.supportEmail ?? raw.contact_email ?? null,
      },
      features: {
        bookings:  raw.bookingMode != null && raw.bookingMode !== "informational",
        crm:       raw.crmEnabled      ?? false,
        campaigns: raw.campaignsEnabled ?? false,
        reporting: true, // always available at platform level
      },
    };
  } catch (e) {
    console.error("[clientConfig] normalizeClientProfile error:", e.message);
    return DEFAULT_PROFILE(clientId);
  }
}

/**
 * Load a normalized client profile for the multi-agent system.
 *
 * Data priority:
 *   1. clients DB table (via supabase, if provided)
 *   2. Local CLIENTS registry (clients.js static config)
 *   3. DEFAULT_PROFILE fallback
 *
 * @param {string} clientId
 * @param {object|null} supabase  — optional Supabase client (pass null to use local only)
 * @returns {Promise<object>}
 */
export async function getClientProfile(clientId, supabase = null) {
  try {
    // Lazy import to avoid circular dep — clients.js imports nothing from clientConfig.js
    const { getAllClients } = await import("./clients.js");

    // Try DB first
    if (supabase && clientId) {
      try {
        const { data, error } = await supabase
          .from("clients")
          .select("*")
          .eq("id", clientId)
          .maybeSingle();
        if (!error && data) {
          // DB row found — normalize and return
          // Merge with static client so static-only fields (industry, services, etc.) survive
          const staticClients = getAllClients();
          const staticClient  = staticClients[clientId] ?? {};
          const merged = { ...staticClient, ...data };
          return normalizeClientProfile(merged, clientId);
        }
      } catch (dbErr) {
        console.error(`[clientConfig] getClientProfile DB error for ${clientId}:`, dbErr.message);
        // Fall through to local
      }
    }

    // Local fallback — static CLIENTS registry
    const staticClients = getAllClients();
    const local = staticClients[clientId];
    if (local) return normalizeClientProfile(local, clientId);

    // Final fallback
    console.warn(`[clientConfig] getClientProfile: client "${clientId}" not found — returning default`);
    return DEFAULT_PROFILE(clientId);
  } catch (e) {
    console.error("[clientConfig] getClientProfile error:", e.message);
    return DEFAULT_PROFILE(clientId);
  }
}

/**
 * Retrieve a concise knowledge summary for a client (≤ 400 chars).
 *
 * Pulls from the knowledge_base table rows keyed to this clientId.
 * Combines summaries in priority order: website → FH availability → weather.
 * Falls back to empty string on any failure.
 *
 * @param {string} clientId
 * @param {object|null} supabase
 * @returns {Promise<string>}
 */
export async function getClientKnowledge(clientId, supabase = null) {
  const MAX_LEN = 400;
  try {
    if (!supabase || !clientId) return "";

    // Fetch all KB rows for this client
    const { data: rows, error } = await supabase
      .from("knowledge_base")
      .select("key, summary")
      .eq("client_id", clientId)
      .order("fetched_at", { ascending: false });

    if (error || !rows || !rows.length) return "";

    // Priority: website knowledge → FH/availability summaries → anything else
    const ordered = [
      ...rows.filter((r) => r.key.includes("website_knowledge")),
      ...rows.filter((r) => r.key.includes("fareharbor")),
      ...rows.filter((r) => r.key.includes("weather") || r.key.includes("snow")),
      ...rows.filter(
        (r) =>
          !r.key.includes("website_knowledge") &&
          !r.key.includes("fareharbor") &&
          !r.key.includes("weather") &&
          !r.key.includes("snow")
      ),
    ];

    // Combine summaries, truncate at sentence boundary, cap at MAX_LEN
    const combined = ordered
      .map((r) => (r.summary ?? "").trim())
      .filter(Boolean)
      .join(" | ");

    return truncateText(combined, MAX_LEN);
  } catch (e) {
    console.error(`[clientConfig] getClientKnowledge error for ${clientId}:`, e.message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS_HELP — human-readable descriptions for portal settings fields.
// Not used by bot logic — available for future UI tooltip/help rendering.
// ─────────────────────────────────────────────────────────────────────────────
export const SETTINGS_HELP = {
  bot_name:              "Name your AI concierge uses to introduce itself to guests",
  tone:                  "Personality and communication style for the AI concierge",
  booking_mode:          "How guests book: fareharbor/api_live_booking (FH API), informational/call_only (phone CTA), static_links (show booking links), hybrid (links + phone CTA)",
  scrape_sources:        "Website URLs scraped weekly for business knowledge (policies, pricing, FAQ)",
  human_handoff_enabled: "When on: guests can request a human and bot routes to your handoff number. When off: bot handles all interactions.",
  lead_capture_enabled:  "When on: bot collects guest info (service, callback, timeframe) before routing to your team",
  campaigns_enabled:     "Enables outbound SMS campaign creation and sending in the portal",
  followups_enabled:     "Enables automated follow-up SMS sequences after lead capture",
  waitlist_enabled:      "When on: bot can save guest numbers for availability notifications",
};
