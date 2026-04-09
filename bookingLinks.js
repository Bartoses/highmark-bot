// ─────────────────────────────────────────────────────────────────────────────
// BOOKING LINK RESOLUTION ENGINE
//
// Single source of truth for resolving a booking URL from multiple sources:
//   1. Config   — client.bookingUrls / client.bookingLinks (confidence 1.0 / 0.75)
//   2. API      — FareHarbor item PKs from knowledge_base cache      (confidence 0.85)
//   3. Crawl    — booking pages from client_pages table              (confidence 0.70)
//   4. Fallback — browse-all links, first available                  (confidence 0.40)
//
// No regex link detection. No model-generated URLs. Always deterministic.
//
// Public API:
//   extractBookingContext(message) → { entity, company, location }
//   matchConfigLink(context, client) → { url, source, confidence } | null
//   getApiLink(context, client, supabase) → { url, source, confidence } | null
//   getCrawlLink(context, client, supabase) → { url, source, confidence } | null
//   resolveBookingLink({ message, entity, company, location, season, client, supabase })
//     → { url, source, confidence } | null
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract booking context signals from a message.
 * Returns { entity, company, location } — any may be null if not detected.
 *
 * entity:   "2hr_tour" | "3hr_tour" | "private_tour" | "rzr" | "guided_tour"
 *           | "rental" | "proride" | null
 * company:  "rea" | "csr" | null
 * location: "kremmling" | "steamboat" | null
 */
export function extractBookingContext(message) {
  const t = (message ?? "").toLowerCase();

  // Entity — ordered from most specific to most general
  let entity = null;
  if (/\b2[\s-]?hr\b|two[\s-]?hour/i.test(t))                              entity = "2hr_tour";
  else if (/\b3[\s-]?hr\b|three[\s-]?hour/i.test(t))                        entity = "3hr_tour";
  else if (/\bprivate\b/i.test(t))                                           entity = "private_tour";
  else if (/\bpro[\s-]?ride\b|backcountry|expert\s+rider/i.test(t))         entity = "proride";
  else if (/\brzr\b|side[\s-]?by[\s-]?side|\butv\b|off[\s-]?road|atv\b/i.test(t)) entity = "rzr";
  else if (/\bguided\b/i.test(t))                                            entity = "guided_tour";
  else if (/\bself[\s-]?guided\b|rental|\brent\b/i.test(t))                 entity = "rental";

  // Company
  let company = null;
  if (/rabbit[\s-]?ears|\brea\b/i.test(t))                                  company = "rea";
  else if (/colorado[\s-]?sled|\bcsr\b|sled[\s-]?rental/i.test(t))          company = "csr";

  // Location
  let location = null;
  if (/\bkremm(ling)?\b/i.test(t))                                          location = "kremmling";
  else if (/\bsteamboat\b|steam[\s-]?boat/i.test(t))                         location = "steamboat";

  return { entity, company, location };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize client booking config into a unified link array.
 * Prefers portal-managed client.bookingLinks; falls back to client.bookingUrls object.
 */
export function normalizeClientLinks(client) {
  const portalLinks = (client.bookingLinks ?? []).filter((l) => l.url);
  if (portalLinks.length) return portalLinks;

  // Convert bookingUrls keyed object → normalized array
  return Object.entries(client.bookingUrls ?? {}).map(([key, url]) => {
    const keywords = key.split("_");
    return {
      title:         key.replace(/_/g, " "),
      url,
      description:   "",
      metadata_json: {
        label:    key,
        keywords,
        location: key.includes("kremmling") ? "kremmling"
                : key.includes("steamboat")  ? "steamboat" : null,
        season:   key.includes("rzr") || key.includes("summer") ? "summer"
                : key.includes("winter")                         ? "winter" : null,
      },
    };
  });
}

/**
 * Score a single link against a context object.
 * Returns a numeric score — higher is a better match.
 */
function scoreLink(link, context) {
  const { entity, company, location, season, message } = context;
  const meta     = link.metadata_json ?? {};
  const haystack = [
    link.title,
    link.description,
    Array.isArray(meta.keywords) ? meta.keywords.join(" ") : (meta.keywords ?? ""),
    meta.label,
    meta.location,
    meta.category,
    meta.subtype,
    meta.season,
  ].filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");

  const text = (message ?? "").toLowerCase();
  let score = 0;

  // ── Entity match (strong) ────────────────────────────────────────────────
  if (entity === "rzr"          && /rzr|off.road|rental/i.test(haystack))       score += 20;
  if (entity === "2hr_tour"     && /2[\s-]?hr|two.hour/i.test(haystack))        score += 25;
  if (entity === "3hr_tour"     && /3[\s-]?hr|three.hour/i.test(haystack))      score += 25;
  if (entity === "private_tour" && /private/i.test(haystack))                   score += 25;
  if (entity === "proride"      && /pro.?ride|backcountry/i.test(haystack))     score += 25;
  if (entity === "guided_tour"  && /guided|tour/i.test(haystack))               score += 18;
  if (entity === "rental"       && /rental|self.guided/i.test(haystack))        score += 18;

  // ── Company match (strong) ───────────────────────────────────────────────
  if (company === "rea" && /rea|rabbit.ears|rabbitears/i.test(haystack))        score += 20;
  if (company === "csr" && /csr|colorado.sled|coloradosled/i.test(haystack))    score += 20;

  // ── Location match (medium) ──────────────────────────────────────────────
  if (location === "kremmling" && /kremmling/i.test(haystack))                  score += 15;
  if (location === "steamboat" && /steamboat/i.test(haystack))                  score += 15;

  // ── Geographic aliases ────────────────────────────────────────────────────
  if (/north\s*routt|buffalo\s*pass|buff\s*pass/i.test(text) && /steamboat/i.test(haystack)) score += 12;
  if (/rabbit\s*ears/i.test(text)                             && /rabbit|rea/i.test(haystack)) score += 12;
  if (/middle\s*park|\bblm\b/i.test(text)                     && /kremmling/i.test(haystack)) score += 12;

  // ── Season match (light) ─────────────────────────────────────────────────
  if (season === "summer"  && /rzr|summer|off.road|rental/i.test(haystack))    score += 5;
  if (season !== "summer"  && /snowmobile|sled|tour|winter/i.test(haystack))   score += 5;
  if (meta.season && meta.season === season)                                    score += 5;

  // ── General keyword overlap (words > 3 chars) ────────────────────────────
  for (const word of text.split(/\W+/).filter((w) => w.length > 3)) {
    if (haystack.includes(word)) score += 8;
  }

  // Slight deprioritize generic browse-all
  if (/browse.?all/i.test(haystack)) score -= 3;

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 1: CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a booking link from client config (bookingUrls or bookingLinks).
 * Returns { url, source: 'config', confidence } or null.
 * confidence = 1.0 for clear winner, 0.75 for soft match.
 */
export function matchConfigLink(context, client) {
  const links = normalizeClientLinks(client);
  if (!links.length) return null;
  if (links.length === 1) return { url: links[0].url, source: "config", confidence: 1.0 };

  const scored = links
    .map((link) => ({ link, score: scoreLink(link, context) }))
    .sort((a, b) => b.score - a.score);

  const top    = scored[0];
  const second = scored[1];

  // Clear winner: score > 0 and 1.5× better than runner-up
  if (top.score >= 10 && top.score > (second?.score ?? 0) * 1.5 + 5) {
    return { url: top.link.url, source: "config", confidence: 1.0 };
  }
  // Soft match
  if (top.score > 0) {
    return { url: top.link.url, source: "config", confidence: 0.75 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: API (FareHarbor item cache)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up a booking URL from the FareHarbor knowledge_base cache.
 * Constructs the FH embed URL from the matching item's PK.
 * Returns { url, source: 'api', confidence: 0.85 } or null.
 */
export async function getApiLink(context, client, supabase) {
  // RZR/Polaris uses config, not FareHarbor
  if (context.entity === "rzr") return null;

  // Only for FH-enabled clients
  if (!["fareharbor", "api_live_booking"].includes(client.bookingMode)) return null;
  if (!supabase) return null;

  const { entity, company, season, message } = context;

  // Determine which FH company to query
  const targetCompany = company ?? (season === "summer" ? "csr" : "rea");

  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("data")
      .eq("key", `${targetCompany}_fareharbor`)
      .single();

    const items = data?.data?.items ?? [];
    if (!items.length) return null;

    const text = (message ?? "").toLowerCase();
    let best = null;
    let bestScore = 0;

    for (const item of items) {
      const name = (item.name ?? "").toLowerCase();
      let score = 0;
      if (entity === "2hr_tour"     && /2[\s-]?hr|two.hour/i.test(name))  score += 20;
      if (entity === "3hr_tour"     && /3[\s-]?hr|three.hour/i.test(name)) score += 20;
      if (entity === "private_tour" && /private/i.test(name))              score += 20;
      if (entity === "guided_tour"  && /guided/i.test(name))               score += 15;
      if (entity === "proride"      && /pro.?ride|backcountry/i.test(name)) score += 20;
      // General word overlap
      for (const word of text.split(/\W+/).filter((w) => w.length > 4)) {
        if (name.includes(word)) score += 8;
      }
      if (score > bestScore) { bestScore = score; best = item; }
    }

    if (!best || bestScore < 8) return null;

    const shortnames = {
      rea: "rabbitearsadventures",
      csr: "coloradosledrentals",
    };
    const shortname = shortnames[targetCompany];
    if (!shortname || !best.pk) return null;

    const url = `https://fareharbor.com/embeds/book/${shortname}/items/${best.pk}/?ref=highmark&full-items=yes`;
    return { url, source: "api", confidence: 0.85 };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: CRAWL (client_pages table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look for booking page URLs in the client_pages crawl table.
 * Returns { url, source: 'crawl', confidence: 0.70 } or null.
 */
export async function getCrawlLink(context, client, supabase) {
  if (!supabase) return null;

  try {
    const { data: pages } = await supabase
      .from("client_pages")
      .select("url, key_facts, page_type")
      .eq("client_id", client.id)
      .in("page_type", ["booking", "services", "pricing"])
      .limit(20);

    if (!pages?.length) return null;

    const text = (context.message ?? "").toLowerCase();

    for (const page of pages) {
      if (!page.url?.startsWith("https://")) continue;
      // Skip general site pages — only FH / Polaris booking pages are useful here
      if (!/fareharbor\.com|polaris\.com|book|reserv/i.test(page.url)) continue;

      const factsText = JSON.stringify(page.key_facts ?? "").toLowerCase();
      let score = page.page_type === "booking" ? 5 : 2;

      if (context.entity && factsText.includes(context.entity.replace(/_/g, " "))) score += 10;
      if (context.location && factsText.includes(context.location)) score += 8;
      for (const word of text.split(/\W+/).filter((w) => w.length > 4)) {
        if (factsText.includes(word)) score += 3;
      }

      if (score >= 5) return { url: page.url, source: "crawl", confidence: 0.70 };
    }

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 4: FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

function getFallbackLink(context, client) {
  const { entity, season } = context;
  const urls = client.bookingUrls ?? {};

  // RZR fallback
  if (entity === "rzr" || season === "summer") {
    if (urls.rzr_steamboat) return { url: urls.rzr_steamboat, source: "fallback", confidence: 0.4 };
    if (urls.rzr_kremmling) return { url: urls.rzr_kremmling, source: "fallback", confidence: 0.4 };
  }

  // Winter / generic fallback — prefer REA browse-all, then CSR, then all_winter
  if (urls.rea_browse_all) return { url: urls.rea_browse_all, source: "fallback", confidence: 0.4 };
  if (urls.csr_browse_all) return { url: urls.csr_browse_all, source: "fallback", confidence: 0.4 };
  if (urls.all_winter)     return { url: urls.all_winter,     source: "fallback", confidence: 0.4 };

  // Last resort: first link in normalized list
  const links = normalizeClientLinks(client);
  if (links.length) return { url: links[0].url, source: "fallback", confidence: 0.3 };

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the best booking link for a given context.
 *
 * @param {object} opts
 * @param {string}  opts.message   — original user message (used for scoring)
 * @param {string}  [opts.entity]  — pre-extracted entity (from extractBookingContext)
 * @param {string}  [opts.company] — pre-extracted company
 * @param {string}  [opts.location]— pre-extracted location
 * @param {string}  [opts.season]  — "winter" | "summer" | "shoulder"
 * @param {object}  opts.client    — resolved client config
 * @param {object}  [opts.supabase]— Supabase client (for API + crawl sources)
 *
 * @returns {{ url: string, source: string, confidence: number } | null}
 */
export async function resolveBookingLink({ message, entity, company, location, season, client, supabase }) {
  const context = {
    message:  message  ?? "",
    entity:   entity   ?? null,
    company:  company  ?? null,
    location: location ?? null,
    season:   season   ?? "winter",
  };

  // 1. Config — fastest path, highest reliability
  const configResult = matchConfigLink(context, client);
  if (configResult?.confidence >= 0.9) {
    console.log(`[BOOKING LINK] source=config confidence=${configResult.confidence} url=${configResult.url}`);
    return configResult;
  }

  // 2. API — FareHarbor KB cache (only if supabase available)
  if (supabase) {
    const apiResult = await getApiLink(context, client, supabase);
    if (apiResult) {
      console.log(`[BOOKING LINK] source=api confidence=${apiResult.confidence} url=${apiResult.url}`);
      return apiResult;
    }
  }

  // 3. Config soft match (returned after API so API can override low-confidence config)
  if (configResult) {
    console.log(`[BOOKING LINK] source=config confidence=${configResult.confidence} url=${configResult.url}`);
    return configResult;
  }

  // 4. Crawl
  if (supabase) {
    const crawlResult = await getCrawlLink(context, client, supabase);
    if (crawlResult) {
      console.log(`[BOOKING LINK] source=crawl confidence=${crawlResult.confidence} url=${crawlResult.url}`);
      return crawlResult;
    }
  }

  // 5. Fallback
  const fallback = getFallbackLink(context, client);
  if (fallback) {
    console.log(`[BOOKING LINK] source=fallback confidence=${fallback.confidence} url=${fallback.url}`);
    return fallback;
  }

  console.log(`[BOOKING LINK] no link resolved for client=${client.id}`);
  return null;
}
