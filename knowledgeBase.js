// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE — FareHarbor refresh + website scraper
// Keeps Summit's knowledge fresh. Runs on startup and on cron schedule.
// All functions fail gracefully — never crash the server.
//
// Token strategy:
//   FH items (24hr)      — zero Claude, JS-built summary from structured API data
//   FH availability (3hr) — zero Claude, JS-built from minimal availability endpoint
//   Website (7 days)     — single Haiku call, hash-gated (skips Claude if unchanged)
//   Weather (1hr)        — zero Claude, JS-built from OpenWeather JSON
// ─────────────────────────────────────────────────────────────────────────────
import fetch from "node-fetch";
import { createHash } from "crypto";
import { parse as parseHtml } from "node-html-parser";
import cron from "node-cron";

const FAREHARBOR_BASE     = "https://fareharbor.com/api/external/v1";
const OPENWEATHER_BASE    = "https://api.openweathermap.org/data/2.5";
const SNOTEL_BASE         = "https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/daily";
const CAIC_BASE           = "https://avalanche.state.co.us/api-proxy/avid";
const THREE_HOURS_MS      = 3 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS         = 60 * 60 * 1000;

// CLIENT_CONFIG — SNOTEL stations for trail-level snow depth (free, no API key)
// These are the official USDA monitoring stations at the elevations guests actually ride.
const SNOTEL_STATIONS = [
  { id: "713:CO:SNTL", name: "Rabbit Ears Pass",          elevation: "9,426 ft",  relevance: "REA tours" },
  { id: "825:CO:SNTL", name: "Buffalo Pass (Tower)",       elevation: "10,610 ft", relevance: "CSR backcountry / North Routt / Buff Pass" },
  { id: "369:CO:SNTL", name: "Columbine",                  elevation: "8,540 ft",  relevance: "CSR Columbine trailhead" },
  { id: "457:CO:SNTL", name: "Steamboat Ski Resort (base)", elevation: "8,240 ft", relevance: "Steamboat ski area base (3mi from Storm Peak summit)" },
];
const SEVEN_DAYS_MS       = 7 * 24 * 60 * 60 * 1000;

// CLIENT_CONFIG — one entry per company the client operates
const COMPANIES = [
  {
    id:          "csr",
    shortname:   "coloradosledrentals",
    userKeyEnv:  "FAREHARBOR_USER_KEY_CSR",
    name:        "Colorado Sled Rentals",
  },
  {
    id:          "rea",
    shortname:   "rabbitearsadventures",
    userKeyEnv:  "FAREHARBOR_USER_KEY_REA",
    name:        "Rabbit Ears Adventures",
  },
];

// CLIENT_CONFIG — pages to scrape for business knowledge
const SCRAPE_URLS = [
  "https://coloradosledrentals.com/",
  "https://coloradosledrentals.com/faq/",
  "https://coloradosledrentals.com/steamboat-summer/",
  "https://coloradosledrentals.com/kremmling-summer/",
  "https://www.rabbitearsadventures.com/",
  "https://www.rabbitearsadventures.com/faqs",
];

// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR API HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function fhHeaders(company) {
  return {
    "X-FareHarbor-API-App":  process.env.FAREHARBOR_APP_KEY,
    "X-FareHarbor-API-User": process.env[company.userKeyEnv],
  };
}

async function fhGet(path, company) {
  const res = await fetch(`${FAREHARBOR_BASE}${path}`, {
    headers: fhHeaders(company),
  });
  if (!res.ok) throw new Error(`FH ${res.status}: ${path}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR SUMMARY BUILDER — zero Claude tokens
// Builds context string directly from structured FH API data.
// ─────────────────────────────────────────────────────────────────────────────

// Extract price range from item's customer_type_rates (returns "$X" or "$X–$Y" or null)
function getPriceRange(item) {
  const rates = item.customer_type_rates ?? [];
  const prices = rates
    .map((r) => r.total_including_tax)
    .filter((p) => typeof p === "number" && p > 0)
    .map((p) => Math.round(p));
  if (!prices.length) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `$${min}` : `$${min}–$${max}`;
}

// Build availability + item summary string without Claude
function buildFhSummary(companyName, items, availabilityData) {
  const lines = [];
  for (const item of items.slice(0, 10)) {
    const avail = availabilityData[item.name];
    if (!avail) continue;
    const price     = getPriceRange(item);
    const priceNote = price ? ` (${price}/person)` : "";
    const next      = avail.next_open
      ? new Date(avail.next_open).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    const slotNote  = avail.open_days > 0
      ? `${avail.open_days} days open${next ? ", next " + next : ""}`
      : "no availability";
    lines.push(`${item.name}${priceNote}: ${slotNote}`);
  }
  return lines.length
    ? `${companyName}: ${lines.join("; ")}`.slice(0, 400)
    : `${companyName}: availability unknown`;
}

// Build item catalog summary (descriptions + pricing) — used in ITEMS section of context
function buildItemDetailsSummary(companyName, items) {
  const lines = items.slice(0, 10).map((item) => {
    const price    = getPriceRange(item);
    const headline = item.headline ?? item.description ?? "";
    const desc     = headline.replace(/\s+/g, " ").trim().slice(0, 80);
    return `${item.name}${price ? " " + price + "/person" : ""}${desc ? " — " + desc : ""}`;
  });
  return `${companyName} tours: ${lines.join(" | ")}`.slice(0, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH FAREHARBOR ITEMS — zero Claude, runs every 24 hours
// Fetches item catalog (names, PKs, descriptions, pricing). Preserves existing avail.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshFareHarborItems(supabase) {
  if (process.env.FAREHARBOR_ENABLED !== "true") return;

  for (const company of COMPANIES) {
    try {
      const { items } = await fhGet(`/companies/${company.shortname}/items/`, company);

      // Preserve existing availability data while updating item catalog
      const { data: existing } = await supabase
        .from("knowledge_base")
        .select("data")
        .eq("key", `${company.id}_fareharbor`)
        .single();
      const availabilityData = existing?.data?.availabilityData ?? {};

      const summary      = buildFhSummary(company.name, items, availabilityData);
      const itemsSummary = buildItemDetailsSummary(company.name, items);

      await supabase.from("knowledge_base").upsert({
        client_id:       "csr_rea",
        type:            "fareharbor",
        key:             `${company.id}_fareharbor`,
        data:            { items, availabilityData, itemsSummary },
        summary,
        fetched_at:      new Date().toISOString(),
        next_refresh_at: new Date(Date.now() + TWENTY_FOUR_HOURS_MS).toISOString(),
      }, { onConflict: "key" });

      console.log(`[KB] FH items refreshed: ${company.name} (${items.length} items)`);
    } catch (err) {
      console.error(`[KB] FH items refresh failed for ${company.name}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH FAREHARBOR AVAILABILITY — zero Claude, runs every 3 hours
// Reads cached items, fetches minimal availability, rebuilds summary in JS.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshFareHarborAvailability(supabase) {
  if (process.env.FAREHARBOR_ENABLED !== "true") return;

  // Same-day bookings not allowed — start availability window from tomorrow
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const start    = tomorrow.toISOString().slice(0, 10);
  const end      = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  for (const company of COMPANIES) {
    try {
      // Load cached items — if not yet fetched, skip
      const { data: row } = await supabase
        .from("knowledge_base")
        .select("data")
        .eq("key", `${company.id}_fareharbor`)
        .single();

      const items = row?.data?.items ?? [];
      if (!items.length) {
        console.warn(`[KB] No cached items for ${company.name} — skipping avail refresh`);
        continue;
      }

      const availabilityData = {};
      for (const item of items.slice(0, 10)) {
        try {
          const { availabilities } = await fhGet(
            `/companies/${company.shortname}/items/${item.pk}/minimal/availabilities/date-range/${start}/${end}/`,
            company
          );
          const openSlots = availabilities.filter(
            (a) => a.online_booking_status === "open" && a.capacity > 0
          );
          availabilityData[item.name] = {
            pk:        item.pk,
            open_days: openSlots.length,
            next_open: openSlots[0]?.start_at ?? null,
          };
        } catch {
          // Item availability failed — skip, don't abort whole refresh
        }
      }

      const summary      = buildFhSummary(company.name, items, availabilityData);
      const itemsSummary = row?.data?.itemsSummary ?? buildItemDetailsSummary(company.name, items);

      await supabase.from("knowledge_base").upsert({
        client_id:       "csr_rea",
        type:            "fareharbor",
        key:             `${company.id}_fareharbor`,
        data:            { items, availabilityData, itemsSummary },
        summary,
        fetched_at:      new Date().toISOString(),
        next_refresh_at: new Date(Date.now() + THREE_HOURS_MS).toISOString(),
      }, { onConflict: "key" });

      console.log(`[KB] FH availability refreshed: ${company.name}`);
    } catch (err) {
      console.error(`[KB] FH avail refresh failed for ${company.name}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH WEATHER KNOWLEDGE
// Fetches current conditions + 3-day forecast for Steamboat Springs.
// Also fetches Rabbit Ears Pass (higher elevation) for more accurate snow data.
// Refreshes every hour.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshWeatherKnowledge(supabase) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return;

  try {
    // Steamboat Springs town (6,695 ft) — for general conditions
    const [currentRes, forecastRes, passRes, stormPeakRes] = await Promise.all([
      fetch(`${OPENWEATHER_BASE}/weather?q=Steamboat+Springs,CO,US&appid=${apiKey}&units=imperial`),
      fetch(`${OPENWEATHER_BASE}/forecast?q=Steamboat+Springs,CO,US&appid=${apiKey}&units=imperial&cnt=24`),
      // Rabbit Ears Pass (9,426 ft) — where REA tours actually run
      fetch(`${OPENWEATHER_BASE}/weather?lat=40.38&lon=-106.60&appid=${apiKey}&units=imperial`),
      // Storm Peak / Steamboat Ski Resort summit (10,568 ft)
      fetch(`${OPENWEATHER_BASE}/weather?lat=40.457&lon=-106.804&appid=${apiKey}&units=imperial`),
    ]);

    if (!currentRes.ok) throw new Error(`Weather API ${currentRes.status}`);

    const [current, forecastData, pass, stormPeak] = await Promise.all([
      currentRes.json(),
      forecastRes.json(),
      passRes.ok ? passRes.json() : null,
      stormPeakRes.ok ? stormPeakRes.json() : null,
    ]);

    // Build daily forecast summaries (prefer noon reading per day)
    const days = {};
    for (const item of forecastData.list ?? []) {
      const date = item.dt_txt.slice(0, 10);
      if (!days[date] || item.dt_txt.includes("12:00")) {
        days[date] = {
          high:  Math.round(item.main.temp_max),
          low:   Math.round(item.main.temp_min),
          desc:  item.weather[0].description,
          snow:  (item.snow?.["3h"] ?? 0) / 25.4,  // mm → inches
        };
      }
    }

    const data = {
      steamboat: {
        temp:      Math.round(current.main.temp),
        feels_like: Math.round(current.main.feels_like),
        desc:      current.weather[0].description,
        wind_mph:  Math.round(current.wind.speed),
        snow_1h:   ((current.snow?.["1h"] ?? 0) / 25.4).toFixed(2),  // mm → inches
      },
      rabbit_ears_pass: pass ? {
        temp:     Math.round(pass.main.temp),
        desc:     pass.weather[0].description,
        wind_mph: Math.round(pass.wind.speed),
        snow_1h:  ((pass.snow?.["1h"] ?? 0) / 25.4).toFixed(2),  // mm → inches
      } : null,
      storm_peak: stormPeak ? {
        temp:     Math.round(stormPeak.main.temp),
        desc:     stormPeak.weather[0].description,
        wind_mph: Math.round(stormPeak.wind.speed),
        snow_1h:  ((stormPeak.snow?.["1h"] ?? 0) / 25.4).toFixed(2),
      } : null,
      forecast: days,
      updated_at: new Date().toISOString(),
    };

    // Build compact summary for system prompt injection
    const passNote = data.rabbit_ears_pass
      ? ` | Rabbit Ears Pass: ${data.rabbit_ears_pass.temp}°F, ${data.rabbit_ears_pass.desc}`
      : "";
    const stormPeakNote = data.storm_peak
      ? ` | Storm Peak summit: ${data.storm_peak.temp}°F, ${data.storm_peak.desc}, wind ${data.storm_peak.wind_mph}mph`
      : "";

    const dayLines = Object.entries(days).slice(0, 3).map(([date, d]) => {
      const label = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      const snowNote = d.snow > 0 ? ` +${d.snow.toFixed(1)}"` : "";
      return `${label}: ${d.low}-${d.high}°F ${d.desc}${snowNote}`;
    });

    const summary = `Steamboat: ${data.steamboat.temp}°F, ${data.steamboat.desc}, wind ${data.steamboat.wind_mph}mph${passNote}${stormPeakNote}. Forecast: ${dayLines.join(" | ")}`.slice(0, 400);

    await supabase.from("knowledge_base").upsert({
      client_id:       "csr_rea",
      type:            "weather",
      key:             "weather_steamboat",
      data,
      summary,
      fetched_at:      new Date().toISOString(),
      next_refresh_at: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
    }, { onConflict: "key" });

    console.log(`[KB] Weather refreshed: ${summary.slice(0, 100)}…`);
  } catch (err) {
    console.error("[KB] Weather refresh failed (non-fatal):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SNOW CONDITIONS — SNOTEL (snow depth) + CAIC (avalanche danger)
// Refreshes every 3 hours. Zero Claude tokens — pure JS from structured data.
// SNOTEL: USDA NRCS official stations, free, no API key required.
// CAIC:   Colorado Avalanche Information Center, free public API.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSnotelStation(stationId) {
  // NRCS report generator: returns CSV with today's snow depth, SWE, temp
  // Date offset -0,0 = today only (start of day values)
  const stationPart = encodeURIComponent(`${stationId}|id=""|name`);
  const url = `${SNOTEL_BASE}/${stationPart}/-0,0/SNWD::value,WTEQ::value,TOBS::value`;
  const res = await fetch(url, { headers: { "User-Agent": "Highmark-Bot/1.0" } });
  if (!res.ok) throw new Error(`SNOTEL ${stationId}: HTTP ${res.status}`);
  const text = await res.text();

  // Skip comment lines (start with #), find first data row
  const dataLine = text.split("\n").find(
    (l) => l.trim() && !l.startsWith("#") && /^\d{4}-\d{2}-\d{2}/.test(l.trim())
  );
  if (!dataLine) return null;

  const [date, snwd, wteq, tobs] = dataLine.split(",").map((v) => v.trim());
  return {
    date:          date,
    snow_depth_in: snwd && snwd !== "" ? parseFloat(snwd) : null,
    swe_in:        wteq && wteq !== "" ? parseFloat(wteq) : null,
    temp_f:        tobs && tobs !== "" ? parseFloat(tobs) : null,
  };
}

async function fetchCaicDanger() {
  // Steamboat & Flat Tops zone — CAIC AVID API
  // The AVID API requires datetime in ISO format with ms + includeExpired=true
  // Steamboat zone uses AVID areaId: e828f0f1db0a4fc927c33ea4078cb2f4466a9fd8dcde6db4f28ddea15d07b742
  // (publicName "21-24-38-39-9" — zone 38 = Steamboat in AVID polygon numbering)
  const STEAMBOAT_AREA_ID = "e828f0f1db0a4fc927c33ea4078cb2f4466a9fd8dcde6db4f28ddea15d07b742";
  try {
    const datetime = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const innerRaw = `/products/all?datetime=${datetime}&includeExpired=true`;
    const url = `${CAIC_BASE}?_api_proxy_uri=${encodeURIComponent(innerRaw)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Highmark-Bot/1.0" } });
    if (!res.ok) return null;

    const products = await res.json();
    if (!Array.isArray(products)) return null;

    // Match by hardcoded areaId for Steamboat & Flat Tops
    const steamboat = products.find(
      (p) => p?.areaId === STEAMBOAT_AREA_ID
    );
    if (!steamboat) return null;

    // dangerRatings.days[0] = today's forecast: { alp, tln, btl, date }
    const days = steamboat.dangerRatings?.days ?? [];
    if (!days.length) return null;
    const today = days[0];
    const alp = today.alp;  // e.g. "low", "moderate", "considerable", "high", "veryHigh", "noRating"

    if (!alp || alp === "noRating" || alp === "noForecast") return null;

    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const alpLabel = alp === "veryHigh" ? "Very High" : capitalize(alp);
    const tlnLabel = today.tln === "veryHigh" ? "Very High" : capitalize(today.tln ?? "");
    const btlLabel = today.btl === "veryHigh" ? "Very High" : capitalize(today.btl ?? "");
    return `Alpine: ${alpLabel} | Treeline: ${tlnLabel} | Below: ${btlLabel} — avalanche.state.co.us`;
  } catch {
    return null;
  }
}

async function refreshSnowConditions(supabase) {
  try {
    const stationResults = {};
    await Promise.all(
      SNOTEL_STATIONS.map(async (station) => {
        try {
          const reading = await fetchSnotelStation(station.id);
          if (reading) stationResults[station.name] = { ...station, ...reading };
        } catch (err) {
          console.warn(`[KB] SNOTEL ${station.name} failed (non-fatal):`, err.message);
        }
      })
    );

    const avalancheDanger = await fetchCaicDanger();

    // Build human-readable summary
    const stationLines = Object.values(stationResults).map((s) => {
      const depth = s.snow_depth_in !== null ? `${s.snow_depth_in}"` : "N/A";
      const swe   = s.swe_in       !== null ? ` SWE: ${s.swe_in}"` : "";
      const temp  = s.temp_f       !== null ? ` ${s.temp_f}°F` : "";
      return `${s.name} (${s.elevation}): ${depth} snow depth${swe}${temp}`;
    });

    const avalancheLine = avalancheDanger
      ? `Avalanche danger (Steamboat zone): ${avalancheDanger}`
      : "";

    const allLines = [...stationLines, avalancheLine].filter(Boolean);
    const summary  = allLines.join(" | ").slice(0, 500);

    await supabase.from("knowledge_base").upsert({
      client_id:       "csr_rea",
      type:            "snow_conditions",
      key:             "snow_conditions",
      data:            { stations: stationResults, avalanche_danger: avalancheDanger },
      summary,
      fetched_at:      new Date().toISOString(),
      next_refresh_at: new Date(Date.now() + THREE_HOURS_MS).toISOString(),
    }, { onConflict: "key" });

    console.log(`[KB] Snow conditions refreshed: ${summary.slice(0, 120)}…`);
  } catch (err) {
    console.error("[KB] Snow conditions refresh failed (non-fatal):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBSITE SCRAPER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Extract meaningful text from HTML — targets content elements, deprioritizes noise.
// Returns pre-filtered plain text ready for Claude (much smaller than raw .text).
function extractMeaningfulText(html) {
  const root = parseHtml(html);

  // Remove noise elements
  root
    .querySelectorAll("script, style, nav, footer, header, [aria-hidden], .cookie, .banner, .popup")
    .forEach((el) => el.remove());

  // Try to find the main content container
  const contentCandidates = ["main", "article", '[role="main"]', ".content", ".entry-content", "#content", ".page-content"];
  let container = null;
  for (const sel of contentCandidates) {
    container = root.querySelector(sel);
    if (container) break;
  }
  if (!container) container = root;

  // Pull text from meaningful elements only
  const elements = container.querySelectorAll("h1, h2, h3, p, li, td, th, .price, .rate");
  const lines = [];
  for (const el of elements) {
    const text = el.text.replace(/\s+/g, " ").trim();
    if (text.length > 25) lines.push(text);
  }

  // Bubble up pricing/policy lines to the top so they're never cut off
  const PRIORITY = /\$[\d,]+|\bpric(e|ing)\b|\brat(e|es)\b|\bpolic(y|ies)\b|\bcancel|\bage\b|\bweight\b|\brequir|\binclude|\bdeposit|\bminimum|\bhour|\bseason|\bsummer|\bwinter|\brzr|\bsled/i;
  const priority = lines.filter((l) => PRIORITY.test(l));
  const rest     = lines.filter((l) => !PRIORITY.test(l));

  return [...priority, ...rest].join("\n");
}

// SHA-256 hash of text content — used to skip Claude when pages haven't changed
function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH WEBSITE KNOWLEDGE
// Scrapes pages, extracts business info with a single Haiku call.
// Hash-gated: skips Claude entirely if page content hasn't changed since last run.
// Runs every 7 days.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshWebsiteKnowledge(supabase, anthropic) {
  const pageTexts = [];

  for (const url of SCRAPE_URLS) {
    try {
      const res  = await fetch(url, { timeout: 10000 });
      const html = await res.text();
      pageTexts.push(`--- ${url} ---\n${extractMeaningfulText(html)}`);
    } catch (err) {
      console.error(`[KB] Scrape failed for ${url}:`, err.message);
    }
  }

  if (!pageTexts.length) {
    console.warn("[KB] Website scrape returned no pages — keeping stale data.");
    return;
  }

  // Cap total input at 4000 chars (priority lines were bubbled up, so key info survives)
  const combinedText = pageTexts.join("\n\n").slice(0, 4000);
  const contentHash  = hashContent(combinedText);

  // Hash gate — skip Claude if content is identical to last run
  const { data: hashRow } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "website_content_hash")
    .single();

  if (hashRow?.value === contentHash) {
    // Bump the timestamp so the staleness check doesn't fire again for 7 days
    await supabase
      .from("settings")
      .upsert({ key: "last_website_scrape", value: new Date().toISOString() });
    console.log("[KB] Website unchanged (hash match) — skipped Claude.");
    return;
  }

  // Content changed — run single Haiku call (extract + summarize in one pass)
  try {
    const claudeRes = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role:    "user",
        content: `You are extracting business info for an AI SMS concierge. Read these website pages and return ONLY a JSON object — no other text:
{
  "offerings": "what experiences are offered (winter sleds, summer RZR, guided tours, rentals)",
  "pricing": "price ranges and what's included",
  "policies": "age/weight limits, cancellation policy, deposit, what to bring",
  "seasonal": "seasonal availability, when each activity runs",
  "hours": "operating hours or how to book",
  "faq": "2-3 key guest questions and short answers"
}
Rules: max 150 chars per field, plain text only, null if not found on pages.
Pages:\n${combinedText}`,
      }],
    });

    let data = {};
    try {
      const raw       = claudeRes.content[0].text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      data            = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      data = { raw: claudeRes.content[0].text.slice(0, 600) };
    }

    // Build summary in JS from the structured extraction — no second Claude call
    const parts = [
      data.offerings   && `Offerings: ${data.offerings}`,
      data.pricing     && `Pricing: ${data.pricing}`,
      data.policies    && `Policies: ${data.policies}`,
      data.seasonal    && `Seasonal: ${data.seasonal}`,
      data.hours       && `Hours: ${data.hours}`,
      data.faq         && `FAQ: ${data.faq}`,
    ].filter(Boolean);
    const summary = parts.join(" | ").slice(0, 700);

    await supabase.from("knowledge_base").upsert({
      client_id:       "csr_rea",
      type:            "website",
      key:             "website_knowledge",
      data,
      summary,
      fetched_at:      new Date().toISOString(),
      next_refresh_at: new Date(Date.now() + SEVEN_DAYS_MS).toISOString(),
    }, { onConflict: "key" });

    await supabase.from("settings").upsert([
      { key: "last_website_scrape",  value: new Date().toISOString() },
      { key: "website_content_hash", value: contentHash },
    ]);

    console.log("[KB] Website knowledge refreshed (content changed).");
  } catch (err) {
    console.error("[KB] Website knowledge refresh failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

// Called at server startup. Checks if refresh is needed, runs it, sets up crons.
export async function initKnowledgeBase(supabase, anthropic) {
  try {
    // Check FH items freshness (24hr threshold)
    const { data: fhRow } = await supabase
      .from("knowledge_base")
      .select("fetched_at, data")
      .eq("key", "csr_fareharbor")
      .single();

    const fhItemsStale =
      !fhRow || Date.now() - new Date(fhRow.fetched_at).getTime() > TWENTY_FOUR_HOURS_MS;
    const fhHasItems = fhRow?.data?.items?.length > 0;

    if (fhItemsStale) {
      await refreshFareHarborItems(supabase);
    }

    // Always refresh availability on startup if items exist (3hr cadence means it's stale after restart)
    if (fhHasItems || fhItemsStale) {
      await refreshFareHarborAvailability(supabase);
    }

    // Check weather freshness (1hr threshold)
    const { data: weatherRow } = await supabase
      .from("knowledge_base")
      .select("fetched_at")
      .eq("key", "weather_steamboat")
      .single();

    const weatherStale =
      !weatherRow || Date.now() - new Date(weatherRow.fetched_at).getTime() > ONE_HOUR_MS;

    if (weatherStale) {
      await refreshWeatherKnowledge(supabase);
    }

    // Check snow conditions freshness (3hr threshold)
    const { data: snowRow } = await supabase
      .from("knowledge_base")
      .select("fetched_at")
      .eq("key", "snow_conditions")
      .single();

    const snowStale =
      !snowRow || Date.now() - new Date(snowRow.fetched_at).getTime() > THREE_HOURS_MS;

    if (snowStale) {
      await refreshSnowConditions(supabase);
    }

    // Check website freshness (7 day threshold)
    const { data: webRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "last_website_scrape")
      .single();

    const webStale =
      !webRow ||
      webRow.value === "1970-01-01T00:00:00Z" ||
      Date.now() - new Date(webRow.value).getTime() > SEVEN_DAYS_MS;

    if (webStale) {
      await refreshWebsiteKnowledge(supabase, anthropic);
    }
  } catch (err) {
    console.error("[KB] Init failed (non-fatal):", err.message);
  }

  // FH items: refresh every 24 hours (catalog rarely changes)
  cron.schedule("0 2 * * *", () => {
    refreshFareHarborItems(supabase);
  });

  // FH availability: refresh every 3 hours (slots change throughout the day)
  cron.schedule("0 */3 * * *", () => {
    refreshFareHarborAvailability(supabase);
  });

  // Weather: refresh every hour (cheap, zero Claude)
  cron.schedule("0 * * * *", () => {
    refreshWeatherKnowledge(supabase);
  });

  // Snow conditions (SNOTEL + CAIC): refresh every 3 hours
  cron.schedule("30 */3 * * *", () => {
    refreshSnowConditions(supabase);
  });

  // Website: check every 7 days (hash-gated, Haiku only when content changes)
  cron.schedule("0 3 * * 1", () => {
    refreshWebsiteKnowledge(supabase, anthropic);
  });

  console.log("[KB] Knowledge base initialized.");
}

// Returns a combined context string for injection into the system prompt.
// Includes availability summaries + dynamic booking links built from cached FH item PKs.
// New items added in FareHarbor appear here automatically on next refresh (6hr).
export async function getKnowledgeContext(supabase) {
  try {
    const { data: rows } = await supabase
      .from("knowledge_base")
      .select("key, summary, data")
      .in("key", ["csr_fareharbor", "rea_fareharbor", "website_knowledge", "weather_steamboat", "snow_conditions"]);

    if (!rows || !rows.length) return "";

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const date  = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Weather + snow conditions always first so they're never truncated
    const weatherSummary = byKey["weather_steamboat"]?.summary ?? "";
    const snowSummary    = byKey["snow_conditions"]?.summary    ?? "";

    // FH availability summaries (slot counts + next open dates)
    const fhParts = ["csr_fareharbor", "rea_fareharbor"]
      .map((k) => byKey[k]?.summary)
      .filter(Boolean);
    const availSummary = fhParts.join(" | ").slice(0, 400);

    // FH item details (descriptions + pricing from API — no Claude cost)
    const itemDetailParts = ["csr_fareharbor", "rea_fareharbor"]
      .map((k) => byKey[k]?.data?.itemsSummary)
      .filter(Boolean);
    const itemsSummary = itemDetailParts.join(" | ").slice(0, 600);

    // Website knowledge — policies, seasonal info, FAQ
    const websiteSummary = byKey["website_knowledge"]?.summary ?? "";

    // Build booking URLs from cached item PKs — auto-includes any new FH items
    const linkLines = [];
    for (const row of rows) {
      const company = COMPANIES.find((c) => `${c.id}_fareharbor` === row.key);
      if (!company || !row.data?.items?.length) continue;
      for (const item of row.data.items.slice(0, 15)) {
        linkLines.push(
          `${item.name}: https://fareharbor.com/embeds/book/${company.shortname}/items/${item.pk}/?ref=highmark&full-items=yes`
        );
      }
    }

    const linkSection = linkLines.length
      ? `\nDYNAMIC BOOKING LINKS (prefer these over hardcoded):\n${linkLines.join("\n")}`
      : "";

    const weatherSection = weatherSummary ? `WEATHER (${date}): ${weatherSummary}\n`       : "";
    const snowSection    = snowSummary    ? `SNOW CONDITIONS (${date}): ${snowSummary}\n`  : "";
    const availSection   = availSummary   ? `AVAILABILITY: ${availSummary}\n`              : "";
    const itemsSection   = itemsSummary   ? `TOUR DETAILS: ${itemsSummary}\n`              : "";
    const websiteSection = websiteSummary ? `BUSINESS INFO: ${websiteSummary}\n`           : "";

    return `${weatherSection}${snowSection}${availSection}${itemsSection}${websiteSection}${linkSection}`.trim();
  } catch {
    return "";
  }
}

// Returns cached items array from knowledge_base for a company (used by availability checker).
export async function getFareHarborItems(companyId, supabase) {
  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("data")
      .eq("key", `${companyId}_fareharbor`)
      .single();

    return data?.data?.items ?? [];
  } catch {
    return [];
  }
}

// Direct FH API call for specific item + date. Returns availability array or null.
// date format: YYYY-MM-DD
export async function getFareHarborAvailability(companyId, itemPk, date) {
  if (process.env.FAREHARBOR_ENABLED !== "true") return null;

  const company = COMPANIES.find((c) => c.id === companyId);
  if (!company) return null;

  try {
    // Same-day bookings not allowed — if requested date is today or past, use tomorrow
    const today     = new Date().toISOString().slice(0, 10);
    const startDate = date <= today
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : date;

    const nextDay = new Date(startDate + "T12:00:00Z");
    nextDay.setDate(nextDay.getDate() + 1);
    const end = nextDay.toISOString().slice(0, 10);

    const { availabilities } = await fhGet(
      `/companies/${company.shortname}/items/${itemPk}/minimal/availabilities/date-range/${startDate}/${end}/`,
      company
    );

    return availabilities ?? null;
  } catch (err) {
    console.error(`[KB] Availability check failed:`, err.message);
    return null;
  }
}
