// ─────────────────────────────────────────────────────────────────────────────
// CRAWLER — Whole-site crawler + structured knowledge extraction
//
// Phase 2: Crawls a client's website starting from a primary URL, follows
// same-domain links, extracts page facts per page, stores in client_pages table.
//
// Token strategy:
//   Crawl + link extraction  — zero Claude, JS only
//   Fact extraction per page — single Haiku call, hash-gated (skip if unchanged)
//   Context assembly         — zero Claude, JS-built from stored facts
//
// Exports:
//   crawlSite(primaryUrl, options)          — fetch pages + follow same-domain links
//   classifyPageType(url, title, text)      — detect page category
//   normalizeCrawlUrl(url)                  — canonical form for dedup
//   isJunkPath(url)                         — true for paths that should be skipped
//   extractPageLinks(html, baseUrl)         — same-domain links from an HTML page
//   extractPageTitle(html)                  — title element text
//   buildCrawlerContext(clientId, supabase) — compact KB string from DB
//   runCrawlerForClient(supabase, anthropic, client) — full crawl + extract + save
// ─────────────────────────────────────────────────────────────────────────────

import fetch     from "node-fetch";
import { parse as parseHtml } from "node-html-parser";
import { createHash } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Page types in priority order — highest-value content first for context assembly
const PAGE_TYPE_PRIORITY = [
  "homepage", "services", "pricing", "booking",
  "faq", "policies", "hours", "contact", "seasonal", "other",
];

const PAGE_TYPE_LABELS = {
  homepage: "Overview",
  services: "Services",
  pricing:  "Pricing",
  booking:  "Booking",
  faq:      "FAQ",
  policies: "Policies",
  hours:    "Hours",
  contact:  "Contact",
  seasonal: "Seasonal",
  other:    "Info",
};

// URL path patterns that indicate low-value or non-content pages
const JUNK_PATTERNS = [
  /\/wp-admin(\/|$)/i,
  /\/wp-json(\/|$)/i,
  /\/wp-content\//i,
  /\/feed(\/|$)/i,
  /\/tag\//i,
  /\/author\//i,
  /\/page\/\d+/i,
  /\/cdn-cgi\//i,
  /\/cart(\/|$)/i,
  /\/checkout(\/|$)/i,
  /\/account(\/|$)/i,
  /\/login(\/|$)/i,
  /\/logout(\/|$)/i,
  /\/my-account(\/|$)/i,
  /\/sitemap/i,
  /\/rss/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|xml|txt|zip|webp|woff|woff2|ttf|eot|map)$/i,
];

// Max stored clean_text per page — prevents blowing up the DB
const MAX_CLEAN_TEXT_CHARS = 3000;

// Max assembled crawler context string (injected into bot system prompt)
const MAX_CRAWLER_CONTEXT_CHARS = 2500;

// URL patterns for pages that classify as "services" but typically carry no
// service-specific info (contact, about, blog index, privacy, newsletter, …).
// Bumping these out frees context budget for actual location/product pages.
const LOW_VALUE_URL_PATTERNS = [
  /\/contact(-us)?\/?$/i,
  /\/about(-us)?\/?$/i,
  /\/privacy/i,
  /\/terms/i,
  /\/policy|policies/i,
  /\/newsletter/i,
  /\/blog\/?$/i,
  /\/blog\//i,
  /\/login|\/signin|\/signup/i,
  /\/sitemap/i,
  /\/cart|\/checkout/i,
];

// Title/summary tokens that indicate a comparison or hub page (e.g.
// "Best RZR Rentals — Compare All Locations"). These pages frequently
// enumerate every distinct offering in one spot, so we boost them.
const HUB_PAGE_RE = /\b(compare|comparison|all locations|all options|best|overview|differences?|vs\b|guide to)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// URL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the URL path looks like a junk/non-content URL.
 * Exported for testing.
 */
export function isJunkPath(url) {
  try {
    const { pathname, search, hash } = new URL(url);
    // Skip query strings and fragments — they usually indicate dynamic/filtered views
    if (search || hash) return true;
    return JUNK_PATTERNS.some((p) => p.test(pathname));
  } catch {
    return true; // malformed URL
  }
}

/**
 * Returns a canonical URL for deduplication:
 * - lowercased
 * - trailing slash removed (except root "/")
 * - query string + fragment cleared
 */
export function normalizeCrawlUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash   = "";
    const path = u.pathname.replace(/\/+$/, ""); // empty string for root — normalizes to host only
    return `${u.protocol}//${u.host}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Extracts and returns same-domain links from an HTML page.
 * Filters out external links, junk paths, and deduplicates.
 * Exported for testing.
 */
export function extractPageLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }

  const root  = parseHtml(html);
  const links = new Set();

  for (const a of root.querySelectorAll("a[href]")) {
    try {
      const href = a.getAttribute("href") ?? "";
      if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      const resolved    = new URL(href, baseUrl);
      // Same origin only
      if (resolved.origin !== base.origin) continue;
      // Clear query + fragment before junk check
      resolved.search = "";
      resolved.hash   = "";
      const canonical = resolved.href;
      if (!isJunkPath(canonical)) links.add(canonical);
    } catch { /* malformed href */ }
  }

  return [...links];
}

// Patterns used by extractPromoStrips — promo banners typically combine an
// action verb ("opens", "use code") with a date marker ("May 25", "Friday").
const PROMO_VERB_RE   = /\b(opens?|opening|reopens?|reopening|closed?|closing|launch(es|ing)?|starts?|starting|begins?|beginning|ends?|ending|use\s+code|promo|sale|book\s+by|reservations?\s+open|now\s+booking)\b/i;
const PROMO_DATE_RE   = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|this\s+week(end)?|next\s+week(end)?)\b|\b\d{1,2}\/\d{1,2}\b/i;

/**
 * Finds short promo-strip text on the page (e.g. "Steamboat locations open May 25").
 * These often live in plain <div>/<span> elements that the main extractor skips,
 * but they carry the most time-sensitive information for guests. We dedupe by
 * containment, preferring the shortest matching string so we get the strip itself
 * rather than its parent block.
 * Exported for testing.
 */
export function extractPromoStrips(root) {
  const candidates = [];
  for (const el of root.querySelectorAll("div, span, header, section, p, li, aside")) {
    const text = (el.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 10 || text.length > 250) continue;
    if (!PROMO_VERB_RE.test(text) || !PROMO_DATE_RE.test(text)) continue;
    candidates.push(text);
  }
  candidates.sort((a, b) => a.length - b.length);
  const kept = [];
  for (const text of candidates) {
    if (kept.some((k) => k === text || k.includes(text) || text.includes(k))) continue;
    kept.push(text);
  }
  return kept.slice(0, 5);
}

/**
 * Extracts plain text from an HTML page, prioritizing content elements.
 * Internal — not exported (similar to knowledgeBase.js extractMeaningfulText,
 * but tuned for multi-page crawling without prioritization bubble logic).
 */
function extractCleanText(html) {
  const root = parseHtml(html);

  // Capture promo strips before noise removal — banners often live in <header> or similar.
  const promoStrips = extractPromoStrips(root);

  // Remove noise
  root.querySelectorAll(
    "script, style, nav, footer, header, [aria-hidden], .cookie, .banner, .popup, aside"
  ).forEach((el) => el.remove());

  // Prefer main content container
  const CANDIDATES = ["main", "article", '[role="main"]', ".content", ".entry-content", "#content", ".page-content", ".site-content"];
  let container = null;
  for (const sel of CANDIDATES) {
    container = root.querySelector(sel);
    if (container) break;
  }
  if (!container) container = root;

  const lines = [];
  for (const el of container.querySelectorAll("h1, h2, h3, h4, p, li, td, th, .price, .rate, dt, dd")) {
    const text = el.text.replace(/\s+/g, " ").trim();
    if (text.length > 20) lines.push(text);
  }

  // Prepend promo strips so they appear early in the truncated text Haiku sees.
  return [...promoStrips, ...lines].join("\n");
}

/**
 * Extracts the <title> element text from HTML.
 * Exported for testing.
 */
export function extractPageTitle(html) {
  try {
    const root  = parseHtml(html);
    const title = root.querySelector("title");
    return title?.text?.replace(/\s+/g, " ").trim() ?? "";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies a page as one of the PAGE_TYPE_PRIORITY categories.
 * Uses URL path + page title + first ~200 chars of text.
 * Exported for testing.
 *
 * @param {string} url
 * @param {string} title
 * @param {string} text
 * @returns {string} page type
 */
export function classifyPageType(url, title, text) {
  let path = "/";
  try { path = new URL(url).pathname.toLowerCase(); } catch { /* use default */ }

  const combined = `${path} ${(title ?? "").toLowerCase()}`;
  const t        = (text ?? "").slice(0, 200).toLowerCase();

  // Homepage: root path or /index or /home
  if (/^\/$|^\/index(\.html?)?$|^\/home(\/|$)/.test(path)) return "homepage";

  // Pricing: path or title keyword
  if (/\/(pric|rate|cost|fee)(s|ing)?(\/|$)/.test(path) || /pric(e|ing|es)|rates?|per person|\$\d+/.test(combined)) return "pricing";

  // Booking / reservations
  if (/\/(book|reserv|schedule)(ing)?(\/|$)/.test(path) || /\bbook\b|\breserv(e|ation)|\bschedul/.test(combined)) return "booking";

  // Services / tours / rentals
  if (/\/(service|tour|rental|activit|experienc|adventur|offer|what-we)(s|y|e|ies)?(\/|$)/.test(path) || /services|tours|rentals|activities|what we offer/.test(combined)) return "services";

  // FAQ
  if (/\/(faq|question|help)(s)?(\/|$)/.test(path) || /faq|frequently asked/.test(combined)) return "faq";

  // Policies (cancellation, terms, legal, age/weight requirements)
  if (/\/(polic|term|cancel|refund|legal|waivers?)(y|ies|s)?(\/|$)/.test(path) || /polic(y|ies)|terms|cancellation|refund/.test(combined)) return "policies";

  // Hours / schedule
  if (/\/(hour|schedule|when|calendar|visit)(s)?(\/|$)/.test(path) || /hours|open daily|operating hours|open monday/.test(combined + t)) return "hours";

  // Contact / about / location
  if (/\/(contact|about|location|find-us|directions?)(\/|$)/.test(path) || /contact us|get in touch|our location|find us/.test(combined)) return "contact";

  // Seasonal
  if (/\/(season|winter|summer|snow|spring|fall)(al|\/|$)/.test(path) || /seasonal|winter season|summer season|open in/.test(combined + t)) return "seasonal";

  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// FACT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

export function buildFactExtractionPrompt(page, clientName) {
  const typeHints = {
    homepage:  "main offerings, business overview, unique value proposition; current promo banners; any visible opening or season-launch dates",
    services:  "specific services, tours, rentals; what is included; group sizes; capacity; which season or location each offering runs in",
    pricing:   "exact prices, rates, what is included, deposits, payment terms",
    booking:   "how to book, minimum notice, requirements, lead time needed",
    faq:       "the 2-3 most important guest questions and their answers",
    policies:  "cancellation policy, age/weight/fitness requirements, what to bring, restrictions",
    hours:     "days and hours of operation, seasonal closures, contact info",
    contact:   "phone number, email, physical address, how to reach the team",
    seasonal:  "which activities run in which season; opening dates, closing dates, season start/end months or specific dates; location-specific launch windows",
    other:     "any relevant business facts guests would ask about",
  };
  const hint = typeHints[page.pageType] ?? typeHints.other;

  return `Extract structured facts from this ${page.pageType} page for ${clientName ?? "a business"} SMS concierge.
Return ONLY a JSON object — no other text:
{
  "summary": "one sentence (max 100 chars) describing what this page is about",
  "key_facts": ["most important guest-facing fact (max 70 chars)", "second fact if present", "third fact if present"]
}
Focus on: ${hint}. Omit fields that are empty. Max 3 key_facts.
ALWAYS capture (regardless of page type) any text indicating CURRENT operating status — opening dates, closing dates, season launch dates, "opens [date]", "closed for the season", per-location launch windows, or any specific dates printed on banners or promo strips. Quote the date verbatim when shown.
Page title: ${page.title ?? ""}
Page content:
${page.text.slice(0, 2000)}`;
}

/**
 * Calls Haiku to extract structured facts from a crawled page.
 * Returns { summary, key_facts } or null on failure.
 */
async function extractPageFacts(page, client, anthropic) {
  if (!anthropic || !page.text || page.status !== "ok") return null;
  try {
    const res = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages:   [{ role: "user", content: buildFactExtractionPrompt(page, client?.name) }],
    });

    const raw   = res.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    // Normalize key_facts to an array of strings
    if (parsed.key_facts && !Array.isArray(parsed.key_facts)) {
      parsed.key_facts = [String(parsed.key_facts)];
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildPageSnippet(pageType, facts, summary) {
  if (!facts && !summary) return null;
  const label = PAGE_TYPE_LABELS[pageType] ?? "Info";
  const parts = [];
  if (facts?.summary || summary) parts.push(facts?.summary ?? summary);
  if (facts?.key_facts?.length) {
    const cleaned = facts.key_facts.filter(Boolean).slice(0, 3).join("; ");
    if (cleaned) parts.push(cleaned);
  }
  if (!parts.length) return null;
  return `${label}: ${parts.join(" — ")}`;
}

// Slug-based dedup: pull meaningful tokens (>3 chars) from a URL's last
// path segment so /kremmling-rzr-rentals and /kremmling-summer share token
// "kremmling" and the second one is dropped as a near-dup.
function urlTokens(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "").toLowerCase();
    const last = path.split("/").filter(Boolean).pop() ?? "_root";
    return new Set(last.split(/[^a-z0-9]+/).filter((t) => t.length > 3));
  } catch { return new Set(); }
}

function isNearDup(tokensA, tokensB) {
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared++;
  return shared >= 2; // 2+ shared meaningful tokens → same topic
}

// Score a page for inclusion ranking. Higher = more useful.
// Rough heuristics — designed to surface comparison/hub pages and
// info-dense content over thin contact/blog/policy stubs.
function scorePage(page, snippet) {
  let score = 0;
  const url     = page.url ?? "";
  const title   = page.title ?? "";
  const summary = page.extracted_facts?.summary ?? page.summary ?? "";

  if (LOW_VALUE_URL_PATTERNS.some((re) => re.test(url))) score -= 50;
  if (HUB_PAGE_RE.test(title) || HUB_PAGE_RE.test(summary))  score += 25;

  // Reward enumeration: snippets with several commas usually list multiple items.
  const commas = (snippet.match(/[,;]/g) ?? []).length;
  score += Math.min(commas, 6) * 2;

  // Reward density (longer snippets carry more info, capped).
  score += Math.min(snippet.length / 60, 10);

  // Reward explicit numeric callouts ("4 locations", "3 tour types", etc.).
  if (/\b\d+\s+(locations?|tours?|options?|trails?|areas?|services?)\b/i.test(snippet)) score += 15;

  return score;
}

/**
 * Assembles a compact knowledge string from the client_pages table.
 *
 * Selection strategy:
 *   1. Dedupe by page_type (keep best of each non-services type)
 *   2. Within services/other, score by hub-ness + density - low-value penalty
 *   3. URL-token dedup so we don't burn budget on /kremmling-rzr + /kremmling-summer
 *   4. Pack greedy until MAX_CRAWLER_CONTEXT_CHARS
 *
 * Returns "" if no pages found or supabase is unavailable.
 */
export async function buildCrawlerContext(clientId, supabase) {
  if (!supabase || !clientId) return "";

  try {
    const { data: pages } = await supabase
      .from("client_pages")
      .select("url, page_type, title, extracted_facts, summary")
      .eq("client_id", clientId)
      .eq("status", "ok");

    if (!pages?.length) return "";

    // Build snippets up front so scoring sees the actual text.
    const candidates = [];
    for (const page of pages) {
      const snippet = buildPageSnippet(page.page_type, page.extracted_facts, page.summary);
      if (!snippet) continue;
      candidates.push({ page, snippet, score: 0 });
    }
    for (const c of candidates) c.score = scorePage(c.page, c.snippet);

    // Group by page_type so homepage/faq/etc. each contribute at most one,
    // but services/other can contribute multiple ranked hits.
    const byType = new Map();
    for (const c of candidates) {
      const t = c.page.page_type ?? "other";
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(c);
    }
    for (const list of byType.values()) list.sort((a, b) => b.score - a.score);

    const ordered = [];
    for (const t of PAGE_TYPE_PRIORITY) {
      const list = byType.get(t);
      if (!list?.length) continue;
      if (t === "services" || t === "other") {
        ordered.push(...list);          // many allowed
      } else {
        ordered.push(list[0]);          // one each — homepage, faq, hours, contact, …
      }
    }

    // URL-token dedup pass — drop later candidates that share 2+ tokens with
    // an already-kept candidate. Higher-scored pages keep their slot.
    const kept = [];
    const keptTokens = [];
    for (const c of ordered) {
      const tokens = urlTokens(c.page.url ?? "");
      if (keptTokens.some((t) => isNearDup(tokens, t))) continue;
      kept.push(c);
      keptTokens.push(tokens);
    }

    const snippets = [];
    let totalLen = 0;
    for (const c of kept) {
      if (totalLen + c.snippet.length + 1 > MAX_CRAWLER_CONTEXT_CHARS) break;
      snippets.push(c.snippet);
      totalLen += c.snippet.length + 1;
    }

    return snippets.length ? `WEBSITE KNOWLEDGE:\n${snippets.join("\n")}` : "";
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CRAWLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crawls a website starting from primaryUrl, following same-domain links.
 * Returns an array of page objects (status: 'ok' | 'error').
 *
 * Options:
 *   seedUrls    {string[]} — additional starting URLs (same domain)
 *   maxDepth    {number}   — link-hop depth limit (default 2)
 *   maxPages    {number}   — total page fetch limit (default 20)
 *   denyPatterns{string[]} — extra URL substrings to skip
 */
export async function crawlSite(primaryUrl, options = {}) {
  const {
    seedUrls     = [],
    maxDepth     = 2,
    maxPages     = 20,
    denyPatterns = [],
  } = options;

  const startUrls = [primaryUrl, ...seedUrls].filter(Boolean);
  const visited   = new Set();
  const queue     = startUrls.map((url) => ({ url, depth: 0 }));
  const pages     = [];

  const isDenied = (url) =>
    denyPatterns.some((p) => url.includes(p));

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    const normalized = normalizeCrawlUrl(url);

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (isJunkPath(url) || isDenied(url)) continue;

    let html, title, text;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Highmark-Bot/2.0 (+https://usehighmark.com)" },
        timeout: 10000,
      });

      if (!res.ok) {
        pages.push({ url, normalizedUrl: normalized, status: "error", error: `HTTP ${res.status}` });
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) continue;

      html  = await res.text();
      title = extractPageTitle(html);
      text  = extractCleanText(html);
    } catch (err) {
      pages.push({ url, normalizedUrl: normalized, status: "error", error: err.message });
      continue;
    }

    const hash     = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const pageType = classifyPageType(url, title, text);

    pages.push({ url, normalizedUrl: normalized, title, pageType, text, hash, status: "ok" });

    // Enqueue discovered links if depth budget remains
    if (depth < maxDepth) {
      const links = extractPageLinks(html, url);
      for (const link of links) {
        const norm = normalizeCrawlUrl(link);
        if (!visited.has(norm)) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  return pages;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR — called from knowledgeBase.js cron
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full crawl pipeline for a single client:
 *   1. Crawl site (respects crawlSettings config)
 *   2. For each page: check hash, run Haiku extraction only if content changed
 *   3. Upsert page records to client_pages table
 *
 * Options:
 *   forceReextract — when true, ignore the stored content_hash and re-run Haiku
 *     extraction on every page. Use after the extraction prompt changes so the
 *     stored facts pick up the new instructions without waiting for content to
 *     drift. Surfaced via the portal "Crawl now (force)" button.
 *
 * Skips silently if crawlSettings.enabled is falsy or no primaryUrl configured.
 * Never throws — all errors are logged and swallowed.
 */
export async function runCrawlerForClient(supabase, anthropic, client, { forceReextract = false } = {}) {
  const crawlSettings = client?.crawlSettings ?? {};
  if (!crawlSettings.enabled) return;

  const primaryUrl = crawlSettings.primaryUrl ?? client.websiteUrl;
  if (!primaryUrl) {
    console.warn(`[CRAWLER][${client.id}] No primaryUrl configured — skipping.`);
    return;
  }

  console.log(`[CRAWLER][${client.id}] Crawl starting: ${primaryUrl}`);

  let pages;
  try {
    pages = await crawlSite(primaryUrl, {
      seedUrls:     crawlSettings.seedUrls     ?? [],
      maxDepth:     crawlSettings.maxDepth     ?? 2,
      maxPages:     crawlSettings.maxPages     ?? 20,
      denyPatterns: crawlSettings.denyPatterns ?? [],
    });
  } catch (err) {
    console.error(`[CRAWLER][${client.id}] Crawl failed:`, err.message);
    return;
  }

  console.log(`[CRAWLER][${client.id}] Crawled ${pages.length} pages.`);

  for (const page of pages) {
    try {
      if (page.status === "error") {
        await supabase.from("client_pages").upsert({
          client_id:     client.id,
          url:           page.url,
          normalized_url: page.normalizedUrl,
          status:        "error",
          error_message: page.error,
          fetched_at:    new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        }, { onConflict: "client_id, normalized_url" });
        continue;
      }

      // Check existing hash to gate fact extraction
      const { data: existing } = await supabase
        .from("client_pages")
        .select("content_hash, extracted_facts, summary")
        .eq("client_id", client.id)
        .eq("normalized_url", page.normalizedUrl)
        .maybeSingle();

      let extractedFacts = null;
      let pageSummary    = null;

      if (!forceReextract && existing?.content_hash === page.hash && existing?.extracted_facts) {
        // Content unchanged — reuse stored facts
        extractedFacts = existing.extracted_facts;
        pageSummary    = existing.summary;
      } else {
        // New or changed — extract facts via Haiku
        extractedFacts = await extractPageFacts(page, client, anthropic);
        pageSummary    = extractedFacts?.summary ?? null;
      }

      await supabase.from("client_pages").upsert({
        client_id:       client.id,
        url:             page.url,
        normalized_url:  page.normalizedUrl,
        page_type:       page.pageType,
        title:           page.title,
        clean_text:      page.text.slice(0, MAX_CLEAN_TEXT_CHARS),
        content_hash:    page.hash,
        extracted_facts: extractedFacts,
        summary:         pageSummary,
        fetched_at:      new Date().toISOString(),
        status:          "ok",
        error_message:   null,
        updated_at:      new Date().toISOString(),
      }, { onConflict: "client_id, normalized_url" });

    } catch (err) {
      console.error(`[CRAWLER][${client.id}] Save failed for ${page.url}:`, err.message);
    }
  }

  console.log(`[CRAWLER][${client.id}] Crawl complete — ${pages.filter((p) => p.status === "ok").length} pages saved.`);
}
