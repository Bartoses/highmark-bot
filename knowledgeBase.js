// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE — FareHarbor refresh + website scraper
// Keeps Summit's knowledge fresh. Runs on startup and on cron schedule.
// All functions fail gracefully — never crash the server.
// ─────────────────────────────────────────────────────────────────────────────
import fetch from "node-fetch";
import { parse as parseHtml } from "node-html-parser";
import cron from "node-cron";

const FAREHARBOR_BASE  = "https://fareharbor.com/api/external/v1";
const OPENWEATHER_BASE = "https://api.openweathermap.org/data/2.5";
const SIX_HOURS_MS     = 6 * 60 * 60 * 1000;
const ONE_HOUR_MS      = 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

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
// REFRESH FAREHARBOR KNOWLEDGE
// Fetches items + 14-day availability per company, summarizes with Claude.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshFareHarborKnowledge(supabase, anthropic) {
  if (process.env.FAREHARBOR_ENABLED !== "true") return;

  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end   = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  for (const company of COMPANIES) {
    try {
      // 1. Fetch items
      const { items } = await fhGet(`/companies/${company.shortname}/items/`, company);

      // 2. Fetch availability for each item (cap at 10 items to avoid rate limiting)
      const availabilityData = {};
      for (const item of items.slice(0, 10)) {
        try {
          const { availabilities } = await fhGet(
            `/companies/${company.shortname}/items/${item.pk}/minimal/availabilities/date-range/${start}/${end}/`,
            company
          );
          const openSlots = availabilities.filter(
            (a) => a.capacity > 0 || a.is_available === true
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

      // 3. Summarize with Claude
      const summaryPrompt = `Summarize this FareHarbor availability data for an SMS bot in max 250 chars.
Which tours have slots this week? Any sold out? Be specific about dates if notable.
Company: ${company.name}
Data: ${JSON.stringify(availabilityData)}`;

      const claudeRes = await anthropic.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 150,
        messages:   [{ role: "user", content: summaryPrompt }],
      });
      const summary = claudeRes.content[0].text.slice(0, 250);

      // 4. Upsert into knowledge_base
      await supabase.from("knowledge_base").upsert({
        client_id:      "csr_rea",
        type:           "fareharbor",
        key:            `${company.id}_fareharbor`,
        data:           { items, availabilityData },
        summary,
        fetched_at:     new Date().toISOString(),
        next_refresh_at: new Date(Date.now() + SIX_HOURS_MS).toISOString(),
      });

      console.log(`[KB] FareHarbor refreshed: ${company.name}`);
    } catch (err) {
      console.error(`[KB] FareHarbor refresh failed for ${company.name}:`, err.message);
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
    const [currentRes, forecastRes, passRes] = await Promise.all([
      fetch(`${OPENWEATHER_BASE}/weather?q=Steamboat+Springs,CO,US&appid=${apiKey}&units=imperial`),
      fetch(`${OPENWEATHER_BASE}/forecast?q=Steamboat+Springs,CO,US&appid=${apiKey}&units=imperial&cnt=24`),
      // Rabbit Ears Pass (9,426 ft) — where tours actually run
      fetch(`${OPENWEATHER_BASE}/weather?lat=40.38&lon=-106.60&appid=${apiKey}&units=imperial`),
    ]);

    if (!currentRes.ok) throw new Error(`Weather API ${currentRes.status}`);

    const [current, forecastData, pass] = await Promise.all([
      currentRes.json(),
      forecastRes.json(),
      passRes.ok ? passRes.json() : null,
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
      forecast: days,
      updated_at: new Date().toISOString(),
    };

    // Build compact summary for system prompt injection
    const passNote = data.rabbit_ears_pass
      ? ` | Rabbit Ears Pass: ${data.rabbit_ears_pass.temp}°F, ${data.rabbit_ears_pass.desc}`
      : "";

    const dayLines = Object.entries(days).slice(0, 3).map(([date, d]) => {
      const label = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      const snowNote = d.snow > 0 ? ` +${d.snow.toFixed(1)}"` : "";
      return `${label}: ${d.low}-${d.high}°F ${d.desc}${snowNote}`;
    });

    const summary = `Steamboat: ${data.steamboat.temp}°F, ${data.steamboat.desc}, wind ${data.steamboat.wind_mph}mph${passNote}. Forecast: ${dayLines.join(" | ")}`.slice(0, 350);

    await supabase.from("knowledge_base").upsert({
      client_id:       "csr_rea",
      type:            "weather",
      key:             "weather_steamboat",
      data,
      summary,
      fetched_at:      new Date().toISOString(),
      next_refresh_at: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
    });

    console.log(`[KB] Weather refreshed: ${summary.slice(0, 100)}…`);
  } catch (err) {
    console.error("[KB] Weather refresh failed (non-fatal):", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH WEBSITE KNOWLEDGE
// Scrapes client pages, extracts business info, summarizes with Claude.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshWebsiteKnowledge(supabase, anthropic) {
  const pageTexts = [];

  for (const url of SCRAPE_URLS) {
    try {
      const res  = await fetch(url, { timeout: 10000 });
      const html = await res.text();
      const root = parseHtml(html);

      // Strip nav, footer, scripts, styles
      root
        .querySelectorAll("script, style, nav, footer, header, [aria-hidden]")
        .forEach((el) => el.remove());

      const text = root.text.replace(/\s+/g, " ").trim().slice(0, 2000);
      pageTexts.push(`--- ${url} ---\n${text}`);
    } catch (err) {
      console.error(`[KB] Scrape failed for ${url}:`, err.message);
    }
  }

  if (!pageTexts.length) {
    console.warn("[KB] Website scrape returned no pages — keeping stale data.");
    return;
  }

  try {
    const combined = pageTexts.join("\n\n").slice(0, 10000);

    const extractRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1200,
      messages:   [
        {
          role:    "user",
          content: `Extract business info from this website content and return JSON only:
{ "offerings": string, "pricing": string, "policies": string, "seasonal_notes": string, "hours": string, "faq": string[] }
Be concise but complete — this feeds an SMS bot. Max 150 chars per string field, max 8 FAQ items.
Include summer/winter offerings, RZR tours, prices, cancellation policy, age/weight limits.
Content: ${combined}`,
        },
      ],
    });

    let data = {};
    try {
      const raw = extractRes.content[0].text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      data = { raw: extractRes.content[0].text.slice(0, 500) };
    }

    const summaryRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 400,
      messages:   [
        {
          role:    "user",
          content: `Summarize this business data for an SMS bot in max 700 plain-text chars. Cover: what they offer (winter + summer), pricing, key policies (age/weight limits, cancellation), hours. No bullet points — write continuous plain text: ${JSON.stringify(data)}`,
        },
      ],
    });
    const summary = summaryRes.content[0].text.slice(0, 700);

    await supabase.from("knowledge_base").upsert({
      client_id:      "csr_rea",
      type:           "website",
      key:            "website_knowledge",
      data,
      summary,
      fetched_at:     new Date().toISOString(),
      next_refresh_at: new Date(Date.now() + FOURTEEN_DAYS_MS).toISOString(),
    });

    await supabase
      .from("settings")
      .upsert({ key: "last_website_scrape", value: new Date().toISOString() });

    console.log("[KB] Website knowledge refreshed.");
  } catch (err) {
    console.error("[KB] Website knowledge summarization failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

// Called at server startup. Checks if refresh is needed, runs it, sets up crons.
export async function initKnowledgeBase(supabase, anthropic) {
  try {
    // Check FH freshness
    const { data: fhRow } = await supabase
      .from("knowledge_base")
      .select("fetched_at")
      .eq("key", "csr_fareharbor")
      .single();

    const fhStale =
      !fhRow || Date.now() - new Date(fhRow.fetched_at).getTime() > SIX_HOURS_MS;

    if (fhStale) {
      await refreshFareHarborKnowledge(supabase, anthropic);
    }

    // Check weather freshness (refresh if >1hr old)
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

    // Check website freshness
    const { data: webRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "last_website_scrape")
      .single();

    const webStale =
      !webRow ||
      webRow.value === "1970-01-01T00:00:00Z" ||
      Date.now() - new Date(webRow.value).getTime() > FOURTEEN_DAYS_MS;

    if (webStale) {
      await refreshWebsiteKnowledge(supabase, anthropic);
    }
  } catch (err) {
    console.error("[KB] Init failed (non-fatal):", err.message);
  }

  // Schedule FH refresh every 6 hours
  cron.schedule("0 */6 * * *", () => {
    refreshFareHarborKnowledge(supabase, anthropic);
  });

  // Schedule weather refresh every hour
  cron.schedule("0 * * * *", () => {
    refreshWeatherKnowledge(supabase);
  });

  // Schedule website scrape every 14 days
  cron.schedule("0 0 */14 * *", () => {
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
      .in("key", ["csr_fareharbor", "rea_fareharbor", "website_knowledge", "weather_steamboat"]);

    if (!rows || !rows.length) return "";

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const date  = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Weather is always included first so it never gets truncated out
    const weatherSummary = byKey["weather_steamboat"]?.summary ?? "";

    // FH availability summaries (capped tightly — just slot status)
    const fhParts = ["csr_fareharbor", "rea_fareharbor"]
      .map((k) => byKey[k]?.summary)
      .filter(Boolean);
    const availSummary = fhParts.join(" | ").slice(0, 350);

    // Website knowledge — larger budget since it covers pricing, policies, seasonal info
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

    const weatherSection  = weatherSummary  ? `WEATHER (${date}): ${weatherSummary}\n`  : "";
    const availSection    = availSummary    ? `AVAILABILITY: ${availSummary}\n`          : "";
    const websiteSection  = websiteSummary  ? `BUSINESS INFO: ${websiteSummary}\n`       : "";

    return `${weatherSection}${availSection}${websiteSection}${linkSection}`.trim();
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
    const nextDay = new Date(date + "T12:00:00Z");
    nextDay.setDate(nextDay.getDate() + 1);
    const end = nextDay.toISOString().slice(0, 10);

    const { availabilities } = await fhGet(
      `/companies/${company.shortname}/items/${itemPk}/minimal/availabilities/date-range/${date}/${end}/`,
      company
    );

    return availabilities ?? null;
  } catch (err) {
    console.error(`[KB] Availability check failed:`, err.message);
    return null;
  }
}
