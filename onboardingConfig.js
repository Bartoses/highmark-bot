// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING CONFIG — Phase 3 (AI Auto-Config)
//
// Pipeline: Website URL → Crawl → Extract → Draft → Review → Save (commit)
//
// Token strategy:
//   Crawl + link extraction     — zero Claude, JS only (reuses crawler.js)
//   Structured fact extraction  — single Haiku call across all pages combined
//   Booking signal detection    — zero Claude, regex only
//   Draft assembly              — JS logic
//
// Exports:
//   startAutoConfig(url, anthropic, supabase, createdBy?)
//     → { draftId, draft, confidence, warnings, pagesCrawled }
//
//   getDraft(draftId, supabase)
//     → draft row or null
//
//   updateDraft(draftId, updates, supabase)
//     → updated draft row
//
//   commitDraftToDb(draftId, supabase)
//     → { clientId } — creates clients row, marks draft saved
//
//   slugifyName(name) — utility, exported for testing
//   detectBookingSignals(text) — exported for testing
//   buildConfidenceScore(facts) — exported for testing
// ─────────────────────────────────────────────────────────────────────────────

import { crawlSite, classifyPageType } from "./crawler.js";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING SIGNAL DETECTION (zero Claude tokens)
// ─────────────────────────────────────────────────────────────────────────────

const BOOKING_PLATFORM_PATTERNS = {
  fareharbor: [
    /fareharbor\.com/i,
    /fareharbor\.com\/embeds/i,
  ],
  polaris: [
    /adventures\.polaris\.com/i,
    /polaris.*rental/i,
  ],
  checkfront: [
    /checkfront\.com/i,
    /\.checkfront\.com/i,
  ],
  peek: [
    /peek\.com\/activities/i,
    /peekpro\.com/i,
  ],
  rezdy: [
    /rezdy\.com/i,
    /\.rezdy\.com/i,
  ],
  xola: [
    /xola\.com/i,
    /book\.xola\.com/i,
  ],
  mindbody: [
    /mindbodyonline\.com/i,
    /mindbody\.io/i,
  ],
  square: [
    /squareup\.com\/appointments/i,
    /squareup\.com\/store/i,
  ],
};

const GENERIC_BOOKING_PATTERNS = [
  /book.*now/i,
  /reserve.*now/i,
  /schedule.*appointment/i,
  /book.*online/i,
  /online.*booking/i,
  /book.*tour/i,
  /book.*class/i,
  /book.*session/i,
];

/**
 * Detects which booking platform (if any) is used from combined page text + links.
 * Returns { platform: string, links: string[], hasBooking: boolean }
 */
export function detectBookingSignals(text) {
  const platform = detectPlatform(text);
  const links    = extractBookingLinks(text);
  const hasBooking = !!(platform || links.length > 0 || GENERIC_BOOKING_PATTERNS.some((p) => p.test(text)));

  return { platform, links, hasBooking };
}

function detectPlatform(text) {
  for (const [name, patterns] of Object.entries(BOOKING_PLATFORM_PATTERNS)) {
    if (patterns.some((p) => p.test(text))) return name;
  }
  return null;
}

function extractBookingLinks(text) {
  const links = [];
  // Match URLs in the combined text
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  const matches    = text.match(urlPattern) ?? [];
  for (const url of matches) {
    const clean = url.replace(/[).,;>'"]+$/, ""); // strip trailing punctuation
    // Only include booking-looking URLs
    if (/fareharbor|checkfront|peek|rezdy|xola|mindbody|squareup|polaris/.test(clean)) {
      if (!links.includes(clean)) links.push(clean);
    }
  }
  return links.slice(0, 3); // max 3 booking links
}

// ─────────────────────────────────────────────────────────────────────────────
// SLUG UTILITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a business name to a safe client ID slug.
 * e.g. "Colorado Sled Rentals" → "colorado_sled_rentals"
 */
export function slugifyName(name) {
  if (!name) return "new_client";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")   // remove special chars
    .replace(/\s+/g, "_")            // spaces to underscores
    .replace(/_+/g, "_")             // collapse multiple underscores
    .replace(/^_|_$/g, "")           // trim leading/trailing underscores
    .slice(0, 40)                    // max 40 chars
    || "new_client";
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE HAIKU EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function buildExtractionPrompt(pagesText, sourceUrl) {
  return `You are a business onboarding assistant. Analyze the following website content and extract structured business information.

Return ONLY a valid JSON object — no markdown, no extra text, no explanations.

Required fields (use null if not found):
{
  "business_name": "exact business name from the site",
  "description": "one sentence (max 120 chars) describing what this business does",
  "industry": "one of: outdoor_adventures, fitness_gym, yoga_studio, climbing_gym, lodging_hotel, restaurant_cafe, spa_wellness, retail_shop, bike_shop, auto_repair, other",
  "tone": "brief tone description for the AI bot (e.g. warm and enthusiastic, professional and knowledgeable)",
  "phone": "primary business phone number (e.g. (970) 555-0001)",
  "email": "primary business email",
  "address": "full mailing address or city/state if full address not found",
  "services": ["service 1", "service 2", "service 3"],
  "hours": "brief hours description (e.g. Mon-Fri 9am-5pm, or Seasonal — see website)",
  "timezone": "IANA timezone (e.g. America/Denver, America/Los_Angeles) — infer from address/phone area code",
  "booking_platform": "one of: fareharbor, polaris, checkfront, peek, rezdy, xola, mindbody, square, generic, none",
  "booking_mode_suggestion": "one of: fareharbor, informational, lead_capture — choose fareharbor if FareHarbor links found; lead_capture if it looks like a service business with scheduled appointments; informational otherwise",
  "bot_name": "a short friendly name for the AI bot (e.g. Summit, Scout, Finn, Maya — match the brand feel)"
}

Website URL: ${sourceUrl}

Website content (from ${pagesText.split("\n===PAGE===\n").length} pages):
${pagesText.slice(0, 6000)}`;
}

/**
 * Calls Haiku once to extract structured facts from combined page content.
 * Returns parsed object or best-effort defaults on failure.
 */
async function extractStructuredFacts(pages, sourceUrl, anthropic) {
  const okPages = pages.filter((p) => p.status === "ok" && p.text?.length > 50);
  if (!okPages.length) {
    return buildFallbackFacts(sourceUrl);
  }

  // Combine page text in priority order: homepage first, then others
  const ordered = [...okPages].sort((a, b) => {
    const order = ["homepage", "services", "pricing", "booking", "contact", "faq", "policies", "hours", "other"];
    return order.indexOf(a.pageType ?? "other") - order.indexOf(b.pageType ?? "other");
  });

  const combined = ordered
    .slice(0, 6)
    .map((p) => `===PAGE===\n[${p.pageType ?? "page"} — ${p.url}]\nTitle: ${p.title ?? ""}\n${p.text.slice(0, 1200)}`)
    .join("\n");

  if (!anthropic) {
    return buildFallbackFacts(sourceUrl);
  }

  try {
    const res = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 700,
      messages:   [{ role: "user", content: buildExtractionPrompt(combined, sourceUrl) }],
    });

    const raw   = res.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return buildFallbackFacts(sourceUrl);

    const parsed = JSON.parse(match[0]);
    return sanitizeFacts(parsed, sourceUrl);
  } catch (err) {
    console.warn("[ONBOARDING] Haiku extraction failed:", err.message);
    return buildFallbackFacts(sourceUrl);
  }
}

function buildFallbackFacts(sourceUrl) {
  let name = null;
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    name = host.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { /* noop */ }

  return {
    business_name: name,
    description: null,
    industry: "other",
    tone: "warm and helpful",
    phone: null,
    email: null,
    address: null,
    services: [],
    hours: null,
    timezone: "America/Denver",
    booking_platform: "none",
    booking_mode_suggestion: "informational",
    bot_name: "Assistant",
  };
}

function sanitizeFacts(facts, sourceUrl) {
  const fallback = buildFallbackFacts(sourceUrl);
  const validBookingModes   = ["fareharbor", "informational", "lead_capture"];
  const validBookingPlatforms = ["fareharbor", "polaris", "checkfront", "peek", "rezdy", "xola", "mindbody", "square", "generic", "none"];

  return {
    business_name:         typeof facts.business_name === "string" ? facts.business_name.trim() : fallback.business_name,
    description:           typeof facts.description   === "string" ? facts.description.trim()   : null,
    industry:              typeof facts.industry      === "string" ? facts.industry.trim()       : "other",
    tone:                  typeof facts.tone          === "string" ? facts.tone.trim()           : "warm and helpful",
    phone:                 typeof facts.phone         === "string" ? facts.phone.trim()          : null,
    email:                 typeof facts.email         === "string" ? facts.email.trim()          : null,
    address:               typeof facts.address       === "string" ? facts.address.trim()        : null,
    services:              Array.isArray(facts.services) ? facts.services.filter((s) => typeof s === "string").slice(0, 8) : [],
    hours:                 typeof facts.hours         === "string" ? facts.hours.trim()          : null,
    timezone:              typeof facts.timezone      === "string" ? facts.timezone.trim()       : "America/Denver",
    booking_platform:      validBookingPlatforms.includes(facts.booking_platform)  ? facts.booking_platform  : "none",
    booking_mode_suggestion: validBookingModes.includes(facts.booking_mode_suggestion) ? facts.booking_mode_suggestion : "informational",
    bot_name:              typeof facts.bot_name      === "string" ? facts.bot_name.trim()       : "Assistant",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE SCORING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a per-field confidence map: { name, booking_mode, services, contact }
 * Values: "high" | "medium" | "low"
 */
export function buildConfidenceScore(facts) {
  return {
    name:         facts.business_name ? "high" : "low",
    booking_mode: facts.booking_platform !== "none" && facts.booking_platform !== null
                    ? "high"
                    : facts.booking_mode_suggestion !== "informational"
                      ? "medium"
                      : "low",
    services:     (facts.services?.length ?? 0) >= 3 ? "high"
                : (facts.services?.length ?? 0) >= 1 ? "medium"
                : "low",
    contact:      (facts.phone && facts.email) ? "high"
                : (facts.phone || facts.email) ? "medium"
                : "low",
  };
}

function buildWarnings(facts, confidence) {
  const warnings = [];
  if (!facts.phone && !facts.email) {
    warnings.push("No phone or email detected — add contact info before going live");
  } else if (!facts.phone) {
    warnings.push("No phone number detected — add one for SMS handoff");
  }
  if (!facts.services?.length) {
    warnings.push("No services detected — add services manually so the bot can answer questions");
  }
  if (confidence.booking_mode === "low") {
    warnings.push("Booking mode set to informational — update if you use an online booking platform");
  }
  if (!facts.hours) {
    warnings.push("Business hours not found — add hours so the bot can tell guests when you're open");
  }
  if (!facts.description) {
    warnings.push("Could not generate a business description — add one to improve bot context");
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAFT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildDraftFromFacts(facts, bookingSignals, sourceUrl) {
  const name = facts.business_name ?? "New Client";

  // Override booking signals from regex if Haiku missed them
  const effectivePlatform = bookingSignals.platform ?? facts.booking_platform ?? "none";
  const effectiveMode     = effectivePlatform === "fareharbor" ? "fareharbor"
                          : effectivePlatform !== "none" ? "informational"
                          : facts.booking_mode_suggestion ?? "informational";

  const draftClient = {
    name,
    industry:      facts.industry ?? "other",
    support_phone: facts.phone ?? null,
    support_email: facts.email ?? null,
    address:       facts.address ?? null,
    timezone:      facts.timezone ?? "America/Denver",
    website_url:   sourceUrl,
    services:      facts.services ?? [],
    hours:         facts.hours ?? null,
  };

  const draftBot = {
    bot_name:    facts.bot_name ?? "Assistant",
    tone:        facts.tone ?? "warm and helpful",
    opener_text: null,   // human sets this
  };

  const draftBooking = {
    booking_mode:     effectiveMode,
    booking_platform: effectivePlatform,
    booking_link:     bookingSignals.links[0] ?? null,
  };

  return { draftClient, draftBot, draftBooking };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full onboarding pipeline:
 *   1. Crawl up to 6 pages (maxDepth=1 for speed)
 *   2. Detect booking signals from combined text (regex, zero Claude)
 *   3. Extract structured facts via single Haiku call
 *   4. Build confidence + warnings
 *   5. Save draft to onboarding_drafts table
 *
 * Returns: { draftId, draft, confidence, warnings, pagesCrawled }
 */
export async function startAutoConfig(sourceUrl, anthropic, supabase, createdBy = null) {
  // Validate URL
  let validUrl;
  try {
    validUrl = new URL(sourceUrl).href;
  } catch {
    throw new Error("Invalid URL — must include https://");
  }

  // Step 1: Crawl (bounded: 6 pages, depth 1)
  let pages = [];
  try {
    pages = await crawlSite(validUrl, { maxPages: 6, maxDepth: 1 });
  } catch (err) {
    console.warn("[ONBOARDING] Crawl failed:", err.message);
    pages = [];
  }

  const okPages = pages.filter((p) => p.status === "ok");

  // Step 2: Combined text for booking signal detection
  const combinedText = okPages.map((p) => p.text ?? "").join("\n");

  // Step 3: Booking signal detection (regex — zero Claude)
  const bookingSignals = detectBookingSignals(combinedText + "\n" + validUrl);

  // Step 4: Claude Haiku structured extraction (single call)
  const facts = await extractStructuredFacts(okPages, validUrl, anthropic);

  // Merge booking signals into facts (regex wins if confident)
  if (bookingSignals.platform && facts.booking_platform === "none") {
    facts.booking_platform = bookingSignals.platform;
    if (bookingSignals.platform === "fareharbor") {
      facts.booking_mode_suggestion = "fareharbor";
    }
  }

  // Step 5: Build draft
  const { draftClient, draftBot, draftBooking } = buildDraftFromFacts(facts, bookingSignals, validUrl);

  // Step 6: Confidence + warnings
  const confidence = buildConfidenceScore(facts);
  const warnings   = buildWarnings(facts, confidence);

  // Step 7: Save to DB (optional — if supabase unavailable, return in-memory draft)
  const draftPayload = {
    created_by:     createdBy,
    source_url:     validUrl,
    status:         "draft",
    draft_client:   draftClient,
    draft_bot:      draftBot,
    draft_booking:  draftBooking,
    extracted_facts: facts,
    confidence,
    warnings,
    pages_crawled:  okPages.length,
    updated_at:     new Date().toISOString(),
  };

  let draftId = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("onboarding_drafts")
        .insert(draftPayload)
        .select("id")
        .single();

      if (error) throw error;
      draftId = data.id;
    } catch (err) {
      console.warn("[ONBOARDING] Failed to save draft to DB:", err.message);
    }
  }

  return {
    draftId,
    draft: { draftClient, draftBot, draftBooking },
    extractedFacts: facts,
    confidence,
    warnings,
    pagesCrawled: okPages.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAFT CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches a draft by ID. Returns the row or null if not found.
 */
export async function getDraft(draftId, supabase) {
  if (!supabase || !draftId) return null;
  const { data, error } = await supabase
    .from("onboarding_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (error) {
    console.warn("[ONBOARDING] getDraft error:", error.message);
    return null;
  }
  return data;
}

/**
 * Updates editable fields on a draft. Only draft_client, draft_bot, draft_booking
 * may be updated (extracted_facts and confidence are read-only).
 */
export async function updateDraft(draftId, updates, supabase) {
  if (!supabase || !draftId) return null;

  const allowed     = ["draft_client", "draft_bot", "draft_booking"];
  const safeUpdates = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) safeUpdates[key] = updates[key];
  }
  if (!Object.keys(safeUpdates).length) return null;

  safeUpdates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("onboarding_drafts")
    .update(safeUpdates)
    .eq("id", draftId)
    .eq("status", "draft")   // can only update while still a draft
    .select()
    .single();

  if (error) {
    console.warn("[ONBOARDING] updateDraft error:", error.message);
    return null;
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT DRAFT → REAL CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promotes a draft to a real client record.
 * Creates a row in the clients table, then marks the draft as 'saved'.
 *
 * Returns: { clientId }
 * Throws on validation failure or DB error.
 */
export async function commitDraftToDb(draftId, supabase) {
  if (!supabase) throw new Error("DB unavailable");

  // Fetch the current draft
  const draft = await getDraft(draftId, supabase);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "draft") throw new Error(`Draft is already ${draft.status}`);

  const dc = draft.draft_client ?? {};
  const db = draft.draft_bot    ?? {};
  const dbook = draft.draft_booking ?? {};

  // Build client slug — must be unique
  const baseSlug = slugifyName(dc.name ?? "new_client");
  const slug     = await findUniqueSlug(baseSlug, supabase);

  // Assemble the clients row
  const clientRow = {
    id:           slug,
    slug:         slug,
    name:         dc.name        ?? "New Client",
    bot_name:     db.bot_name    ?? "Assistant",
    tone:         db.tone        ?? "warm and helpful",
    timezone:     dc.timezone    ?? "America/Denver",
    website_url:  dc.website_url ?? draft.source_url,
    support_phone: dc.support_phone ?? null,
    support_email: dc.support_email ?? null,
    address:      dc.address     ?? null,
    booking_mode: dbook.booking_mode ?? "informational",
    booking_link: dbook.booking_link ?? null,
    services:     Array.isArray(dc.services) ? dc.services : [],
    inbound_phones: [],        // no Twilio number until provisioned
    active:       false,       // draft clients start inactive until verified
    // Feature flags off by default — admin enables after setup
    campaigns_enabled:  false,
    followups_enabled:  false,
    human_handoff_enabled: true,
    lead_capture_enabled: false,
    waitlist_enabled:   false,
    crm_enabled:        false,
    fareharbor_enabled: dbook.booking_mode === "fareharbor",
    scrape_urls:        [dc.website_url ?? draft.source_url].filter(Boolean),
    crawl_settings: {
      enabled:     true,
      primary_url: dc.website_url ?? draft.source_url,
      max_depth:   2,
      max_pages:   20,
      deny_patterns: [],
    },
  };

  // Insert into clients
  const { data: clientData, error: clientErr } = await supabase
    .from("clients")
    .insert(clientRow)
    .select("id")
    .single();

  if (clientErr) {
    if (clientErr.code === "23505") throw new Error(`Client ID "${slug}" already exists — edit the name and try again`);
    throw new Error(`Failed to create client: ${clientErr.message}`);
  }

  const clientId = clientData.id;

  // If bot opener text provided, insert into bot_config
  if (db.opener_text) {
    try {
      await supabase.from("bot_config").upsert({
        client_id:  clientId,
        bot_name:   db.bot_name ?? null,
        tone:       db.tone     ?? null,
        opener_text: db.opener_text,
        updated_at: new Date().toISOString(),
      }, { onConflict: "client_id" });
    } catch { /* non-fatal */ }
  }

  // Mark draft as saved + link to committed client
  await supabase
    .from("onboarding_drafts")
    .update({
      status:              "saved",
      committed_client_id: clientId,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", draftId);

  console.log(`[ONBOARDING] Draft ${draftId} committed → client ${clientId}`);

  return { clientId };
}

/**
 * Ensures the slug is unique in the clients table.
 * Appends _2, _3, etc. if needed.
 */
async function findUniqueSlug(base, supabase) {
  // Check up to 10 suffixes
  const candidates = [base, ...Array.from({ length: 9 }, (_, i) => `${base}_${i + 2}`)];

  for (const candidate of candidates) {
    const { data } = await supabase
      .from("clients")
      .select("id")
      .eq("id", candidate)
      .maybeSingle();
    if (!data) return candidate; // not taken
  }

  // Fallback: append timestamp
  return `${base}_${Date.now()}`;
}
