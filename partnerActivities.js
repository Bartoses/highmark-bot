// ─────────────────────────────────────────────────────────────────────────────
// SPRINT 5 — ACTIVITY DISTRIBUTION NETWORK
//
// Read / score / context helpers for partner_activities (db1_partner_activities.sql).
//
// Behavior:
//   - Partner activities surface as Source 5 inside resolveBookingLink() ONLY if
//     no higher-confidence source (config / api / crawl / fallback ≥ 0.60) matches.
//     This module is additive — it never overrides the client's own booking logic.
//   - Context is injected into the system prompt so Claude can recommend a
//     partner offering when the guest asks about something the client does not sell.
//   - All outbound URLs are rewritten through /track/partner?id=... so we can log
//     partner_link_clicked events in web_events.
//
// Public API:
//   getActivePartnerActivities(supabase, clientId, { season })
//   buildPartnerActivitiesContext(partners, { trackingBaseUrl })
//   scorePartnerMatch(partner, context)
//   resolvePartnerLink(context, client, supabase, opts)
//   detectSeasonFromContext(context)
//   buildPartnerTrackingUrl(partnerId, { base, sessionId, channel })
//   PARTNER_MATCH_THRESHOLD
// ─────────────────────────────────────────────────────────────────────────────

export const PARTNER_MATCH_THRESHOLD = 12;   // min score to surface a partner link
export const PARTNER_CONFIDENCE      = 0.60; // Source 5 confidence
const TABLE = "partner_activities";

// ─────────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────────

export async function getActivePartnerActivities(supabase, clientId, { season } = {}) {
  if (!supabase || !clientId) return [];

  try {
    let query = supabase
      .from(TABLE)
      .select("*")
      .eq("client_id", clientId)
      .eq("enabled", true)
      .order("created_at", { ascending: true });

    const { data, error } = await query;
    if (error) return [];

    const all = data ?? [];
    if (!season) return all;

    // Season filter: keep rows tagged with the requested season OR "all".
    // "shoulder" also keeps winter + summer partners (overlap period).
    const s = (season ?? "").toLowerCase();
    return all.filter((p) => {
      const seasons = Array.isArray(p.seasons) ? p.seasons.map((x) => String(x).toLowerCase()) : [];
      if (!seasons.length || seasons.includes("all")) return true;
      if (seasons.includes(s)) return true;
      if (s === "shoulder" && (seasons.includes("winter") || seasons.includes("summer"))) return true;
      return false;
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE
// ─────────────────────────────────────────────────────────────────────────────

export function scorePartnerMatch(partner, context) {
  const text = (context?.message ?? "").toLowerCase();
  if (!partner || !text) return 0;

  const keywords = Array.isArray(partner.keywords) ? partner.keywords : [];
  const haystack = [
    partner.activity_name,
    partner.partner_name,
    partner.category,
    partner.description,
    partner.location,
    keywords.join(" "),
  ].filter(Boolean).join(" ").toLowerCase();

  let score = 0;

  // Direct keyword hits — strongest signal
  for (const kw of keywords) {
    const k = String(kw).toLowerCase().trim();
    if (k && k.length >= 3 && text.includes(k)) score += 15;
  }

  // Activity name / partner name token overlap
  const nameTokens = `${partner.activity_name ?? ""} ${partner.partner_name ?? ""}`
    .toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  for (const tok of nameTokens) {
    if (text.includes(tok)) score += 8;
  }

  // Category mention (tour / rental / lodging / dining / transport)
  if (partner.category && text.includes(String(partner.category).toLowerCase())) score += 6;

  // Location hint
  if (partner.location && text.includes(String(partner.location).toLowerCase())) score += 6;

  // General word overlap with haystack
  for (const word of text.split(/\W+/).filter((w) => w.length > 4)) {
    if (haystack.includes(word)) score += 2;
  }

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT BUILDER
// Produces a plain-text block for the system prompt. Keeps it short so it can
// coexist with the client's own KB.
// ─────────────────────────────────────────────────────────────────────────────

export function buildPartnerActivitiesContext(partners, { trackingBaseUrl = "" } = {}) {
  if (!Array.isArray(partners) || partners.length === 0) return "";

  const lines = partners.slice(0, 12).map((p) => {
    const url = buildPartnerTrackingUrl(p.id, { base: trackingBaseUrl });
    const price = p.price_range ? ` (${p.price_range})` : "";
    const desc  = p.description ? ` — ${String(p.description).slice(0, 120)}` : "";
    return `- ${p.activity_name} via ${p.partner_name}${price}${desc} → ${url}`;
  });

  const intro =
    "PARTNER ACTIVITIES — activities we don't run ourselves but trust and can refer out. " +
    "Recommend ONE of these only when the guest asks about something outside our own lineup. " +
    "Never invent partners. Always use the exact URL below (it's a tracked redirect).";

  return `${intro}\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING URL BUILDER
// Builds the /track/partner redirect so clicks can be logged to web_events.
// Falls back to the raw booking URL if no partnerId is provided.
// ─────────────────────────────────────────────────────────────────────────────

export function buildPartnerTrackingUrl(partnerId, { base = "", sessionId = null, channel = "sms" } = {}) {
  if (!partnerId) return "";
  const qs = new URLSearchParams({ id: String(partnerId) });
  if (sessionId) qs.set("s", String(sessionId));
  if (channel)   qs.set("c", String(channel));
  const root = (base ?? "").replace(/\/+$/, "");
  return `${root}/track/partner?${qs.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEASON DETECTION
// Pure helper — lets resolveBookingLink / callers infer season from free text
// when they don't already have one. Defers to context.season if present.
// ─────────────────────────────────────────────────────────────────────────────

export function detectSeasonFromContext(context) {
  if (context?.season) return context.season;
  const t = (context?.message ?? "").toLowerCase();
  if (/\b(summer|rzr|utv|off[\s-]?road|hike|kayak|raft|fishing)\b/.test(t)) return "summer";
  if (/\b(winter|snow|sled|snowmobile|ski|snowboard|powder)\b/.test(t))     return "winter";
  // Month-based fallback
  const month = new Date().getUTCMonth(); // 0-based
  if (month >= 10 || month <= 2) return "winter"; // Nov–Mar
  if (month >= 5 && month <= 9)  return "summer"; // Jun–Oct
  return "shoulder";
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE — returns { url, source: "partner", confidence, partner } or null
// Used by bookingLinks.js as Source 5.
// ─────────────────────────────────────────────────────────────────────────────

export async function resolvePartnerLink(context, client, supabase, opts = {}) {
  if (!supabase || !client?.id) return null;
  const season = detectSeasonFromContext(context);
  const partners = await getActivePartnerActivities(supabase, client.id, { season });
  if (!partners.length) return null;

  let best = null;
  let bestScore = 0;
  for (const p of partners) {
    const s = scorePartnerMatch(p, context);
    if (s > bestScore) { bestScore = s; best = p; }
  }

  if (!best || bestScore < PARTNER_MATCH_THRESHOLD) return null;

  const url = buildPartnerTrackingUrl(best.id, {
    base:      opts.trackingBaseUrl ?? "",
    sessionId: opts.sessionId ?? null,
    channel:   opts.channel   ?? "sms",
  });

  return {
    url,
    source:     "partner",
    confidence: PARTNER_CONFIDENCE,
    partner:    best,
    score:      bestScore,
  };
}
