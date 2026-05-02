// ─────────────────────────────────────────────────────────────────────────────
// operatorIntentParser.js — Operator Intent + Date Range Detection
// Highmark by Whiteout Solutions
//
// Lightweight, deterministic parsing for operator-mode SMS commands. Covers:
//   detectOperatorIntent(message) → { intent, date_range, metric, raw }
//   parseDateRange(message)       → { start, end, label } | null
//
// All matching is keyword/regex based (no LLM). This runs before Claude in the
// orchestrator so common operator queries are answered without API cost.
// Uses America/Denver timezone for "today"/"tomorrow" boundaries to match the
// rest of operatorBriefing.js.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Denver";

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

// ─────────────────────────────────────────────────────────────────────────────
// TIMEZONE-AWARE LOCAL DAY HELPERS
// We construct ISO timestamps that bound the local (MT) day, regardless of the
// server's local timezone. The trick: format the date in MT, then build a UTC
// ISO from the MT calendar boundaries.
// ─────────────────────────────────────────────────────────────────────────────

function mtParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = fmt.format(date).split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

function startOfDayMT(year, monthIdx, day) {
  return new Date(Date.UTC(year, monthIdx, day, 7, 0, 0, 0)).toISOString();
}

function endOfDayMT(year, monthIdx, day) {
  return new Date(Date.UTC(year, monthIdx, day + 1, 6, 59, 59, 999)).toISOString();
}

function isoDay(year, monthIdx, day, endOfDay = false) {
  const dt = new Date(year, monthIdx, day);
  return endOfDay ? endOfDayMT(dt.getFullYear(), dt.getMonth(), dt.getDate())
                  : startOfDayMT(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function rangeForDay(year, monthIdx, day, label) {
  return {
    start: startOfDayMT(year, monthIdx, day),
    end:   endOfDayMT(year, monthIdx, day),
    label,
  };
}

function rangeForMonth(year, monthIdx, label) {
  const last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  return {
    start: startOfDayMT(year, monthIdx, 1),
    end:   endOfDayMT(year, monthIdx, last),
    label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseDateRange — pull a { start, end, label } window from natural language.
// Returns null when no date phrase is found.
// ─────────────────────────────────────────────────────────────────────────────

export function parseDateRange(message) {
  if (!message || typeof message !== "string") return null;
  const msg = message.toLowerCase().trim();
  const now = new Date();
  const today = mtParts(now);

  // ── today ────────────────────────────────────────────────────────────────
  if (/\btoday\b|\btonight\b/.test(msg)) {
    return rangeForDay(today.year, today.month, today.day, "today");
  }

  // ── tomorrow ─────────────────────────────────────────────────────────────
  if (/\btomorrow\b/.test(msg)) {
    const tom = new Date(today.year, today.month, today.day + 1);
    return rangeForDay(tom.getFullYear(), tom.getMonth(), tom.getDate(), "tomorrow");
  }

  // ── yesterday ────────────────────────────────────────────────────────────
  if (/\byesterday\b/.test(msg)) {
    const y = new Date(today.year, today.month, today.day - 1);
    return rangeForDay(y.getFullYear(), y.getMonth(), y.getDate(), "yesterday");
  }

  // ── this weekend (upcoming Sat–Sun) ──────────────────────────────────────
  if (/\bthis\s+weekend\b|\bweekend\b/.test(msg)) {
    const todayDow = new Date(today.year, today.month, today.day).getDay(); // 0=Sun
    const daysUntilSat = (6 - todayDow + 7) % 7;
    const sat = new Date(today.year, today.month, today.day + daysUntilSat);
    const sun = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() + 1);
    return {
      start: startOfDayMT(sat.getFullYear(), sat.getMonth(), sat.getDate()),
      end:   endOfDayMT(sun.getFullYear(), sun.getMonth(), sun.getDate()),
      label: "this weekend",
    };
  }

  // ── this week (Mon–Sun containing today) ─────────────────────────────────
  if (/\bthis\s+week\b/.test(msg)) {
    const dow = new Date(today.year, today.month, today.day).getDay(); // 0=Sun
    const offsetToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(today.year, today.month, today.day + offsetToMon);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return {
      start: startOfDayMT(mon.getFullYear(), mon.getMonth(), mon.getDate()),
      end:   endOfDayMT(sun.getFullYear(), sun.getMonth(), sun.getDate()),
      label: "this week",
    };
  }

  // ── last week ────────────────────────────────────────────────────────────
  if (/\blast\s+week\b/.test(msg)) {
    const dow = new Date(today.year, today.month, today.day).getDay();
    const offsetToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(today.year, today.month, today.day + offsetToMon - 7);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    return {
      start: startOfDayMT(mon.getFullYear(), mon.getMonth(), mon.getDate()),
      end:   endOfDayMT(sun.getFullYear(), sun.getMonth(), sun.getDate()),
      label: "last week",
    };
  }

  // ── this month ───────────────────────────────────────────────────────────
  if (/\bthis\s+month\b/.test(msg)) {
    return rangeForMonth(today.year, today.month, "this month");
  }

  // ── last month ───────────────────────────────────────────────────────────
  if (/\blast\s+month\b/.test(msg)) {
    const lm = new Date(today.year, today.month - 1, 1);
    return rangeForMonth(lm.getFullYear(), lm.getMonth(),
      lm.toLocaleString("en-US", { month: "long", year: "numeric" }).toLowerCase());
  }

  // ── this year / last year ────────────────────────────────────────────────
  if (/\bthis\s+year\b/.test(msg)) {
    return {
      start: startOfDayMT(today.year, 0, 1),
      end:   endOfDayMT(today.year, 11, 31),
      label: "this year",
    };
  }
  if (/\blast\s+year\b/.test(msg)) {
    return {
      start: startOfDayMT(today.year - 1, 0, 1),
      end:   endOfDayMT(today.year - 1, 11, 31),
      label: "last year",
    };
  }

  // ── month + year (e.g. "Feb 2026", "February 2026") ──────────────────────
  const monthYearMatch = msg.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{4})\b/);
  if (monthYearMatch) {
    const m = MONTHS[monthYearMatch[1]];
    const y = parseInt(monthYearMatch[2], 10);
    const label = `${monthYearMatch[1].slice(0, 3).toUpperCase()}${monthYearMatch[1].slice(3) ? monthYearMatch[1].slice(3, 1) : ""} ${y}`;
    return rangeForMonth(y, m, `${monthYearMatch[1]} ${y}`);
  }

  // ── bare month name (assume current year, or next occurrence if past) ───
  const bareMonthMatch = msg.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/);
  if (bareMonthMatch) {
    const m = MONTHS[bareMonthMatch[1]];
    const year = m < today.month ? today.year + 1 : today.year;
    return rangeForMonth(year, m, `${bareMonthMatch[1]} ${year}`);
  }

  // ── ISO date YYYY-MM-DD ──────────────────────────────────────────────────
  const isoMatch = msg.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, mo, d] = isoMatch.map(Number);
    return rangeForDay(y, mo - 1, d, `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  // ── M/D or M/D/YYYY ──────────────────────────────────────────────────────
  const slashMatch = msg.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const mo = parseInt(slashMatch[1], 10) - 1;
    const d  = parseInt(slashMatch[2], 10);
    let y = slashMatch[3] ? parseInt(slashMatch[3], 10) : today.year;
    if (y < 100) y += 2000;
    if (mo >= 0 && mo <= 11 && d >= 1 && d <= 31) {
      return rangeForDay(y, mo, d, `${mo + 1}/${d}/${y}`);
    }
  }

  // ── "next 7 days" / "last 30 days" ──────────────────────────────────────
  const nextNDays = msg.match(/\bnext\s+(\d{1,3})\s+days?\b/);
  if (nextNDays) {
    const n = parseInt(nextNDays[1], 10);
    const end = new Date(today.year, today.month, today.day + n);
    return {
      start: startOfDayMT(today.year, today.month, today.day),
      end:   endOfDayMT(end.getFullYear(), end.getMonth(), end.getDate()),
      label: `next ${n} days`,
    };
  }
  const lastNDays = msg.match(/\blast\s+(\d{1,3})\s+days?\b/);
  if (lastNDays) {
    const n = parseInt(lastNDays[1], 10);
    const start = new Date(today.year, today.month, today.day - n);
    return {
      start: startOfDayMT(start.getFullYear(), start.getMonth(), start.getDate()),
      end:   endOfDayMT(today.year, today.month, today.day),
      label: `last ${n} days`,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSeasonRange — pull a { start, end, label } window from season language.
// Handles: "winter 2025/2026", "summer 2025", "this winter", "last summer", etc.
// Returns null when no season phrase is found.
//
// Season boundaries are now per-client. Pass `seasonConfig` to override the
// default (e.g. from `client.seasonConfig`). Format:
//   { summer: { start: "MM-DD", end: "MM-DD" },
//     winter: { start: "MM-DD", end: "MM-DD" } }
// Defaults: summer Apr 1 – Oct 31 · winter Dec 1 – Mar 31.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SEASON_CONFIG = {
  summer: { start: "04-01", end: "10-31" },
  winter: { start: "12-01", end: "03-31" },
};

function parseMmDd(mmdd) {
  const [m, d] = String(mmdd).split("-").map(Number);
  return { month: m - 1, day: d };
}

function isPastDate(today, monthIdx, day) {
  return today.month > monthIdx || (today.month === monthIdx && today.day > day);
}

function isAtOrPastDate(today, monthIdx, day) {
  return today.month > monthIdx || (today.month === monthIdx && today.day >= day);
}

export function parseSeasonRange(message, seasonConfig = null) {
  if (!message || typeof message !== "string") return null;
  const msg = message.toLowerCase().trim();
  const now  = new Date();
  const today = mtParts(now);

  const cfg         = seasonConfig ?? DEFAULT_SEASON_CONFIG;
  const summerStart = parseMmDd(cfg.summer?.start ?? DEFAULT_SEASON_CONFIG.summer.start);
  const summerEnd   = parseMmDd(cfg.summer?.end   ?? DEFAULT_SEASON_CONFIG.summer.end);
  const winterStart = parseMmDd(cfg.winter?.start ?? DEFAULT_SEASON_CONFIG.winter.start);
  const winterEnd   = parseMmDd(cfg.winter?.end   ?? DEFAULT_SEASON_CONFIG.winter.end);

  const winterRange = (startYear) => ({
    start: startOfDayMT(startYear, winterStart.month, winterStart.day),
    end:   endOfDayMT(startYear + 1, winterEnd.month, winterEnd.day),
    label: `winter ${startYear}/${startYear + 1}`,
  });

  const summerRange = (year) => ({
    start: startOfDayMT(year, summerStart.month, summerStart.day),
    end:   endOfDayMT(year, summerEnd.month, summerEnd.day),
    label: `summer ${year}`,
  });

  // Boundary helpers tied to the configured ranges
  const isPastSummerEnd  = isPastDate(today, summerEnd.month, summerEnd.day);
  const isAtOrPastWinterStart = isAtOrPastDate(today, winterStart.month, winterStart.day);
  const isPastWinterEnd  = isPastDate(today, winterEnd.month, winterEnd.day);

  // ── "winter 2025/2026" or "winter 2025-2026" ─────────────────────────────
  const winterSlash = msg.match(/\bwinter\s+(\d{4})\s*[\/\-]\s*\d{2,4}\b/);
  if (winterSlash) return winterRange(parseInt(winterSlash[1], 10));

  // ── "this winter" ─────────────────────────────────────────────────────────
  if (/\bthis\s+winter\b/.test(msg)) {
    let sy;
    if (isAtOrPastWinterStart) sy = today.year;          // Already in winter (started this year)
    else if (!isPastWinterEnd) sy = today.year - 1;      // Still in winter that started last year
    else                        sy = today.year;          // Between winters → upcoming
    return winterRange(sy);
  }

  // ── "last winter" ─────────────────────────────────────────────────────────
  if (/\blast\s+winter\b/.test(msg)) {
    let sy;
    if (isAtOrPastWinterStart) sy = today.year - 1;      // In current winter → last started prev year
    else if (!isPastWinterEnd) sy = today.year - 2;      // Continuing last year's winter → last = one before
    else                        sy = today.year - 1;      // Past winter end → most recent completed
    return winterRange(sy);
  }

  // ── "winter 2025" (bare year — ski-industry convention: year = end year) ──
  const winterYear = msg.match(/\bwinter\s+(\d{4})\b/);
  if (winterYear) return winterRange(parseInt(winterYear[1], 10) - 1);

  // ── bare "winter" (no year/this/last) → most recent winter ───────────────
  if (/\bwinter\b/.test(msg) && !/\b(this|last|next)\b/.test(msg)) {
    return winterRange(today.year - 1);
  }

  // ── "this summer" ─────────────────────────────────────────────────────────
  if (/\bthis\s+summer\b/.test(msg)) {
    return summerRange(isPastSummerEnd ? today.year + 1 : today.year);
  }

  // ── "last summer" ─────────────────────────────────────────────────────────
  if (/\blast\s+summer\b/.test(msg)) {
    return summerRange(isPastSummerEnd ? today.year : today.year - 1);
  }

  // ── "summer 2025" ─────────────────────────────────────────────────────────
  const summerYear = msg.match(/\bsummer\s+(\d{4})\b/);
  if (summerYear) return summerRange(parseInt(summerYear[1], 10));

  // ── bare "summer" ─────────────────────────────────────────────────────────
  if (/\bsummer\b/.test(msg) && !/\b(this|last|next)\b/.test(msg)) {
    return summerRange(isPastSummerEnd ? today.year : today.year - 1);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// detectOperatorIntent — classify an operator SMS into a structured intent.
// Returns { intent, date_range, metric, raw } where intent is one of:
//   bookings_by_date    — needs date_range
//   leads               — open/hot leads
//   new_leads           — recent (24h) leads
//   missed_leads        — stale leads
//   weather             — conditions snapshot
//   revenue             — revenue estimate
//   daily_summary       — bookings today + tomorrow + new leads + status
//   performance         — 30-day analysis
//   campaigns           — campaign stats
//   flag_issue          — operator wants to log a problem
//   help                — list of commands
//   unknown             — no match
// ─────────────────────────────────────────────────────────────────────────────

export function detectOperatorIntent(message, seasonConfig = null) {
  const raw = (message ?? "").trim();
  const msg = raw.toLowerCase();
  const ps  = (m) => parseSeasonRange(m, seasonConfig); // shorthand

  if (!msg) return { intent: "unknown", date_range: null, metric: null, raw };

  // help
  if (/^(help|commands|what can you do|menu|\?)$/.test(msg)) {
    return { intent: "help", date_range: null, metric: null, raw };
  }

  // flag issue — "flag X", "log issue", "report problem", "something's broken"
  if (
    /^flag\b/.test(msg) ||
    /\bflag\s+(an?\s+)?(issue|problem|bug)\b/.test(msg) ||
    /\b(log|report)\s+(an?\s+)?(issue|problem|bug)\b/.test(msg) ||
    /\bsomething(?:'s|\s+is)?\s+(broken|wrong|off)\b/.test(msg)
  ) {
    return { intent: "flag_issue", date_range: null, metric: null, raw };
  }

  // daily summary
  if (
    /\bdaily\s+(summary|recap|brief)\b/.test(msg) ||
    /\bsummary\s+(for\s+)?today\b/.test(msg) ||
    /^summary$/.test(msg) ||
    /\btoday'?s?\s+summary\b/.test(msg) ||
    /\bdaily\s+brief(ing)?\b/.test(msg)
  ) {
    return { intent: "daily_summary", date_range: null, metric: null, raw };
  }

  // performance / analytics
  if (
    /\b(performance|analytics|how\s+are\s+we\s+doing|conversion\s+rate)\b/.test(msg) ||
    /\bhow'?s\s+business\b/.test(msg)
  ) {
    return { intent: "performance", date_range: null, metric: null, raw };
  }

  // campaigns
  if (/\bcampaigns?\b/.test(msg) && !/\bsend\b/.test(msg)) {
    return { intent: "campaigns", date_range: null, metric: null, raw };
  }

  // missed leads — must check before generic leads
  if (/\bmissed\s+leads?\b|\bstale\s+leads?\b|\bcold\s+leads?\b/.test(msg)) {
    return { intent: "missed_leads", date_range: null, metric: null, raw };
  }

  // new / recent leads
  if (/\bnew\s+leads?\b|\brecent\s+leads?\b/.test(msg)) {
    return { intent: "new_leads", date_range: null, metric: null, raw };
  }

  // report — season-aware, grouped aggregation (before bookings to intercept seasonal queries)
  // Triggered by: season language, grouping qualifiers ("by activity"), aggregation phrases.
  // Guard: skip when message is clearly about weather, not data.
  {
    const isWeatherQuery = /^weather$|\bweather\b|\bconditions?\b|^snow$|\bforecast\b/.test(msg);
    if (!isWeatherQuery) {
      const seasonRange  = ps(msg);
      const hasGrouping  = /\bby\s+(activity|activities|product|item|service)\b/.test(msg);
      const hasByCompany = /\bby\s+company\b/.test(msg);
      const isItemQuery  = /\bitems?\s+sold\b|\btop\s+(products?|activities?|items?)\b/.test(msg);
      const hasByRevenue = /\brevenue\s+by\s+(product|activity|item|company)\b/.test(msg);

      // Report requires an explicit grouping/aggregation qualifier — season alone is not enough.
      // Bare season queries ("bookings this winter", "total pax this winter") go to bookings_by_date.
      if (hasGrouping || hasByCompany || isItemQuery || hasByRevenue) {
        const dateRange = seasonRange ?? parseDateRange(msg) ?? parseDateRange("this month");

        let groupBy = "activity";
        if (hasByCompany) groupBy = "company";

        let metric = "bookings";
        if (/\brevenue\b/.test(msg))                    metric = "revenue";
        else if (/\bunits?\b|\bitems?\s+sold\b/.test(msg)) metric = "units";
        else if (/\bpax\b/.test(msg))                   metric = "pax";

        return { intent: "report", date_range: dateRange, metric, group_by: groupBy, raw };
      }
    }
  }

  // Company-specific follow-up: "just for rabbitearsadventures", "REA only", "filter to CSR", etc.
  // Catches refinement messages that have no other intent keywords.
  const companyFilter = extractCompanyFilter(msg);
  if (companyFilter) {
    const range  = ps(msg) ?? parseDateRange(msg) ?? ps("this winter");
    const metric = /\brevenue\b|\brev\b|\bearnings?\b/.test(msg) ? "revenue"
                 : /\bpax\b|\bguests?\b/.test(msg)             ? "pax"
                 : "bookings";
    return { intent: "bookings_by_date", date_range: range, metric, company_filter: companyFilter, raw };
  }

  // pax / guest count — "total pax this winter", "guided guests CSR", "how many guests did we have"
  // Must come BEFORE bookings to capture pax-specific intent with metric tag.
  if (
    /\b(total\s+)?pax\b/.test(msg) ||
    /\bguided\s+guests?\b/.test(msg) ||
    /\bhow\s+many\s+(guided\s+|total\s+)?guests?\b/.test(msg) ||
    /\btotal\s+guests?\b/.test(msg) ||
    /\bguest\s+count\b/.test(msg)
  ) {
    const range = ps(msg) ?? parseDateRange(msg);
    return {
      intent:     "bookings_by_date",
      date_range: range ?? parseDateRange("this month"),
      metric:     "pax",
      raw,
    };
  }

  // "how many bookings/tours/trips did we have [period]"
  if (/\bhow\s+many\s+(bookings?|tours?|trips?|reservations?|rentals?)\b/.test(msg)) {
    const range = ps(msg) ?? parseDateRange(msg);
    return {
      intent:     "bookings_by_date",
      date_range: range ?? parseDateRange("this month"),
      metric:     "bookings",
      raw,
    };
  }

  // revenue / earnings — with date range → route to full DB aggregation;
  // bare revenue → "revenue" intent, caught by early check in operatorBriefing
  if (/\brevenue\b|\brev\b|\bearnings?\b|\bsales\b/.test(msg)) {
    const range = ps(msg) ?? parseDateRange(msg);
    if (range) {
      return { intent: "bookings_by_date", date_range: range, metric: "revenue", raw };
    }
    return { intent: "revenue", date_range: null, metric: "revenue", raw };
  }

  // bookings (with optional date range — includes season language)
  if (/\bbookings?\b|\breservations?\b|\bappointments?\b/.test(msg)) {
    const range = ps(msg) ?? parseDateRange(msg);
    if (range) {
      return { intent: "bookings_by_date", date_range: range, metric: "bookings", raw };
    }
    // bare "bookings" with no date → default to today
    return {
      intent:     "bookings_by_date",
      date_range: parseDateRange("today"),
      metric:     "bookings",
      raw,
    };
  }

  // weather / conditions (use \bweather\b so "winter weather" is caught, not just bare "weather")
  if (/\bweather\b|\bconditions?\b|^snow$|\bforecast\b/.test(msg)) {
    return { intent: "weather", date_range: null, metric: null, raw };
  }

  // generic leads — last to avoid swallowing "missed/new" leads
  if (/^leads?$|\bmy\s+leads?\b|^show\s+(me\s+)?leads?$|\bhot\s+leads?\b/.test(msg)) {
    return { intent: "leads", date_range: null, metric: null, raw };
  }

  // Season range with no other keyword match → treat as a booking summary request
  // e.g. "winter 2025/2026" alone, "this summer" alone
  const seasonOnly = ps(msg);
  if (seasonOnly) {
    return { intent: "bookings_by_date", date_range: seasonOnly, metric: "bookings", raw };
  }

  return { intent: "unknown", date_range: null, metric: null, raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractCompanyFilter — pull a company name from refinement messages like
// "just for rabbitearsadventures", "REA only", "filter to CSR", "for rabbit ears"
// Returns the raw extracted string (caller normalizes against client config).
// Returns null when no company-filter pattern is found.
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_WORDS = new Set(["me", "us", "them", "it", "this", "that", "all", "now", "you", "we"]);

function cleanCompanyExtract(raw) {
  return raw
    .replace(/^(?:show\s+(?:me\s+)?|tell\s+me\s+|give\s+me\s+)/, "")
    .replace(/\b(rev|revenue|earnings?|sales|bookings?|pax|guests?)\s*$/, "")
    .replace(/\b(this|last)\s+(winter|summer|month|week|year)\s*$/, "")
    .replace(/\bin\s+\w+\s*\d{4}\s*$/, "")
    .trim();
}

export function extractCompanyFilter(msg) {
  if (!msg || typeof msg !== "string") return null;
  const lower = msg.toLowerCase().trim();

  const patterns = [
    /^just\s+for\s+(.+)$/,
    /^only\s+for\s+(.+)$/,
    /^for\s+(.+?)\s+only$/,
    /^filter\s+(?:by|to)\s+(.+)$/,
    /^show\s+(?:me\s+)?(?:just\s+)?(.+?)\s+only$/,
    /^(.+?)\s+only$/,
    /^(?:just\s+)?(.+?)\s+data$/,
  ];

  for (const p of patterns) {
    const m = lower.match(p);
    if (m) {
      const company = cleanCompanyExtract(m[1].trim().replace(/['"]/g, ""));
      if (company.length >= 2 && !SKIP_WORDS.has(company)) {
        return company;
      }
    }
  }

  // Contextual fallback: "COMPANY METRIC [DATE]" — company text precedes a metric keyword.
  // E.g. "rabbit ears adventure rev in winter 2025/2026" → "rabbit ears adventure"
  const METRIC_PAT = /\b(rev|revenue|earnings?|sales|pax|bookings?|tours?|trips?)\b/;
  const FILLER_STARTS = new Set([
    "let", "can", "what", "how", "when", "where", "show", "tell", "give", "get",
    "find", "total", "all", "the", "our", "my", "your", "any", "some",
  ]);
  const mMetric = lower.match(METRIC_PAT);
  if (mMetric) {
    const cutoff = lower.indexOf(mMetric[0]);
    if (cutoff >= 3) {
      const candidate = cleanCompanyExtract(lower.slice(0, cutoff).trim().replace(/['"]/g, ""));
      const firstWord = candidate.split(/\s+/)[0];
      if (candidate.length >= 2 && !SKIP_WORDS.has(candidate) && !FILLER_STARTS.has(firstWord)) {
        return candidate;
      }
    }
  }

  return null;
}
