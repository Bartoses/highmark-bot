// ─────────────────────────────────────────────────────────────────────────────
// operatorBriefing.js — Operator Mode: Morning Briefing + SMS Command Handling
// Highmark by Whiteout Solutions — Sprint 4A / 2B
//
// Exports:
//   generateDailyBriefing(client, supabase, twilioClient, crmSupabase) → send daily briefing (dedup + issues)
//   sendOperatorBriefing(client, supabase, twilioClient)     → legacy send (no dedup)
//   detectOperationalIssues(client, supabase, crmSupabase)   → string[] of flagged issues
//   detectAndHandleOperatorCommand(msg, client, supabase)    → command string | null
//   buildOperatorApiData(clientId, supabase)                 → { bookings, hot_leads, weather, kb_synced_at }
// ─────────────────────────────────────────────────────────────────────────────

import { getAllClients } from "./clients.js";
import {
  detectOperatorIntent,
  parseDateRange,
  parseSeasonRange,
  mergeOperatorContext,
  extractOperatorContext,
} from "./operatorIntentParser.js";
import { executeAction, buildIntegrations } from "./actionEngine.js";
import { humanizeWorkType } from "./mpwrWorkOrders.js";

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS — KB data accessors
// ─────────────────────────────────────────────────────────────────────────────

async function getFhDataForClient(clientId, supabase) {
  try {
    const { data: rows } = await supabase
      .from("knowledge_base")
      .select("data, fetched_at, key")
      .eq("client_id", clientId)
      .eq("type", "fareharbor");

    return rows ?? [];
  } catch {
    return [];
  }
}

async function getWeatherData(supabase) {
  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("data, fetched_at")
      .eq("key", "weather_steamboat")
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

async function getSnowData(supabase) {
  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("data, fetched_at")
      .eq("key", "snow_conditions")
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODAY/TOMORROW AVAILABILITY FROM KB
// The FH KB cache stores next_open (ISO string) per item. We approximate
// "today's available slots" as items whose next_open falls on today's date.
// ─────────────────────────────────────────────────────────────────────────────

function todayMT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD
}

function tomorrowMT() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

function slotsForDate(fhRows, targetDate) {
  const results = [];
  for (const row of fhRows) {
    const items            = row.data?.items            ?? [];
    const availabilityData = row.data?.availabilityData ?? {};
    for (const item of items) {
      const avail = availabilityData[item.name];
      if (!avail?.next_open) continue;
      const slotDate = avail.next_open.slice(0, 10); // YYYY-MM-DD
      if (slotDate === targetDate) {
        const timeStr = new Date(avail.next_open).toLocaleTimeString("en-US", {
          timeZone: "America/Denver",
          hour: "numeric",
          minute: "2-digit",
        });
        results.push({
          time:     timeStr,
          name:     item.name,
          capacity: item.capacity ?? null,
          pk:       item.pk,
          next_open: avail.next_open,
        });
      }
    }
  }
  results.sort((a, b) => new Date(a.next_open) - new Date(b.next_open));
  return results;
}

export async function getTodaysAvailability(clientId, supabase) {
  const rows = await getFhDataForClient(clientId, supabase);
  return slotsForDate(rows, todayMT());
}

export async function getTomorrowsAvailability(clientId, supabase) {
  const rows = await getFhDataForClient(clientId, supabase);
  return slotsForDate(rows, tomorrowMT());
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL TODAY MANIFEST (DB2 daily_manifest)
// Used by the owner briefing instead of FH availability slots — operators want
// "what's actually on the books today," not "what slots are still open."
// Returns rows shaped like { start_at, activity, customer_name, customer_count,
// total_cents } sorted by start_at.
// ─────────────────────────────────────────────────────────────────────────────
// Standard select shape for daily_manifest. The view exposes pax (not
// customer_count), receipt_total_cents (not total_cents), phone (not
// normalized_phone), and does NOT expose end_at (we parse arrival_display
// when end-time logic is needed).
const MANIFEST_SELECT =
  "fareharbor_pk, customer_name, activity, start_at, arrival_display, pax, " +
  "receipt_total_cents, balance_due_cents, waiver_signed, checked_in, " +
  "location, phone, category, affiliate";

// Normalize a daily_manifest row into the internal shape the briefing
// code expects (customer_count, total_cents). Mutates by returning a new
// object so callers don't have to know about the column-name remap.
function normalizeManifestRow(r) {
  if (!r) return r;
  return {
    ...r,
    customer_count: r.pax,
    total_cents:    r.receipt_total_cents,
    normalized_phone: r.phone,
    end_at:         parseEndAtFromArrival(r.arrival_display, r.start_at),
  };
}

// Parse the end-time from arrival_display when end_at isn't on the view.
// Returns a NAIVE timestamp string ("YYYY-MM-DD HH:MM:SS" in MT wall clock)
// so downstream comparisons / formatting don't apply host-TZ shifts.
// Examples handled:
//   "1:00PM - 5:00PM on Aug 14, 2026"
//   "9:00 AM - 5:00 PM on June 12, 2026"
//   "9:00 AM on July 03 to 5:00 PM on July 05, 2026"
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
                 january:1, february:2, march:3, april:4, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
function parseMonthDayYear(str) {
  const m = String(str ?? "").trim().match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return {
    month: mon,
    day:   parseInt(m[2], 10),
    year:  m[3] ? parseInt(m[3], 10) : new Date().getFullYear(),
  };
}
function parseAmPm(str) {
  const m = String(str ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return { h, m: min };
}
function joinNaive(date, time) {
  const yyyy = String(date.year).padStart(4, "0");
  const mm   = String(date.month).padStart(2, "0");
  const dd   = String(date.day).padStart(2, "0");
  const hh   = String(time.h).padStart(2, "0");
  const min  = String(time.m).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

export function parseEndAtFromArrival(display, startAtFallback) {
  if (!display) return null;
  try {
    const s = String(display);
    // Multi-day: "...on July 03 to 5:00 PM on July 05, 2026"
    const mDay = s.match(/on\s+([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?)\s+to\s+(\d{1,2}:\d{2}\s*[AP]M)\s+on\s+([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (mDay) {
      const date = parseMonthDayYear(mDay[3]);
      const time = parseAmPm(mDay[2]);
      if (date && time) return joinNaive(date, time);
    }
    // Single-day: "1:00 PM - 5:00 PM on June 12, 2026"
    const mSame = s.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s+on\s+([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i);
    if (mSame) {
      const date = parseMonthDayYear(mSame[3]);
      const time = parseAmPm(mSame[2]);
      if (date && time) return joinNaive(date, time);
    }
    return null;
  } catch { return null; }
}

export async function getTodaysManifest(clientId, crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const startMT = new Date();
    startMT.setHours(0, 0, 0, 0);
    const endMT = new Date(startMT);
    endMT.setDate(endMT.getDate() + 1);
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select(MANIFEST_SELECT)
      .gte("start_at", startMT.toISOString())
      .lt("start_at", endMT.toISOString())
      .order("start_at", { ascending: true });
    const normalized = (data ?? []).map(normalizeManifestRow);
    return await enrichManifestRows(normalized, crmSupabase);
  } catch {
    return [];
  }
}

// Enrich manifest rows with MPWR-only fields (location, product_title, vehicle)
// from the bookings table. The daily_manifest view exposes `location` via the
// activities join, which is too coarse for MPWR products (Rabbit Ears vs
// Steamboat both join to "steamboat"). When bookings.location is populated
// (MPWR sync writes it), it overrides the view's location and adds vehicle.
// Returns the same rows shape, with extra fields when enrichment data exists.
async function enrichManifestRows(rows, crmSupabase) {
  if (!Array.isArray(rows) || rows.length === 0 || !crmSupabase) return rows;
  const pks = rows.map(r => r?.fareharbor_pk).filter(Boolean);
  if (!pks.length) return rows;
  try {
    const { data: extras } = await crmSupabase
      .from("bookings")
      .select("fareharbor_pk, location, product_title, vehicle")
      .in("fareharbor_pk", pks);
    if (!extras?.length) return rows;
    const byPk = new Map(extras.map(e => [e.fareharbor_pk, e]));
    return rows.map(r => {
      const e = byPk.get(r?.fareharbor_pk);
      if (!e) return r;
      return {
        ...r,
        location:      e.location      ?? r.location,
        product_title: e.product_title ?? null,
        vehicle:       e.vehicle       ?? null,
      };
    });
  } catch {
    return rows;
  }
}

// Current-season revenue from DB2 daily_manifest (or estimate fallback).
// Season window:
//   summer:   May 1  → Oct 31
//   winter:   Nov 1  → Apr 30 of next year (Nov-Mar = current winter; Apr = same window)
// Returns { bookings, revenue_cents, period_label, season, source } where
// `source` is "manifest" (DB2) or "estimate" (DB1 fallback).
export async function getSeasonRevenue(client, crmSupabase, supabase, season = null) {
  const now      = new Date();
  const year     = now.getFullYear();
  const month    = now.getMonth() + 1; // 1-12
  const detected = season ?? (month >= 5 && month <= 10 ? "summer" : "winter");

  let startISO, endISO, label;
  if (detected === "summer") {
    startISO = new Date(year, 4, 1).toISOString();      // May 1
    endISO   = new Date(year, 10, 1).toISOString();     // Nov 1 (exclusive)
    label    = `Summer ${year}`;
  } else {
    // Winter spans Nov of prior year through Apr of current
    const startYear = month >= 11 ? year : year - 1;
    startISO = new Date(startYear, 10, 1).toISOString();      // Nov 1
    endISO   = new Date(startYear + 1, 4, 1).toISOString();   // May 1 (exclusive)
    label    = `Winter ${startYear}/${(startYear + 1).toString().slice(-2)}`;
  }

  // Prefer DB2 daily_manifest
  if (crmSupabase) {
    try {
      const { data } = await crmSupabase
        .from("daily_manifest")
        .select("fareharbor_pk, receipt_total_cents, total")
        .gte("start_at", startISO)
        .lt("start_at", endISO);
      if (data?.length) {
        const seenPks = new Set();
        let totalCents = 0;
        for (const r of data) {
          if (r.fareharbor_pk != null) seenPks.add(r.fareharbor_pk);
          if (r.receipt_total_cents != null) totalCents += Number(r.receipt_total_cents) || 0;
          else if (r.total != null) totalCents += (Number(r.total) || 0) * 100;
        }
        return {
          bookings:      seenPks.size || data.length,
          revenue_cents: totalCents,
          period_label:  label,
          season:        detected,
          source:        "manifest",
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: estimate from DB1 leads
  try {
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("client_id", client.id)
      .in("status", ["converted", "engaged"])
      .gte("created_at", startISO)
      .lt("created_at", endISO);
    const count = data?.length ?? 0;
    return {
      bookings:      count,
      revenue_cents: count * 17500, // $175 avg
      period_label:  label,
      season:        detected,
      source:        "estimate",
    };
  } catch {
    return { bookings: 0, revenue_cents: 0, period_label: label, season: detected, source: "estimate" };
  }
}

// New bookings created in the last N hours — counts ONLY real bookings,
// excluding BOT- placeholder PKs that get re-inserted by the MPWR sync.
// Tries DB2 bookings.created_at (covers MPWR + FH writes). Falls back to DB1
// confirmations_sent on error. Returns { last_24h, last_7d, source } counts.
export async function getNewBookingsStats(crmSupabase, supabase) {
  const now    = Date.now();
  const since24 = new Date(now -  24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Try DB2 bookings table — filter out BOT-* placeholders (sync artifacts).
  if (crmSupabase) {
    try {
      const [r24, r7] = await Promise.all([
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", since24).not("fareharbor_pk", "ilike", "BOT-%"),
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", since7d).not("fareharbor_pk", "ilike", "BOT-%"),
      ]);
      if (!r24.error && !r7.error) {
        return {
          last_24h: r24.count ?? 0,
          last_7d:  r7.count  ?? 0,
          source:   "db2",
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: DB1 confirmations_sent (FH webhook only — undercounts MPWR)
  if (supabase) {
    try {
      const [c24, c7] = await Promise.all([
        supabase.from("confirmations_sent").select("id", { count: "exact", head: true }).gte("confirmation_sent_at", since24),
        supabase.from("confirmations_sent").select("id", { count: "exact", head: true }).gte("confirmation_sent_at", since7d),
      ]);
      if (!c24.error && !c7.error) {
        return {
          last_24h: c24.count ?? 0,
          last_7d:  c7.count  ?? 0,
          source:   "db1_confirmations",
        };
      }
    } catch { /* ignore */ }
  }

  return { last_24h: 0, last_7d: 0, source: "unavailable" };
}

async function getCustomWeatherData(clientId, supabase) {
  try {
    const { data } = await supabase
      .from("knowledge_base")
      .select("data, fetched_at")
      .eq("key", `weather_custom_${clientId}`)
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

export async function getWeatherSnapshot(supabase, clientId = null) {
  const [weather, snow, custom] = await Promise.all([
    getWeatherData(supabase),
    getSnowData(supabase),
    clientId ? getCustomWeatherData(clientId, supabase) : Promise.resolve(null),
  ]);
  if (!weather && !snow && !custom) return null;
  return {
    weather:         weather?.data ?? null,
    snow:            snow?.data    ?? null,
    custom_locations: custom?.data?.locations ?? [],
    fetched_at:      weather?.fetched_at ?? snow?.fetched_at ?? custom?.fetched_at ?? null,
  };
}

export async function getHotLeads(clientId, supabase, limit = 5) {
  try {
    const { data } = await supabase
      .from("leads")
      .select("id, name, service, status, created_at, last_contacted_at")
      .eq("client_id", clientId)
      .in("status", ["new", "contacted", "engaged"])
      .order("created_at", { ascending: false })
      .limit(limit);
    return data ?? [];
  } catch {
    return [];
  }
}

export async function getRecentLeads(clientId, supabase, hours = 24) {
  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("leads")
      .select("id, name, service, status, created_at")
      .eq("client_id", clientId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(10);
    return data ?? [];
  } catch {
    return [];
  }
}

// Trailing 7 days — revenue that has already happened (start_at in past 7d).
// Used for "Last 7d" line in briefing.
export async function getWeeklyRevenueEstimate(clientId, supabase, crmSupabase = null) {
  const nowISO = new Date().toISOString();
  const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Prefer DB2 daily_manifest (real FH/MPWR revenue data)
  if (crmSupabase) {
    try {
      const { data: rows } = await crmSupabase
        .from("daily_manifest")
        .select("fareharbor_pk, receipt_total_cents, total")
        .gte("start_at", since)
        .lt("start_at", nowISO);
      if (rows?.length) {
        const seenPks = new Set();
        let totalCents = 0;
        for (const r of rows) {
          if (r.fareharbor_pk != null) seenPks.add(r.fareharbor_pk);
          if (r.receipt_total_cents != null) totalCents += Number(r.receipt_total_cents) || 0;
          else if (r.total != null) totalCents += (Number(r.total) || 0) * 100;
        }
        const bookings = seenPks.size || rows.length;
        return { bookings, estimated: Math.round(totalCents / 100), period: "7 days", source: "manifest" };
      }
    } catch { /* fall through */ }
  }
  // Fallback: estimate from DB1 leads
  try {
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("client_id", clientId)
      .in("status", ["converted", "engaged"])
      .gte("created_at", since);
    const count = data?.length ?? 0;
    return { bookings: count, estimated: count * 175, period: "7 days", source: "estimate" };
  } catch {
    return { bookings: 0, estimated: 0, period: "7 days", source: "estimate" };
  }
}

// Upcoming N days — bookings + revenue scheduled in the future window.
// Used for "Next 7d" line in briefing. Excludes BOT- placeholder PKs when
// counting bookings (they represent bot-created bookings that may be
// duplicated by real CO- PKs).
export async function getUpcomingRevenue(clientId, crmSupabase, days = 7) {
  if (!crmSupabase) return { bookings: 0, revenue_cents: 0, days, source: "unavailable" };
  try {
    const nowISO  = new Date().toISOString();
    const horizon = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, receipt_total_cents, total")
      .gte("start_at", nowISO)
      .lt("start_at", horizon);
    const rows = data ?? [];
    let cents = 0;
    let bookings = 0;
    for (const r of rows) {
      if (!/^BOT-/i.test(r.fareharbor_pk ?? "")) bookings += 1;
      if (r.receipt_total_cents != null) cents += Number(r.receipt_total_cents) || 0;
      else if (r.total != null)          cents += (Number(r.total) || 0) * 100;
    }
    return { bookings, revenue_cents: cents, days, source: "manifest" };
  } catch {
    return { bookings: 0, revenue_cents: 0, days, source: "unavailable" };
  }
}

// Returns the manifest rows for the next N days, sorted by start_at ascending.
// Filters out BOT- placeholders when a real CO- exists for the same customer+date.
export async function getUpcomingManifest(crmSupabase, days = 7) {
  if (!crmSupabase) return [];
  try {
    const nowISO  = new Date().toISOString();
    const horizon = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select(MANIFEST_SELECT)
      .gte("start_at", nowISO)
      .lt("start_at", horizon)
      .order("start_at", { ascending: true });
    const rows = (data ?? []).map(normalizeManifestRow);
    // Deduplicate BOT- placeholders: when a CO- exists for the same customer+date, drop the BOT row.
    const byKey = new Map();
    for (const r of rows) {
      const date = (r.start_at ?? "").slice(0, 10);
      const key  = `${(r.phone ?? r.customer_name ?? "?").toLowerCase()}|${date}`;
      if (!byKey.has(key)) { byKey.set(key, r); continue; }
      const existing = byKey.get(key);
      const newIsReal      = !/^BOT-/i.test(r.fareharbor_pk ?? "");
      const existingIsReal = !/^BOT-/i.test(existing.fareharbor_pk ?? "");
      if (newIsReal && !existingIsReal) byKey.set(key, r);
    }
    return [...byKey.values()].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  } catch {
    return [];
  }
}

// MT-wall-clock helpers. DB2 daily_manifest stores naive timestamps that are
// ALREADY in America/Denver wall clock (e.g. "2026-05-22 13:00:00" means 1pm
// MT). If we run `new Date(...)` on that and then `.toLocaleTimeString({
// timeZone: "America/Denver" })`, JS treats it as UTC and shifts -6h → wrong.
// These helpers parse hour/minute/date directly from the string so the
// rendered time matches the stored wall clock.
function formatMTTimeFromNaive(naive) {
  if (!naive) return "?";
  const m = String(naive).match(/[T ](\d{1,2}):(\d{2})/);
  if (!m) return "?";
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (!Number.isFinite(h)) return "?";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return min === "00" ? `${h} ${ampm}` : `${h}:${min} ${ampm}`;
}
function formatMTDateFromNaive(naive, opts = { weekday: "short", month: "short", day: "numeric" }) {
  if (!naive) return "?";
  const m = String(naive).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "?";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
}
// Extract hour-of-day from a naive timestamp (0-23) without TZ conversion.
function hourFromNaive(naive) {
  if (!naive) return null;
  const m = String(naive).match(/[T ](\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

// Parse the END hour (0-23) from an arrival_display string. Handles both
// "9:00 AM - 5:00 PM on June 12, 2026" and
// "9:00 AM on July 03 to 5:00 PM on July 05, 2026".
function endHourFromArrival(display) {
  if (!display) return null;
  const s = String(display);
  // Multi-day form: "...to 5:00 PM on..."
  let m = s.match(/to\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) {
    // Single-day form: "1:00 PM - 5:00 PM on ..."
    m = s.match(/-\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  }
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3].toUpperCase();
  if (!Number.isFinite(h)) return null;
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h;
}

// Display helpers — capitalize lowercase DB values for human-friendly output.
// Splits on whitespace, hyphen, AND underscore so DB values like "rabbit_ears"
// render as "Rabbit Ears".
function capLocation(loc) {
  if (!loc) return "?";
  return String(loc).split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function shortPhone(p) {
  if (!p) return "no phone";
  return String(p).replace(/^\+1/, "").replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
}
function compactActivity(name) {
  if (!name) return "?";
  // Strip catalog year + "Polaris" prefix; keep the vehicle portion; cut at the
  // first bullet/pipe (so trailing "• 4 Seater • Kremmling" drops out).
  return String(name)
    .replace(/^(20\d{2}\s+)?Polaris\s+/i, "")
    .split(/\s*[•|]\s*/)[0]
    .trim()
    .slice(0, 30);
}

// Affiliate slugs the operator wouldn't think of as a "partner": their own house
// tag and the booking platforms (Polaris online, Google/organic). Excluded from
// the partner mix so the line only surfaces real lodges/resellers/OTAs.
const NON_PARTNER_AFFILIATES = new Set(["coloradosledrentals", "polarisindustries", "google", "direct"]);

// Pretty display names for the affiliate slugs we know. Slugs are lowercase
// alphanumeric (FareHarbor convention), so a generic fallback can't re-split
// concatenated words — known partners get a clean label, the rest title-case.
const AFFILIATE_LABELS = {
  movingmountains:      "Moving Mountains",
  fourseasonssteamboat: "Four Seasons Steamboat",
  avaraftingandzipline: "AVA Rafting & Zipline",
  viator:               "Viator",
};
function prettifyAffiliate(slug) {
  if (!slug) return null;
  const key = String(slug).toLowerCase();
  if (AFFILIATE_LABELS[key]) return AFFILIATE_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// Partner mix from a manifest array — counts third-party-sourced bookings by
// affiliate, excluding house/platform tags. Pure, null-safe. Returns the ranked
// partner list plus how much of the total load they represent, so the briefing
// can render one high-signal line (commission exposure + who to coordinate with).
export function buildPartnerMix(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byPartner = new Map();
  let partnerBookings = 0;
  for (const r of list) {
    const slug = (r?.affiliate ?? "").trim().toLowerCase();
    if (!slug || NON_PARTNER_AFFILIATES.has(slug)) continue;
    byPartner.set(slug, (byPartner.get(slug) ?? 0) + 1);
    partnerBookings += 1;
  }
  const partners = [...byPartner.entries()]
    .map(([slug, count]) => ({ slug, name: prettifyAffiliate(slug), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = list.length;
  return {
    partners,
    partner_bookings: partnerBookings,
    total,
    pct: total ? Math.round((partnerBookings / total) * 100) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATIONAL SIGNAL DETECTORS — surface actionable items from DB2 manifest.
// Each detector is independent and graceful — null/empty crmSupabase → []/null.
// Detectors return small ranked lists; the briefing builder picks the top items
// to keep the digest short and high-signal.
// ─────────────────────────────────────────────────────────────────────────────

// Unpaid bookings with future start dates, ranked by balance_due_cents desc.
export async function detectUnpaidBookings(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const nowISO = new Date().toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, location, start_at, arrival_display, balance_due_cents, pax")
      .gt("balance_due_cents", 0)
      .gte("start_at", nowISO)
      .order("balance_due_cents", { ascending: false })
      .limit(10);
    return (data ?? []).map(normalizeManifestRow);
  } catch { return []; }
}

// Bookings arriving in the next 48h that don't have waiver_signed = true.
export async function detectMissingWaivers(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const nowISO  = new Date().toISOString();
    const horizon = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, location, start_at, pax, waiver_signed")
      .neq("waiver_signed", true)
      .gte("start_at", nowISO)
      .lt("start_at", horizon)
      .order("start_at", { ascending: true })
      .limit(20);
    return (data ?? []).map(normalizeManifestRow);
  } catch { return []; }
}

// 3+ arrivals within the same hour today → operational crunch.
export async function detectOverlappingArrivals(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(start); end.setDate(end.getDate() + 1);
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("start_at, location, pax")
      .gte("start_at", start.toISOString())
      .lt("start_at", end.toISOString());
    const rows = data ?? [];
    if (!rows.length) return [];
    const byHour = new Map();
    for (const r of rows) {
      if (!r.start_at) continue;
      const hourStr = new Date(r.start_at).toLocaleString("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: true });
      const cur = byHour.get(hourStr) ?? { count: 0, locations: {}, pax: 0 };
      cur.count += 1;
      cur.pax   += Number(r.pax) || 0;
      cur.locations[r.location ?? "?"] = (cur.locations[r.location ?? "?"] ?? 0) + 1;
      byHour.set(hourStr, cur);
    }
    return [...byHour.entries()]
      .map(([hour_label, v]) => ({ hour_label, ...v }))
      .filter((h) => h.count >= 3)
      .sort((a, b) => b.count - a.count);
  } catch { return []; }
}

// Upcoming bookings with receipt_total_cents > $1000 (100,000 cents).
export async function detectHighValueBookings(crmSupabase, minCents = 100000) {
  if (!crmSupabase) return [];
  try {
    const nowISO  = new Date().toISOString();
    const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, location, start_at, pax, receipt_total_cents, balance_due_cents")
      .gte("receipt_total_cents", minCents)
      .gte("start_at", nowISO)
      .lt("start_at", horizon)
      .order("receipt_total_cents", { ascending: false })
      .limit(5);
    return (data ?? []).map(normalizeManifestRow);
  } catch { return []; }
}

// Detects likely-duplicate bookings: BOT-prefixed PKs that share the customer
// name + start_at with a non-BOT PK. These usually indicate the bot created a
// placeholder before the real FH/Polaris booking arrived.
export async function detectDuplicateBookings(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const horizon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, start_at, phone, activity")
      .gte("start_at", since)
      .lt("start_at", horizon);
    const rows = data ?? [];
    if (!rows.length) return [];

    // Group by phone (or name fallback) + date
    const byKey = new Map();
    for (const r of rows) {
      const date = (r.start_at ?? "").slice(0, 10);
      const key  = `${(r.phone ?? r.customer_name ?? "?").toLowerCase()}|${date}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const dupes = [];
    for (const [, group] of byKey) {
      if (group.length < 2) continue;
      const hasBot = group.some((r) => /^BOT-/i.test(r.fareharbor_pk ?? ""));
      const hasReal = group.some((r) => !/^BOT-/i.test(r.fareharbor_pk ?? ""));
      if (hasBot && hasReal) {
        dupes.push({
          customer_name: group[0].customer_name,
          start_at:      group[0].start_at,
          bot_pk:        group.find((r) =>  /^BOT-/i.test(r.fareharbor_pk ?? ""))?.fareharbor_pk,
          real_pk:       group.find((r) => !/^BOT-/i.test(r.fareharbor_pk ?? ""))?.fareharbor_pk,
        });
      }
    }
    return dupes.slice(0, 10);
  } catch { return []; }
}

// Bookings arriving today or tomorrow without a phone number.
export async function detectMissingPhones(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const now    = new Date();
    const start  = new Date(now); start.setHours(0, 0, 0, 0);
    const end    = new Date(start); end.setDate(end.getDate() + 2);
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, location, start_at, pax, phone")
      .is("phone", null)
      .gte("start_at", start.toISOString())
      .lt("start_at",  end.toISOString())
      .limit(10);
    return (data ?? []).map(normalizeManifestRow);
  } catch { return []; }
}

// Compares this week's new-booking volume vs last week to flag a slowdown.
// Uses DB2 bookings.created_at, excluding BOT- placeholders (sync artifacts).
// Falls back to DB1 confirmations_sent. Returns { this_week, last_week,
// delta_pct } or null on error.
export async function detectPacingSignal(crmSupabase, supabase) {
  const now      = Date.now();
  const sinceTW  = new Date(now - 7  * 86400 * 1000).toISOString();
  const sinceLW  = new Date(now - 14 * 86400 * 1000).toISOString();

  let thisWeek = 0, lastWeek = 0;
  if (crmSupabase) {
    try {
      const [tw, lw] = await Promise.all([
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", sinceTW).not("fareharbor_pk", "ilike", "BOT-%"),
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", sinceLW).lt("created_at", sinceTW).not("fareharbor_pk", "ilike", "BOT-%"),
      ]);
      if (!tw.error && !lw.error) {
        thisWeek = tw.count ?? 0;
        lastWeek = lw.count ?? 0;
      }
    } catch { /* fall through */ }
  }
  if (thisWeek === 0 && lastWeek === 0 && supabase) {
    try {
      const [tw, lw] = await Promise.all([
        supabase.from("confirmations_sent").select("id", { count: "exact", head: true }).gte("confirmation_sent_at", sinceTW),
        supabase.from("confirmations_sent").select("id", { count: "exact", head: true }).gte("confirmation_sent_at", sinceLW).lt("confirmation_sent_at", sinceTW),
      ]);
      if (!tw.error && !lw.error) {
        thisWeek = tw.count ?? 0;
        lastWeek = lw.count ?? 0;
      }
    } catch { /* ignore */ }
  }
  const delta_pct = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  return { this_week: thisWeek, last_week: lastWeek, delta_pct };
}

// Location concentration over the last 30 days. Returns array of
// { location, count, pct } sorted desc by count.
export async function detectLocationConcentration(crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("location")
      .gte("start_at", since);
    const rows = data ?? [];
    if (!rows.length) return [];
    const counts = new Map();
    for (const r of rows) {
      const loc = r.location ?? "Unknown";
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }
    const total = rows.length;
    return [...counts.entries()]
      .map(([location, count]) => ({ location, count, pct: Math.round((count / total) * 100) }))
      .sort((a, b) => b.count - a.count);
  } catch { return []; }
}

// Unresolved handoffs from DB1 conversations. Excludes test sessions and
// obvious test phone numbers (555-XXX, +1555...) so the briefing only
// surfaces real customer issues.
export async function detectUnresolvedHandoffs(supabase, clientId) {
  if (!supabase || !clientId) return [];
  try {
    const { data } = await supabase
      .from("conversations")
      .select("from_number, updated_at, messages, session_type")
      .eq("client_id", clientId)
      .eq("handoff", true)
      .eq("handoff_resolved", false)
      .neq("session_type", "test")
      .order("updated_at", { ascending: false })
      .limit(10);
    const rows = data ?? [];
    // Filter out test phone patterns: anything starting with +1555 / 555 / 999
    // (Twilio test numbers + obvious placeholders).
    return rows.filter((r) => {
      const phone = String(r.from_number ?? "").replace(/^\+1/, "");
      if (/^555/.test(phone)) return false;
      if (/^999/.test(phone)) return false;
      return true;
    }).slice(0, 5);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATIONAL CLASSIFIERS
// classifyActivity(name) — maps a daily_manifest.activity string into a
// dispatch-friendly vehicle / category bucket. Patterns match CSR/REA's
// current FareHarbor + Polaris catalog. Unknowns route to category="other".
//
// classifyDuration(start, end) — returns the operational duration bucket
// from start_at + end_at timestamps:
//   short      < 4h
//   half_day   4–8h
//   full_day   8–24h
//   overnight  24–48h
//   multi_day  > 48h
// ─────────────────────────────────────────────────────────────────────────────

export function classifyActivity(activityName) {
  const s = String(activityName ?? "").toLowerCase();
  if (!s) return { vehicle_type: "unknown", category: "other", short_label: "?" };

  // RZR catalog
  if (s.includes("turbo") && s.includes("rzr"))
    return { vehicle_type: "turbo_xp", category: "rzr_rental", short_label: "Turbo XP" };
  if (s.includes("rzr") && s.includes("experience"))
    return { vehicle_type: "rzr_experience", category: "rzr_rental", short_label: "RZR Experience" };
  if (s.includes("rzr"))
    return { vehicle_type: "rzr_generic", category: "rzr_rental", short_label: "RZR" };

  // Snowmobile (must come before "guided" to catch "Guided Snowmobile Tour")
  if (s.includes("snowmobile"))
    return { vehicle_type: "snowmobile", category: "snowmobile_tour", short_label: "Snowmobile" };

  // Guided / Rabbit Ears
  if (s.includes("rabbit ears"))
    return { vehicle_type: "rabbit_ears", category: "guided_tour", short_label: "Rabbit Ears tour" };
  if (s.includes("guided") || s.includes("private tour"))
    return { vehicle_type: "guided", category: "guided_tour", short_label: "Guided tour" };

  // ATV / UTV catch-all
  if (s.includes("utv") || s.includes("atv") || s.includes("off-road") || s.includes("off road"))
    return { vehicle_type: "utv", category: "rzr_rental", short_label: "UTV" };

  return { vehicle_type: "unknown", category: "other", short_label: activityName?.slice(0, 24) ?? "?" };
}

export function classifyDuration(startAt, endAt) {
  try {
    if (!startAt || !endAt) return { label: "unknown", hours: null, is_multi_day: false };
    const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return { label: "unknown", hours: null, is_multi_day: false };
    const hours = ms / (60 * 60 * 1000);
    if (hours <  4)  return { label: "short",     hours, is_multi_day: false };
    if (hours <= 8)  return { label: "half_day",  hours, is_multi_day: false };
    if (hours <= 24) return { label: "full_day",  hours, is_multi_day: false };
    if (hours <= 48) return { label: "overnight", hours, is_multi_day: true  };
    return { label: "multi_day", hours, is_multi_day: true };
  } catch {
    return { label: "unknown", hours: null, is_multi_day: false };
  }
}

// Naive-timestamp-aware duration classifier. Computes hours by parsing the
// date+time portions directly so the result doesn't depend on the host TZ.
// Prefers arrival_display when both start_at and end_at look unreliable.
export function classifyDurationFromNaive(startNaive, endNaive, arrivalDisplay) {
  // Multi-day detection from arrival_display: "...on July 03 to ... on July 05..."
  if (arrivalDisplay && /\bto\b/i.test(arrivalDisplay)) {
    const m = arrivalDisplay.match(/on\s+([A-Za-z]+\s+\d{1,2})(?:,\s*\d{4})?\s+to\s+(?:[\d:]+\s*[AP]M\s+)?on\s+([A-Za-z]+\s+\d{1,2})/i);
    if (m) {
      // Spans multiple calendar days → multi-day (or overnight if just one night)
      const startDayStr = m[1];
      const endDayStr   = m[2];
      // Different-day strings → at least overnight; assume multi_day unless
      // a more precise day count is parseable.
      if (startDayStr.trim() !== endDayStr.trim()) {
        return { label: "multi_day", hours: null, is_multi_day: true };
      }
    }
  }

  // Single-day: parse hours from naive timestamps (works without TZ math).
  const sH = hourFromNaive(startNaive);
  // End time: prefer endNaive's hour; fall back to endHourFromArrival.
  let eH = hourFromNaive(endNaive);
  if (!Number.isFinite(eH) && arrivalDisplay) eH = endHourFromArrival(arrivalDisplay);
  if (!Number.isFinite(sH) || !Number.isFinite(eH)) {
    return { label: "unknown", hours: null, is_multi_day: false };
  }
  let hours = eH - sH;
  if (hours <= 0) hours += 24; // crossed midnight (unlikely for single-day rentals)
  if (hours <  4)  return { label: "short",     hours, is_multi_day: false };
  if (hours <= 8)  return { label: "half_day",  hours, is_multi_day: false };
  if (hours <= 24) return { label: "full_day",  hours, is_multi_day: false };
  return { label: "multi_day", hours, is_multi_day: true };
}

// Bucket a naive timestamp string into MT hour-of-day → "morning" / "midday"
// / "afternoon" / "evening". Uses hourFromNaive so we don't shift by TZ.
function timeBlock(naive) {
  if (!naive) return "unknown";
  const h = hourFromNaive(naive);
  if (!Number.isFinite(h)) return "unknown";
  if (h <  10) return "morning";
  if (h <  13) return "midday";
  if (h <  17) return "afternoon";
  return "evening";
}

// ─────────────────────────────────────────────────────────────────────────────
// TODAY'S LOAD SNAPSHOT — operational dispatch summary
// Takes a manifest array (from getTodaysManifest) and produces a structured
// snapshot the briefing can render as the lead section. Pure — no I/O.
// ─────────────────────────────────────────────────────────────────────────────
export function buildTodayLoadSnapshot(manifest) {
  const rows = Array.isArray(manifest) ? manifest : [];
  const totals = {
    bookings:        rows.length,
    pax:             0,
    revenue_cents:   0,
    unpaid_cents:    0,
    missing_waivers: 0,
  };
  const vehicleMix  = new Map();   // short_label → { count, pax }
  const durationMix = { short: 0, half_day: 0, full_day: 0, overnight: 0, multi_day: 0 };
  const locationMix = new Map();   // location → { count, pax }
  const clusters    = { morning: 0, midday: 0, afternoon: 0, evening: 0, unknown: 0 };
  const lateReturns = [];          // bookings whose end_at is after 5pm MT today
  const multidayUnpaid = [];

  for (const r of rows) {
    // Accept both view shape (pax / receipt_total_cents) and internal shape
    // (customer_count / total_cents from normalizeManifestRow).
    const pax   = Number(r.pax ?? r.customer_count) || 0;
    const cents = Number(r.receipt_total_cents ?? r.total_cents) || 0;

    totals.pax += pax;
    totals.revenue_cents += cents;
    totals.unpaid_cents  += Number(r.balance_due_cents) || 0;
    if (r.waiver_signed === false) totals.missing_waivers += 1;

    const cls = classifyActivity(r.activity);
    const vKey = cls.short_label;
    const v    = vehicleMix.get(vKey) ?? { count: 0, pax: 0 };
    v.count += 1; v.pax += pax;
    vehicleMix.set(vKey, v);

    // Duration — prefer explicit end_at, fall back to arrival_display.
    const endAt = r.end_at ?? (r.arrival_display ? parseEndAtFromArrival(r.arrival_display, r.start_at) : null);
    const dur   = classifyDurationFromNaive(r.start_at, endAt, r.arrival_display);
    if (dur.label in durationMix) durationMix[dur.label] += 1;

    const loc = r.location ?? "Unknown";
    const L   = locationMix.get(loc) ?? { count: 0, pax: 0 };
    L.count += 1; L.pax += pax;
    locationMix.set(loc, L);

    const block = timeBlock(r.start_at);
    clusters[block] = (clusters[block] ?? 0) + 1;

    // Late returns (full-day / multi-day ending past 5pm today).
    // r.arrival_display contains the wall-clock end time directly — parse it.
    const endHour = endHourFromArrival(r.arrival_display);
    if (Number.isFinite(endHour) && endHour >= 17) lateReturns.push(r);

    if (dur.is_multi_day && (Number(r.balance_due_cents) || 0) > 0) {
      multidayUnpaid.push(r);
    }
  }

  const vehicleList  = [...vehicleMix.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.count - a.count);
  const locationList = [...locationMix.entries()].map(([location, v]) => ({ location, ...v })).sort((a, b) => b.count - a.count);
  const topLocation  = locationList[0] ?? null;
  const totalsLoc    = locationList.reduce((s, l) => s + l.count, 0);

  // Operational tone signals
  let load_tone = null;
  if (totals.bookings === 0)       load_tone = "quiet_day";
  else if (totals.bookings <= 2)   load_tone = "light_day";
  else if (totals.bookings >= 10)  load_tone = "heavy_day";
  else                             load_tone = "steady";

  let timing_tone = null;
  if (clusters.afternoon > clusters.morning + 1) timing_tone = "afternoon_heavy";
  else if (clusters.morning > clusters.afternoon + 1) timing_tone = "morning_heavy";
  else timing_tone = "balanced";

  return {
    totals,
    vehicle_mix:  vehicleList,
    duration_mix: durationMix,
    location_mix: locationList,
    top_location: topLocation ? { ...topLocation, pct: totalsLoc ? Math.round((topLocation.count / totalsLoc) * 100) : 0 } : null,
    time_clusters: clusters,
    late_returns: lateReturns,
    multiday_unpaid: multidayUnpaid,
    load_tone,
    timing_tone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION SCOPING + SECTION GATING (per-operator briefings)
// An operator phone can be assigned to one or more of the 4 logical locations.
// Assigned operators get a STRICT-FILTERED briefing (only their location[s]);
// owners / unassigned phones see everything. MPWR work orders live under 2
// fleets, so location → fleet maps Kremmling to its own fleet and Steamboat /
// North Routt / Rabbit Ears all to the Steamboat fleet.
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATOR_LOCATIONS = ["steamboat", "north_routt", "kremmling", "rabbit_ears"];

export function fleetForLocation(loc) {
  return String(loc ?? "").toLowerCase().trim() === "kremmling" ? "kremmling" : "steamboat";
}

// Normalize an operator's assigned-locations array. Empty / null / ['all'] ⇒
// unscoped (owner view) ⇒ returns null. Otherwise a cleaned lowercase list.
export function normalizeLocations(locations) {
  if (!Array.isArray(locations)) return null;
  const cleaned = locations.map((l) => String(l ?? "").toLowerCase().trim()).filter(Boolean);
  if (!cleaned.length || cleaned.includes("all")) return null;
  return cleaned;
}

// Fleets covered by a set of locations (for work-order scoping). null = all.
export function locationsToFleets(locations) {
  const locs = normalizeLocations(locations);
  if (!locs) return null;
  return [...new Set(locs.map(fleetForLocation))];
}

// Filter manifest-style rows (anything with `.location`) to the scoped
// locations. Unscoped (null) returns rows unchanged. Pure, null-safe.
export function filterManifestByLocations(rows, locations) {
  const locs = normalizeLocations(locations);
  if (!Array.isArray(rows)) return [];
  if (!locs) return rows;
  return rows.filter((r) => locs.includes(String(r?.location ?? "").toLowerCase()));
}

// digest_types section gate. ['all'] (default) shows everything; otherwise the
// section's category must be present. Backward-compatible: legacy rows default
// to ['all'] so nothing is hidden. Pure.
export function wantsSection(digestTypes, category) {
  if (!Array.isArray(digestTypes) || !digestTypes.length) return true;
  if (digestTypes.includes("all")) return true;
  return digestTypes.includes(category);
}

// Urgency sort for open work orders: out-of-service first, then safety issues,
// then soonest estimated completion, then oldest created. Pure.
export function workOrderUrgencyCmp(a, b) {
  const oos = (b?.out_of_service ? 1 : 0) - (a?.out_of_service ? 1 : 0);
  if (oos) return oos;
  const safe = (b?.is_safety_issue ? 1 : 0) - (a?.is_safety_issue ? 1 : 0);
  if (safe) return safe;
  const ad = a?.estimated_completion_date ?? "9999-99-99";
  const bd = b?.estimated_completion_date ?? "9999-99-99";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return String(a?.created_date ?? "").localeCompare(String(b?.created_date ?? ""));
}

// Open fleet work orders from DB2 `work_orders`, scoped to the given fleets
// (null = all). Returns the top `limit` by urgency. Degrades to [] if the table
// is absent or on any error.
export async function getOpenWorkOrders(crmSupabase, fleets = null, limit = 12) {
  if (!crmSupabase) return [];
  try {
    let q = crmSupabase
      .from("work_orders")
      .select("id, fleet, work_type, is_safety_issue, out_of_service, asset_family, unit_name, work_to_be_done, notes, created_date, estimated_completion_date, url")
      .eq("is_closed", false)
      .not("retired", "is", true); // exclude retired/dispositioned-vehicle cruft (keeps null = unknown)
    if (Array.isArray(fleets) && fleets.length) q = q.in("fleet", fleets);
    const { data } = await q;
    return (data ?? []).slice().sort(workOrderUrgencyCmp).slice(0, limit);
  } catch {
    return [];
  }
}

// 🔧 FLEET — open work orders the on-site team can act on. Pure renderer;
// returns an array of lines (empty when there are none). The MPWR deep link is
// always included per the operator decision (anyone receiving WO info can log
// in to MPWR).
export function buildWorkOrdersLines(workOrders, { max = 6 } = {}) {
  const rows = Array.isArray(workOrders) ? workOrders : [];
  if (!rows.length) return [];
  const lines = ["", "🔧 FLEET / WORK ORDERS"];
  const oosCount = rows.filter((w) => w.out_of_service).length;
  if (oosCount > 0) lines.push(`• ${oosCount} unit${oosCount !== 1 ? "s" : ""} out of service`);
  for (const w of rows.slice(0, max)) {
    const flag = w.out_of_service ? "⚠️ " : (w.is_safety_issue ? "⚠ " : "");
    const veh  = [w.asset_family, w.unit_name ? `(${w.unit_name})` : null].filter(Boolean).join(" ") || "Unit";
    const type = humanizeWorkType(w.work_type);
    const desc = String(w.work_to_be_done || w.notes || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const eta  = w.estimated_completion_date
      ? `est. ${formatMTDateFromNaive(w.estimated_completion_date, { month: "short", day: "numeric" })}`
      : null;
    const bits = [type, eta, desc ? `"${desc}"` : null].filter(Boolean).join(" · ");
    lines.push(`• ${flag}${veh} — ${bits}`);
    if (w.url) lines.push(`  ${w.url}`);
  }
  if (rows.length > max) lines.push(`• +${rows.length - max} more open`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// BRIEFING TEXT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export function buildBriefingText(client, todaySlotsOrIgnored, hotLeads, weatherSnap, extras = {}) {
  const biz     = client.name ?? "Your business";
  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric",
  });

  const manifest         = extras.manifest         ?? [];
  const unpaid           = extras.unpaid           ?? [];
  const missingWaivers   = extras.missingWaivers   ?? [];
  const overlaps         = extras.overlaps         ?? [];
  const highValue        = extras.highValue        ?? [];
  const duplicates       = extras.duplicates       ?? [];
  const missingPhones    = extras.missingPhones    ?? [];
  const pacing           = extras.pacing           ?? null;
  const locationMix      = extras.locationMix      ?? [];
  const unresolved       = extras.unresolvedHandoffs ?? [];
  const rev              = extras.revenue          ?? null;
  const season           = extras.seasonRevenue    ?? null;
  const newBookings      = extras.newBookings      ?? null;
  const issues           = extras.issues           ?? [];
  const workOrders       = extras.workOrders       ?? [];
  const digestTypes      = extras.digestTypes      ?? ["all"];
  const scopeLocations   = normalizeLocations(extras.locations);

  const lines = [];
  // Scope tag — when the recipient is assigned to specific location(s), label
  // the briefing so they know it's filtered to their post.
  const scopeTag = scopeLocations
    ? ` · ${scopeLocations.map(capLocation).join(" + ")}`
    : "";
  lines.push(`🏔 OPERATOR BRIEFING — ${dateStr}${scopeTag}`);
  lines.push(`${biz}`);

  // ── 🏁 TODAY'S LOAD — operational dispatch summary (LEAD section) ────────
  const snap = buildTodayLoadSnapshot(manifest);
  if (wantsSection(digestTypes, "bookings") && snap.totals.bookings > 0) {
    lines.push("");
    lines.push("🏁 TODAY'S LOAD");

    // Header — total bookings · pax · revenue
    const revUSD = Math.round(snap.totals.revenue_cents / 100).toLocaleString();
    const headerBits = [`${snap.totals.bookings} booking${snap.totals.bookings !== 1 ? "s" : ""}`, `${snap.totals.pax} guest${snap.totals.pax !== 1 ? "s" : ""}`, `$${revUSD}`];
    lines.push(`• ${headerBits.join(" · ")}`);

    // Per-booking detail — name · vehicle · location · pax · phone · time
    // Shown inline for ≤8 bookings; otherwise we summarize + suggest "Reply 1".
    if (manifest.length <= 8) {
      for (const r of manifest) {
        const time  = formatMTTimeFromNaive(r.start_at);
        const name  = (r.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
        const act   = compactActivity(r.activity);
        const loc   = capLocation(r.location);
        const phone = shortPhone(r.phone);
        lines.push(`• ${time} — ${name} · ${act} · ${loc} · ${r.pax ?? r.customer_count ?? "?"}p · ${phone}`);
      }
    } else {
      // Compact summary for heavy days
      const vehicleParts = snap.vehicle_mix.slice(0, 3).map((v) => `${v.count} ${v.label}`);
      if (vehicleParts.length) lines.push(`• Vehicles: ${vehicleParts.join(", ")}`);
      if (snap.location_mix.length) {
        const locParts = snap.location_mix.slice(0, 2).map((l) => `${capLocation(l.location)} ${l.count}`);
        lines.push(`• Locations: ${locParts.join(" · ")}`);
      }
      const tc = snap.time_clusters;
      const timingBits = [];
      if (tc.morning)   timingBits.push(`${tc.morning} morning`);
      if (tc.midday)    timingBits.push(`${tc.midday} midday`);
      if (tc.afternoon) timingBits.push(`${tc.afternoon} afternoon`);
      if (timingBits.length) {
        let tone = "";
        if (snap.timing_tone === "afternoon_heavy") tone = " — heavy afternoon load";
        else if (snap.timing_tone === "morning_heavy") tone = " — front-loaded morning";
        lines.push(`• Pickups: ${timingBits.join(" / ")}${tone}`);
      }
      lines.push("Reply 1 for full manifest detail");
    }

    // Late returns (pressure point) — only meaningful when ≤8 detail mode
    if (snap.late_returns.length && manifest.length <= 8) {
      lines.push(`• ${snap.late_returns.length} return${snap.late_returns.length !== 1 ? "s" : ""} after 5pm`);
    }

    // Partner-sourced bookings today — flag who to coordinate with (lodges
    // arrange pickups, OTAs need confirmations). Only shown when present.
    const todayPartners = buildPartnerMix(manifest);
    if (todayPartners.partner_bookings > 0) {
      const names = todayPartners.partners.slice(0, 2).map(p => `${p.name} ${p.count}`).join(" · ");
      const more  = todayPartners.partners.length > 2 ? " +more" : "";
      lines.push(`• Partners: ${names}${more}`);
    }
  } else if (wantsSection(digestTypes, "bookings")) {
    lines.push("");
    lines.push("🏁 TODAY — quiet, nothing on the manifest.");
  }

  // ── 📅 NEXT 7 DAYS — summary view (totals + breakdown, not per-booking) ─
  const upcomingManifest = Array.isArray(extras.upcomingManifest) ? extras.upcomingManifest : [];
  const upcomingRev      = extras.upcomingRevenue ?? null;
  if (wantsSection(digestTypes, "bookings") && (upcomingManifest.length > 0 || (upcomingRev && upcomingRev.bookings > 0))) {
    lines.push("");
    lines.push("📅 NEXT 7 DAYS");
    if (upcomingRev && upcomingRev.bookings > 0) {
      const dol = `$${Math.round((upcomingRev.revenue_cents ?? 0) / 100).toLocaleString()}`;
      const pax = upcomingManifest.reduce((s, r) => s + (Number(r.pax ?? r.customer_count) || 0), 0);
      lines.push(`• ${upcomingRev.bookings} bookings · ${pax} guests · ${dol}`);
    }
    if (upcomingManifest.length) {
      // Location breakdown
      const byLoc = new Map();
      for (const r of upcomingManifest) {
        const loc = capLocation(r.location);
        byLoc.set(loc, (byLoc.get(loc) ?? 0) + 1);
      }
      const locParts = [...byLoc.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([loc, n]) => `${loc} ${n}`);
      if (locParts.length) lines.push(`• Locations: ${locParts.join(" · ")}`);

      // Vehicle mix
      const byVeh = new Map();
      for (const r of upcomingManifest) {
        const v = classifyActivity(r.activity).short_label;
        byVeh.set(v, (byVeh.get(v) ?? 0) + 1);
      }
      const vehParts = [...byVeh.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([v, n]) => `${n} ${v}`);
      if (vehParts.length) lines.push(`• Vehicles: ${vehParts.join(", ")}`);

      // Busiest day of the week ahead
      const byDay = new Map();
      for (const r of upcomingManifest) {
        const d = (r.start_at ?? "").slice(0, 10);
        byDay.set(d, (byDay.get(d) ?? 0) + 1);
      }
      const sortedDays = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
      if (sortedDays.length && sortedDays[0][1] >= 2) {
        const [bestDate, count] = sortedDays[0];
        const label = formatMTDateFromNaive(bestDate, { weekday: "short", month: "short", day: "numeric" });
        lines.push(`• Busiest day: ${label} (${count} bookings)`);
      }

      // Partner-sourced share of the pipeline — top sources + how much of the
      // week's load comes through lodges/resellers (commission + coordination).
      const partnerMix = buildPartnerMix(upcomingManifest);
      if (partnerMix.partner_bookings > 0) {
        const parts = partnerMix.partners.slice(0, 3).map(p => `${p.name} ${p.count}`);
        lines.push(`• Partners: ${parts.join(" · ")} (${partnerMix.partner_bookings} of ${partnerMix.total}, ${partnerMix.pct}%)`);
      }
    }
  }

  // ── ⚠ ACTIONS NEEDED — surface real problems, not metrics ───────────────
  const actions = [];

  // Unpaid balances (top by balance, with name + dollar)
  if (unpaid.length) {
    const total = unpaid.reduce((s, r) => s + (Number(r.balance_due_cents) || 0), 0);
    const top   = unpaid[0];
    const topName = (top.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    const topAmt  = `$${Math.round((top.balance_due_cents ?? 0) / 100).toLocaleString()}`;
    const topDate = formatMTDateFromNaive(top.start_at, { month: "short", day: "numeric" });
    actions.push(`$${Math.round(total / 100).toLocaleString()} unpaid across ${unpaid.length} booking${unpaid.length !== 1 ? "s" : ""} — biggest: ${topName} ${topAmt} (${topDate})`);
  }

  // Missing waivers (next 48h)
  if (missingWaivers.length) {
    const arrivingToday = missingWaivers.filter((r) => isToday(r.start_at)).length;
    const todayClause   = arrivingToday > 0 ? ` — ${arrivingToday} arrive today` : "";
    actions.push(`${missingWaivers.length} guest${missingWaivers.length !== 1 ? "s" : ""} missing waivers${todayClause}`);
  }

  // Overlapping arrivals
  if (overlaps.length) {
    const top = overlaps[0];
    const locText = Object.entries(top.locations ?? {}).map(([loc, n]) => `${loc} ${n}`).join("/");
    actions.push(`${top.count} arrivals overlap at ${top.hour_label}${locText ? ` (${locText})` : ""}`);
  }

  // Missing phone numbers on imminent arrivals
  if (missingPhones.length) {
    const first = missingPhones[0];
    const name  = (first.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    actions.push(`${missingPhones.length} booking${missingPhones.length !== 1 ? "s" : ""} missing phone — e.g. ${name}`);
  }

  if (actions.length && wantsSection(digestTypes, "staffing")) {
    lines.push("");
    lines.push("⚠ ACTIONS");
    for (const a of actions.slice(0, 5)) lines.push(`• ${a}`);
  }

  // ── 🔧 FLEET / WORK ORDERS — open MPWR maintenance for this fleet ─────────
  if (wantsSection(digestTypes, "fleet")) {
    for (const l of buildWorkOrdersLines(workOrders)) lines.push(l);
  }

  // ── 💰 REVENUE — collected + upcoming + season ──────────────────────────
  const revLines = [];
  if (rev && rev.estimated > 0) {
    const tag = rev.source === "manifest" ? "" : " (est)";
    revLines.push(`Last 7d collected${tag}: $${rev.estimated.toLocaleString()} · ${rev.bookings} booking${rev.bookings !== 1 ? "s" : ""}`);
  }
  if (upcomingRev && upcomingRev.bookings > 0 && upcomingRev.revenue_cents > 0) {
    revLines.push(`Upcoming 7d: $${Math.round(upcomingRev.revenue_cents / 100).toLocaleString()} · ${upcomingRev.bookings} booking${upcomingRev.bookings !== 1 ? "s" : ""}`);
  }
  if (season && season.revenue_cents > 0) {
    const tag = season.source === "manifest" ? "" : " (est)";
    revLines.push(`${season.period_label}${tag}: $${Math.round(season.revenue_cents / 100).toLocaleString()}`);
  }
  if (highValue.length) {
    const top = highValue[0];
    const name = (top.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    const dol  = `$${Math.round((top.total_cents ?? top.receipt_total_cents ?? 0) / 100).toLocaleString()}`;
    const date = formatMTDateFromNaive(top.start_at, { month: "short", day: "numeric" });
    const unpaidNote = (top.balance_due_cents ?? 0) > 0 ? " — UNPAID" : "";
    revLines.push(`Largest upcoming: ${name} ${dol} (${date}, ${compactActivity(top.activity)})${unpaidNote}`);
  }
  if (revLines.length && wantsSection(digestTypes, "revenue")) {
    lines.push("");
    lines.push("💰 REVENUE");
    for (const l of revLines) lines.push(`• ${l}`);
  }

  // ── 📈 INSIGHTS — patterns worth noting ──────────────────────────────────
  const insights = [];
  if (locationMix.length >= 2) {
    const top = locationMix[0];
    const second = locationMix[1];
    if (top.pct >= 60) {
      insights.push(`${capLocation(top.location)} driving ${top.pct}% of bookings — ${capLocation(second.location)} only ${second.pct}%`);
    }
  }
  if (pacing && pacing.last_week > 5 && pacing.delta_pct != null) {
    if (pacing.delta_pct <= -25) {
      insights.push(`Pacing down ${Math.abs(pacing.delta_pct)}% vs last week (${pacing.this_week} vs ${pacing.last_week} new bookings)`);
    } else if (pacing.delta_pct >= 50) {
      insights.push(`Pacing up ${pacing.delta_pct}% vs last week — strong momentum`);
    }
  }
  if (duplicates.length) {
    insights.push(`${duplicates.length} duplicate BOT-/CO- reservation${duplicates.length !== 1 ? "s" : ""} detected — review imports`);
  }
  if (newBookings && newBookings.last_24h > 0) {
    insights.push(`${newBookings.last_24h} new in last 24h · ${newBookings.last_7d} this week`);
  }
  if (insights.length && wantsSection(digestTypes, "revenue")) {
    lines.push("");
    lines.push("📈 INSIGHTS");
    for (const i of insights.slice(0, 3)) lines.push(`• ${i}`);
  }

  // ── 🔥 FOLLOW UP — specific calls/messages ───────────────────────────────
  const followups = [];
  // Biggest unpaid → specific call
  if (unpaid.length) {
    const top  = unpaid[0];
    const name = (top.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    const dol  = `$${Math.round((top.balance_due_cents ?? 0) / 100).toLocaleString()}`;
    const date = formatMTDateFromNaive(top.start_at, { month: "short", day: "numeric" });
    followups.push(`Call ${name} — ${dol} unpaid balance before ${date}`);
  }
  // Hot leads
  if (hotLeads.length) {
    for (const lead of hotLeads.slice(0, 2)) {
      const name = (lead.name ?? "Unknown").split(" ")[0];
      followups.push(`Hot lead: ${name} — ${lead.service ?? "n/a"} (${lead.status})`);
    }
  }
  // Unresolved handoffs
  if (unresolved.length) {
    for (const h of unresolved.slice(0, 1)) {
      const last  = Array.isArray(h.messages) ? h.messages[h.messages.length - 1] : null;
      const body  = (last?.content ?? "").slice(0, 40);
      const phone = (h.from_number ?? "").replace(/^\+1/, "");
      followups.push(`Unresolved handoff: ${phone} — "${body}…"`);
    }
  }
  if (followups.length && wantsSection(digestTypes, "leads")) {
    lines.push("");
    lines.push("🔥 FOLLOW UP");
    for (const f of followups.slice(0, 4)) lines.push(`• ${f}`);
  }

  // ── 🌤 CONDITIONS — only if weather data exists ──────────────────────────
  const condLine = buildConditionsLine(weatherSnap);
  if (wantsSection(digestTypes, "weather") && condLine !== "No weather data available." && condLine !== "Conditions unavailable.") {
    lines.push("");
    lines.push(`🌤 CONDITIONS — ${condLine}`);
  }

  // ── System alerts (still important but lower priority than ACTIONS) ──────
  if (issues.length && wantsSection(digestTypes, "issues")) {
    lines.push("");
    lines.push("⚠️ SYSTEM");
    for (const i of issues.slice(0, 2)) lines.push(`• ${i}`);
  }

  // ── If nothing surfaced, give a friendly idle line ──────────────────────
  if (actions.length === 0 && followups.length === 0 && revLines.length === 0) {
    lines.push("");
    lines.push("Quiet morning — nothing flagged. Reply for details on what's on the books.");
  }

  // ── Quick-reply menu — operational focus ─────────────────────────────────
  lines.push("");
  lines.push("Reply 1-8 or ask anything:");
  lines.push("1 Manifest    5 Hot leads");
  lines.push("2 Revenue     6 Underbooked");
  lines.push("3 Follow-ups  7 Unpaid");
  lines.push("4 Risks       8 Missing waivers");

  let text = lines.join("\n");
  if (text.length > 1480) text = smartTruncate(text, 1480);
  return text;
}

// Helper — true if the naive timestamp's date portion matches today MT.
// (DB2 stores dates in MT wall clock, so direct prefix match works.)
function isToday(naive) {
  if (!naive) return false;
  const m = String(naive).match(/^(\d{4}-\d{2}-\d{2})/);
  return !!m && m[1] === todayMT();
}

// ─────────────────────────────────────────────────────────────────────────────
// NUMERIC QUICK-REPLY MENU
// Maps "1"-"7" inbound replies to internal operator commands. The mapping is
// stable across briefings so an operator can scroll back and reply with a
// number at any time of day.
// ─────────────────────────────────────────────────────────────────────────────
export const OPERATOR_MENU = {
  "1":  "bookings today",
  "2":  "revenue this week",
  "3":  "follow-ups",
  "4":  "risks",
  "5":  "leads",
  "6":  "underbooked",
  "7":  "unpaid",
  "8":  "missing waivers",
  "9":  "ops load",
  "10": "weather",
};

export function resolveMenuShortcut(message) {
  const trimmed = String(message ?? "").trim();
  return OPERATOR_MENU[trimmed] ?? null;
}

function buildConditionsLine(snap) {
  if (!snap) return "No weather data available.";
  const w = snap.weather;
  const s = snap.snow;

  const temp   = w?.steamboat?.temp     != null ? `${w.steamboat.temp}°F` : null;
  const desc   = w?.steamboat?.desc     ?? null;
  const pass   = w?.rabbit_ears_pass    ?? null;

  // SNOTEL: first station
  const stations = s?.stations ? Object.values(s.stations) : [];
  const firstStation = stations[0];
  const depth  = firstStation?.snow_depth_in != null ? `${firstStation.snow_depth_in}" base` : null;
  const avDanger = s?.avalanche_danger
    ? s.avalanche_danger.split("|")[0].trim().replace("Alpine:", "Avalanche:").trim()
    : null;

  const parts = [
    pass   ? `${pass.temp}°F ${pass.desc}` : (temp && desc ? `${temp} ${desc}` : null),
    depth,
    avDanger,
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : "Conditions unavailable.";
}

function smartTruncate(text, max) {
  if (text.length <= max) return text;
  const cutAt = text.lastIndexOf("\n", max - 3);
  return (cutAt > 0 ? text.slice(0, cutAt) : text.slice(0, max - 3)) + "...";
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND OPERATOR BRIEFING
// ─────────────────────────────────────────────────────────────────────────────

export async function sendOperatorBriefing(client, supabase, twilioClient) {
  const ownerPhone = client.owner_phone ?? client.ownerPhone ?? null;

  if (!ownerPhone) {
    console.warn(`[BRIEFING] No owner_phone for ${client.id} — skipping`);
    return { success: false, reason: "no_owner_phone" };
  }

  const twilioNumber = client.twilio_number ?? client.inboundPhones?.[0] ?? null;
  if (!twilioNumber) {
    console.warn(`[BRIEFING] No twilio number for ${client.id} — skipping`);
    return { success: false, reason: "no_twilio_number" };
  }

  const [todaySlots, hotLeads, weatherSnap] = await Promise.all([
    getTodaysAvailability(client.id, supabase),
    getHotLeads(client.id, supabase, 3),
    getWeatherSnapshot(supabase, client.id),
  ]);

  const briefing = buildBriefingText(client, todaySlots, hotLeads, weatherSnap);

  // Persist briefing record
  const status = process.env.TEST_MODE === "true" ? "test" : "sent";
  try {
    await supabase.from("operator_briefings").insert({
      client_id: client.id,
      content:   briefing,
      sent_at:   new Date().toISOString(),
      status,
    });
  } catch (err) {
    console.warn(`[BRIEFING] Could not persist briefing for ${client.id}:`, err.message);
  }

  if (process.env.TEST_MODE === "true") {
    return { success: true, preview: briefing, sent: false, chars: briefing.length };
  }

  await twilioClient.messages.create({
    from: twilioNumber,
    to:   ownerPhone,
    body: briefing,
  });

  console.log(`[BRIEFING] Sent to ${ownerPhone} for ${client.id} (${briefing.length} chars)`);
  return { success: true, preview: briefing, sent: true, chars: briefing.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATIONAL ISSUE DETECTION
// Returns string[] of human-readable alerts. All checks are independent;
// a failure in one never blocks the others.
// ─────────────────────────────────────────────────────────────────────────────

export async function detectOperationalIssues(client, supabase, crmSupabase = null) {
  const issues = [];
  const clientId = client?.id ?? null;

  // 1. Booking velocity drop — compare this 7 days vs prior 7 days (DB2)
  if (crmSupabase) {
    try {
      const since7  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString();
      const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const [thisRes, lastRes] = await Promise.all([
        crmSupabase.from("daily_manifest").select("fareharbor_pk").gte("start_at", since7),
        crmSupabase.from("daily_manifest").select("fareharbor_pk").gte("start_at", since14).lt("start_at", since7),
      ]);
      const thisCount = new Set((thisRes.data ?? []).map(r => r.fareharbor_pk).filter(Boolean)).size;
      const lastCount = new Set((lastRes.data ?? []).map(r => r.fareharbor_pk).filter(Boolean)).size;
      if (lastCount > 5 && thisCount < lastCount * 0.7) {
        const pct = Math.round((1 - thisCount / lastCount) * 100);
        issues.push(`Bookings down ${pct}% vs prior week (${thisCount} vs ${lastCount})`);
      }
    } catch { /* silent — don't block briefing */ }
  }

  // 2. Confirmation texts disabled
  if (process.env.CONFIRMATIONS_ENABLED !== "true") {
    issues.push("Confirmation texts are OFF — guests not receiving auto-confirmations");
  }

  // 3. Stale FH knowledge base (>6h since last sync)
  if (supabase && clientId) {
    try {
      const fhRows = await getFhDataForClient(clientId, supabase);
      if (fhRows.length) {
        const latestSync = fhRows.reduce((latest, r) =>
          (!latest || (r.fetched_at ?? "") > latest ? (r.fetched_at ?? "") : latest), null);
        if (latestSync) {
          const ageHours = (Date.now() - new Date(latestSync).getTime()) / (60 * 60 * 1000);
          if (ageHours > 6) {
            issues.push(`FH knowledge base last synced ${Math.round(ageHours)}h ago — may be stale`);
          }
        }
      }
    } catch { /* silent */ }
  }

  // 4. New leads uncontacted >4h
  if (supabase && clientId) {
    try {
      const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const { data: staleleads } = await supabase
        .from("leads")
        .select("id", { count: "exact" })
        .eq("client_id", clientId)
        .eq("status", "new")
        .lte("created_at", cutoff);
      const count = staleleads?.length ?? 0;
      if (count > 0) {
        issues.push(`${count} new lead${count !== 1 ? "s" : ""} uncontacted >4h`);
      }
    } catch { /* silent */ }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE DAILY BRIEFING
// Enhanced version of sendOperatorBriefing with:
//   • No-duplicate guard (skips if already sent in last 20h)
//   • Real 7-day revenue from DB2 daily_manifest when available
//   • Operational issues surfaced as ALERTS section
// ─────────────────────────────────────────────────────────────────────────────

export async function generateDailyBriefing(client, supabase, twilioClient, crmSupabase = null, options = {}) {
  // Phone resolution: explicit override > client.ownerPhone > client.owner_phone.
  // The dispatcher passes { toPhone, dedupKey, opRowId } per operator_phones row;
  // legacy callers (no options) keep the old owner-only behavior.
  const toPhone  = options.toPhone   ?? client.owner_phone ?? client.ownerPhone ?? null;
  const dedupKey = options.dedupKey  ?? `${client.id}:owner`;
  const opRowId  = options.opRowId   ?? null;

  if (!toPhone) {
    console.warn(`[BRIEFING] No recipient phone for ${client.id} — skipping`);
    return { success: false, reason: "no_owner_phone" };
  }

  const twilioNumber = client.twilio_number ?? client.inboundPhones?.[0] ?? null;
  if (!twilioNumber) {
    console.warn(`[BRIEFING] No twilio number for ${client.id} — skipping`);
    return { success: false, reason: "no_twilio_number" };
  }

  // No-duplicate guard. Legacy callers (no options) get the original semantics:
  // any briefing in the last 20h for this client_id blocks. Multi-phone callers
  // (options.dedupKey provided) get per-key dedup so different operators can
  // each receive their own digest at their own digest_time.
  try {
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("operator_briefings")
      .select("id, content")
      .eq("client_id", client.id)
      .in("status", ["sent", "test"])
      .gte("sent_at", since)
      .limit(50);
    const hasOptions = options.dedupKey != null;
    const alreadySent = hasOptions
      ? (recent ?? []).some((r) => (r.content ?? "").includes(`__DEDUP:${dedupKey}__`))
      : (recent?.length ?? 0) > 0;
    if (alreadySent) {
      console.log(`[BRIEFING] Already sent today for ${dedupKey} — skipping`);
      return { success: false, reason: "already_sent_today" };
    }
  } catch { /* proceed if dedup check fails */ }

  // Location scoping (P: per-employee briefings). Assigned operators get a
  // strict-filtered digest; owners / unassigned (scoped === null) see all.
  const scoped = normalizeLocations(options.locations);
  const fleets = locationsToFleets(options.locations);

  // Gather all data in parallel — operational signals + summary metrics.
  const [
    todaySlots, manifest, upcomingManifest, hotLeads, weatherSnap, revenue, upcomingRevenue, seasonRevenue, newBookings, issues,
    unpaid, missingWaivers, overlaps, highValue, duplicates, missingPhones, pacing, locationMix, unresolvedHandoffs, workOrders,
  ] = await Promise.all([
    getTodaysAvailability(client.id, supabase),
    getTodaysManifest(client.id, crmSupabase),
    getUpcomingManifest(crmSupabase, 7),
    getHotLeads(client.id, supabase, 3),
    getWeatherSnapshot(supabase, client.id),
    getWeeklyRevenueEstimate(client.id, supabase, crmSupabase),
    getUpcomingRevenue(client.id, crmSupabase, 7),
    getSeasonRevenue(client, crmSupabase, supabase),
    getNewBookingsStats(crmSupabase, supabase),
    detectOperationalIssues(client, supabase, crmSupabase),
    detectUnpaidBookings(crmSupabase),
    detectMissingWaivers(crmSupabase),
    detectOverlappingArrivals(crmSupabase),
    detectHighValueBookings(crmSupabase),
    detectDuplicateBookings(crmSupabase),
    detectMissingPhones(crmSupabase),
    detectPacingSignal(crmSupabase, supabase),
    detectLocationConcentration(crmSupabase),
    detectUnresolvedHandoffs(supabase, client.id),
    getOpenWorkOrders(crmSupabase, fleets),
  ]);

  // When scoped, filter every location-bearing array to the assigned
  // location(s). Company-wide aggregates we can't cleanly split by location
  // (collected revenue, season total, pacing, new-booking counts) are
  // suppressed for scoped operators so the digest never leaks other posts.
  let fManifest = manifest, fUpcoming = upcomingManifest, fUnpaid = unpaid,
      fWaivers = missingWaivers, fHighValue = highValue, fMissingPhones = missingPhones,
      fLocationMix = locationMix, fUpcomingRev = upcomingRevenue,
      fRevenue = revenue, fSeason = seasonRevenue, fNewBookings = newBookings, fPacing = pacing;
  if (scoped) {
    fManifest      = filterManifestByLocations(manifest, options.locations);
    fUpcoming      = filterManifestByLocations(upcomingManifest, options.locations);
    fUnpaid        = filterManifestByLocations(unpaid, options.locations);
    fWaivers       = filterManifestByLocations(missingWaivers, options.locations);
    fHighValue     = filterManifestByLocations(highValue, options.locations);
    fMissingPhones = filterManifestByLocations(missingPhones, options.locations);
    fLocationMix   = filterManifestByLocations(locationMix, options.locations);
    // Recompute upcoming revenue from the filtered manifest.
    let cents = 0, bookings = 0;
    for (const r of fUpcoming) {
      if (!/^BOT-/i.test(r.fareharbor_pk ?? "")) bookings += 1;
      cents += Number(r.receipt_total_cents ?? r.total_cents) || 0;
    }
    fUpcomingRev = { bookings, revenue_cents: cents, days: 7, source: "manifest" };
    fRevenue = null; fSeason = null; fNewBookings = null; fPacing = null;
  }

  const briefing = buildBriefingText(client, todaySlots, hotLeads, weatherSnap, {
    manifest:         fManifest,
    upcomingManifest: fUpcoming,
    upcomingRevenue:  fUpcomingRev,
    revenue:          fRevenue,
    seasonRevenue:    fSeason,
    newBookings:      fNewBookings,
    issues,
    unpaid:           fUnpaid,
    missingWaivers:   fWaivers,
    overlaps,
    highValue:        fHighValue,
    duplicates,
    missingPhones:    fMissingPhones,
    pacing:           fPacing,
    locationMix:      fLocationMix,
    unresolvedHandoffs,
    workOrders,
    digestTypes: options.digestTypes ?? ["all"],
    locations:   options.locations ?? null,
  });

  const status = process.env.TEST_MODE === "true" ? "test" : "sent";
  try {
    // Multi-phone callers stamp a dedup trailer so different operators don't
    // collide. Legacy callers (no options) persist plain content.
    const content = options.dedupKey
      ? `${briefing}\n<!-- __DEDUP:${dedupKey}__ -->`
      : briefing;
    await supabase.from("operator_briefings").insert({
      client_id: client.id,
      content,
      sent_at:   new Date().toISOString(),
      status,
    });
  } catch (err) {
    console.warn(`[BRIEFING] Could not persist briefing for ${client.id}:`, err.message);
  }

  // Stamp last_digest_sent_at on the operator_phones row, if we have one
  if (opRowId && status === "sent") {
    try {
      await supabase
        .from("operator_phones")
        .update({ last_digest_sent_at: new Date().toISOString() })
        .eq("id", opRowId);
    } catch { /* non-fatal */ }
  }

  if (process.env.TEST_MODE === "true") {
    return { success: true, preview: briefing, sent: false, chars: briefing.length, issues };
  }

  await twilioClient.messages.create({ from: twilioNumber, to: toPhone, body: briefing });
  console.log(`[BRIEFING] Sent to ${toPhone} for ${client.id} (${briefing.length} chars, ${issues.length} alerts)`);
  return { success: true, preview: briefing, sent: true, chars: briefing.length, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-TIME DIGEST WINDOW MATCHER
// Returns true if the current wall-clock time in `timezone` falls within a
// 5-minute window starting at any HH:MM in `digestTimes`. Cron fires every
// 5 min, so we accept the time and the next 4 minutes after it.
// ─────────────────────────────────────────────────────────────────────────────
export function isDigestTimeNow(digestTimes, timezone, now = new Date()) {
  if (!Array.isArray(digestTimes) || digestTimes.length === 0) return false;
  try {
    const hhmm = now.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
    const [h, m] = hhmm.split(":").map(Number);
    const nowMinutes = h * 60 + m;
    for (const slot of digestTimes) {
      const parts = String(slot).split(":");
      if (parts.length !== 2) continue;
      const sh = Number(parts[0]);
      const sm = Number(parts[1]);
      if (!Number.isFinite(sh) || !Number.isFinite(sm)) continue;
      const slotMinutes = sh * 60 + sm;
      const diff = nowMinutes - slotMinutes;
      if (diff >= 0 && diff < 5) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH OPERATOR DIGESTS
// Called once per cron tick. Fans out per-phone briefings to every operator_phones
// row whose digest_times window matches the current minute in its timezone.
//
//   • Reads operator_phones rows for all DB-backed clients where daily_digest_enabled=true
//   • Filters by isDigestTimeNow(digest_times, timezone)
//   • Loads each client config and calls generateDailyBriefing with per-phone options
//   • Falls back gracefully — if the table is empty, returns { sent: 0, skipped: 0 }
//
// Returns { sent, skipped, errors }.
// ─────────────────────────────────────────────────────────────────────────────
export async function dispatchOperatorDigests(supabase, twilioClient, crmSupabase = null, now = new Date()) {
  let rows = [];
  try {
    const { data, error } = await supabase
      .from("operator_phones")
      .select("id, client_id, phone, role, label, digest_times, digest_types, locations, timezone, daily_digest_enabled")
      .eq("daily_digest_enabled", true);
    if (error) {
      if (error.message?.includes("does not exist") || error.code === "42P01") {
        console.log("[BRIEFING] operator_phones table not found — skipping per-phone dispatch");
        return { sent: 0, skipped: 0, errors: 0 };
      }
      throw error;
    }
    rows = data ?? [];
  } catch (err) {
    console.error("[BRIEFING] dispatchOperatorDigests fetch failed:", err.message);
    return { sent: 0, skipped: 0, errors: 1 };
  }

  // Filter by current-time window
  const due = rows.filter((r) => isDigestTimeNow(r.digest_times, r.timezone ?? "America/Denver", now));
  if (!due.length) return { sent: 0, skipped: rows.length, errors: 0 };

  // Group by client_id so we load each client config once
  const byClient = due.reduce((acc, r) => {
    (acc[r.client_id] = acc[r.client_id] ?? []).push(r);
    return acc;
  }, {});

  // Look up clients
  const allClients = getAllClients();
  let sent = 0, skipped = 0, errors = 0;

  for (const [clientId, recipientRows] of Object.entries(byClient)) {
    const client = allClients[clientId];
    if (!client) {
      console.warn(`[BRIEFING] Unknown client_id ${clientId} — skipping ${recipientRows.length} digests`);
      skipped += recipientRows.length;
      continue;
    }
    for (const row of recipientRows) {
      try {
        const result = await generateDailyBriefing(client, supabase, twilioClient, crmSupabase, {
          toPhone:     row.phone,
          dedupKey:    `${clientId}:${row.id}:${row.digest_times?.find((t) => isDigestTimeNow([t], row.timezone ?? "America/Denver", now)) ?? "default"}`,
          opRowId:     row.id,
          digestTypes: row.digest_types ?? ["all"],
          locations:   row.locations ?? null,
        });
        if (result.success) sent++;
        else skipped++;
      } catch (err) {
        console.error(`[BRIEFING] Failed for ${clientId}/${row.phone}:`, err.message);
        errors++;
      }
    }
  }

  return { sent, skipped, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR COMMAND DETECTION
// Call before Claude in owner mode. Returns formatted string or null.
// ─────────────────────────────────────────────────────────────────────────────

export async function detectAndHandleOperatorCommand(message, client, supabase, crmSupabase = null, convo = null) {
  // Resolve numeric quick-reply shortcuts up front. "1"–"7" maps to a fixed
  // operator command string; we then re-enter detection with that command so
  // the existing parser path handles it (and persistence works the same way).
  const shortcut = resolveMenuShortcut(message);
  const effectiveMessage = shortcut ?? message;
  const msg = (effectiveMessage ?? "").toLowerCase().trim();
  const priorContext = convo?.bookingData?._operator ?? null;

  // Persist a successful structured intent's context onto the convo so the
  // next turn can inherit it. Mutates by reference — caller saves the convo.
  const persist = (mergedIntent) => {
    if (!convo) return;
    convo.bookingData = convo.bookingData ?? {};
    convo.bookingData._operator = extractOperatorContext(mergedIntent);
  };

  // ── Sprint B: expanded freeform handlers ─────────────────────────────────
  // LARGEST BOOKINGS — DB2 daily_manifest sorted by total_cents
  if (msg.match(/\blargest\s+bookings?\b|\bbiggest\s+bookings?\b|\btop\s+bookings?\b|\bhighest[-\s]?value\s+bookings?\b/)) {
    const range = parseDateRange(msg) ?? parseDateRange("this month");
    return await formatLargestBookings(client, crmSupabase, range);
  }

  // UNDERBOOKED ACTIVITIES — activities with low forward-booking volume
  if (msg.match(/\bunderbooked\b|\blow\s+utilization\b|\bnot\s+selling\b|\bwhich\s+tours?\s+(are\s+)?(under|low)\b/)) {
    return await formatUnderbookedActivities(client, crmSupabase);
  }

  // BUSIEST TIME TODAY
  if (msg.match(/\bbusiest\s+(time|hour|hours|window)\b|\bpeak\s+(time|hour|hours)\b|\bwhat\s+time\s+(is\s+)?busiest\b/)) {
    const range = parseDateRange(msg) ?? parseDateRange("today");
    return await formatBusiestHours(client, crmSupabase, range);
  }

  // NEEDS FOLLOW UP — leads contacted >24h ago but not converted/closed
  if (msg.match(/\bneeds?\s+follow[-\s]?up\b|\bwho\s+ha(s|sn'?t)\s+replied\s+(yet)?\b|\bfollow[-\s]?ups?\s+(needed|due|owed)\b|\bdue\s+for\s+follow[-\s]?up\b/)) {
    return await formatNeedsFollowup(client, supabase);
  }

  // FIRST-TIME GUESTS
  if (msg.match(/\bfirst[-\s]?(time|timer)s?\s+(guests?|customers?|riders?|booking)?\b|\bnew\s+(guests?|customers?)\s+(today|this\s+week|this\s+month)?\b/)) {
    const range = parseDateRange(msg) ?? parseDateRange("today");
    return await formatFirstTimers(client, crmSupabase, range);
  }

  // UNPAID — menu #7 / "unpaid", "balances due", "show me unpaid"
  if (msg === "unpaid" || msg.match(/\bunpaid\b|\bbalances?\s+due\b|\bowed\b|\bnot\s+paid\b/)) {
    const rows = await detectUnpaidBookings(crmSupabase);
    return formatUnpaidResponse(rows);
  }

  // MISSING WAIVERS — menu #8 / "waivers", "no waivers"
  if (msg === "missing waivers" || msg.match(/\bwaivers?\b/)) {
    const rows = await detectMissingWaivers(crmSupabase);
    return formatMissingWaiversResponse(rows);
  }

  // RISKS — menu #4 / "risks", "what's at risk", "problems"
  if (msg === "risks" || msg.match(/\bat\s+risk\b|\bproblems?\b|\boperational\s+risks?\b/)) {
    const [unp, waivers, overlaps, dupes, phones] = await Promise.all([
      detectUnpaidBookings(crmSupabase),
      detectMissingWaivers(crmSupabase),
      detectOverlappingArrivals(crmSupabase),
      detectDuplicateBookings(crmSupabase),
      detectMissingPhones(crmSupabase),
    ]);
    return formatRisksResponse({ unpaid: unp, waivers, overlaps, duplicates: dupes, missingPhones: phones });
  }

  // FOLLOW-UPS — menu #3 / "follow-ups", "who do I need to call"
  if (msg === "follow-ups" || msg === "followups" || msg.match(/\bfollow[-\s]?ups?\s+(due|today|now|list)?\b|\bwho\s+do\s+i\s+(need\s+to\s+)?call\b/)) {
    const [unp, hot, handoffs] = await Promise.all([
      detectUnpaidBookings(crmSupabase),
      getHotLeads(client.id, supabase, 5),
      detectUnresolvedHandoffs(supabase, client.id),
    ]);
    return formatFollowupsResponse({ unpaid: unp, hotLeads: hot, handoffs });
  }

  // OPS LOAD (menu #9) — operational issues + workload at a glance
  if (msg === "ops load" || msg === "operations" || msg === "staffing" || msg.match(/\boperational\s+load\b/)) {
    const [issues, hotLeads, todaySlots] = await Promise.all([
      detectOperationalIssues(client, supabase, crmSupabase),
      getHotLeads(client.id, supabase, 10),
      getTodaysAvailability(client.id, supabase),
    ]);
    return formatOpsLoadResponse(issues, hotLeads, todaySlots);
  }

  // UNANSWERED CONVERSATIONS (menu #7) — handoff flags + bot-paused threads
  if (msg === "unanswered" || msg === "unanswered convos" || msg === "unanswered conversations" || msg.match(/\bwho\s+ha(s|sn'?t)\s+replied\b/)) {
    return await formatUnansweredResponse(client, supabase);
  }

  // BOOKINGS TODAY — prefer real DB2 manifest; fall back to FH openings
  if (msg.match(/\bbookings?\s+(today|for today)\b/) || msg === "bookings today" || msg === "today's bookings" || msg === "todays bookings") {
    persist({ intent: "bookings_by_date", date_range: parseDateRange("today"), metric: "bookings" });
    const manifest = await getTodaysManifest(client.id, crmSupabase);
    if (manifest.length || crmSupabase) return formatManifestResponse(manifest, "today");
    const slots = await getTodaysAvailability(client.id, supabase);
    return formatBookingsResponse(slots, "today");
  }

  // BOOKINGS TOMORROW — same pattern
  if (msg.match(/\bbookings?\s+(tomorrow|for tomorrow)\b/) || msg === "bookings tomorrow") {
    persist({ intent: "bookings_by_date", date_range: parseDateRange("tomorrow"), metric: "bookings" });
    if (crmSupabase) {
      try {
        const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + 1);
        const end   = new Date(start); end.setDate(end.getDate() + 1);
        const { data } = await crmSupabase
          .from("daily_manifest")
          .select(MANIFEST_SELECT)
          .gte("start_at", start.toISOString())
          .lt("start_at", end.toISOString())
          .order("start_at", { ascending: true });
        const normalized = (data ?? []).map(normalizeManifestRow);
        const enriched   = await enrichManifestRows(normalized, crmSupabase);
        return formatManifestResponse(enriched, "tomorrow");
      } catch { /* fall through */ }
    }
    const slots = await getTomorrowsAvailability(client.id, supabase);
    return formatBookingsResponse(slots, "tomorrow");
  }

  // LEADS / MY LEADS
  if (msg.match(/^leads?$/) || msg.match(/\bmy\s+leads?\b/) || msg.match(/^show\s+(me\s+)?leads?$/)) {
    const leads = await getHotLeads(client.id, supabase, 5);
    return formatLeadsResponse(leads, "Hot Leads");
  }

  // NEW LEADS
  if (msg.match(/\bnew\s+leads?\b/) || msg.match(/\brecent\s+leads?\b/)) {
    const leads = await getRecentLeads(client.id, supabase, 24);
    return formatLeadsResponse(leads, "New Leads (24h)");
  }

  // WEATHER / CONDITIONS
  if (msg.match(/^weather$/) || msg.match(/\bconditions?\b/) || msg.match(/^snow$/)) {
    const snap = await getWeatherSnapshot(supabase, client.id);
    return formatWeatherResponse(snap);
  }

  // REVENUE / EARNINGS — only intercept bare revenue (no date range, no
  // inheritable prior context). Date-specific queries ("revenue in Feb 2026",
  // "revenue this winter") and follow-ups ("and revenue?") fall through to the
  // structured parser which routes them to the full DB aggregation engine.
  if ((msg.match(/\brevenue\b/) || msg.match(/\brev\b/) || msg.match(/\bearnings?\b/)) && !msg.match(/\bbookings?\b/)) {
    const hasDateRange = !!(parseDateRange(msg) ?? parseSeasonRange(msg, client?.seasonConfig));
    const hasPriorRange = !!priorContext?.date_range;
    if (!hasDateRange && !hasPriorRange) {
      const rev = await getWeeklyRevenueEstimate(client.id, supabase, crmSupabase);
      return formatRevenueResponse(rev);
    }
    // Has date range (current or inherited) → fall through to structured intent routing below
  }

  // ── Structured intent parser (date-aware, action-routed) ──────────────────
  const rawIntent = detectOperatorIntent(message, client?.seasonConfig);
  const intent    = mergeOperatorContext(rawIntent, message, priorContext);
  const integrations = buildIntegrations({ supabase, crmSupabase, client });

  if (intent.intent === "help") {
    return formatHelpResponse();
  }

  if (intent.intent === "flag_issue") {
    const description = stripFlagKeywords(message);
    const res = await executeAction({
      action:       "flag_issue",
      data:         { description },
      context:      {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? "Got it — I’ll flag that for review.";
  }

  if (intent.intent === "daily_summary") {
    const res = await executeAction({
      action:       "daily_summary",
      data:         {},
      context:      {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? "Couldn't build daily summary right now.";
  }

  if ((intent.intent === "bookings_by_date" || intent.intent === "revenue") && intent.date_range) {
    const res = await executeAction({
      action:  "get_bookings_by_date_range",
      data:    {
        date_range:      intent.date_range,
        metric:          intent.metric          ?? "bookings",
        company_filter:  intent.company_filter  ?? null,
        location_filter: intent.location_filter ?? null,
        list_mode:       intent.list_mode       ?? false,
      },
      context: {},
      client,
      integrations,
    });
    persist(intent);
    return res.ownerReply ?? res.fallbackMessage ?? "Couldn't retrieve bookings.";
  }

  if (intent.intent === "report") {
    const res = await executeAction({
      action:       "report",
      data:         { date_range: intent.date_range, metric: intent.metric, group_by: intent.group_by },
      context:      {},
      client,
      integrations,
    });
    persist(intent);
    return res.ownerReply ?? res.fallbackMessage ?? "Couldn't generate report right now.";
  }

  if (intent.intent === "performance") {
    const res = await executeAction({
      action:       "analyze_performance",
      data:         {},
      context:      {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? null;
  }

  if (intent.intent === "missed_leads") {
    const res = await executeAction({
      action:       "get_missed_leads",
      data:         {},
      context:      {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? null;
  }

  if (intent.intent === "campaigns") {
    const res = await executeAction({
      action:       "get_campaign_stats",
      data:         {},
      context:      {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? null;
  }

  if (intent.intent === "import_booking") {
    const res = await executeAction({
      action:  "import_booking",
      data:    { raw: message },
      context: {},
      client,
      integrations,
    });
    return res.ownerReply ?? res.fallbackMessage ?? "Booking import failed — check format.";
  }

  // No deterministic match → return null so the orchestrator can fall through
  // to Claude. Claude is always cheaper than confusion.
  return null;
}

function formatHelpResponse() {
  return [
    "Reply 1-7 or ask anything:",
    "1 Today's manifest  5 Weather",
    "2 Revenue           6 Tomorrow outlook",
    "3 Open leads        7 Unanswered convos",
    "4 Ops load",
    "",
    "Other things you can ask:",
    "• largest bookings this month",
    "• who needs follow up",
    "• which tours are underbooked",
    "• first-time guests this week",
    "• busiest time today",
    "• bookings in Feb 2026 / by location",
    "• revenue this winter",
    "• flag <issue>",
  ].join("\n");
}

function stripFlagKeywords(message) {
  if (!message) return "";
  return message
    .replace(/^\s*(please\s+)?(flag|log|report)\s+(an?\s+)?(issue|problem|bug)?\s*[:\-]?\s*/i, "")
    .replace(/^\s*flag\s*[:\-]?\s*/i, "")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE FORMATTERS
// ─────────────────────────────────────────────────────────────────────────────

// Dispatch-style manifest — groups bookings by morning/midday/afternoon
// time blocks, names the vehicle + location per line, and surfaces RETURN
// FLOW (full-day + multi-day still out) and WATCHOUTS (incomplete waivers,
// unpaid balances, missing phones). This is the "morning dispatch sheet"
// the operator should be able to read in 15 seconds.
export function formatManifestResponse(rows, day) {
  const dayLabel = day === "today" ? "TODAY" : "TOMORROW";
  if (!Array.isArray(rows) || rows.length === 0) {
    return `🏁 ${dayLabel}'S MANIFEST\n\nNothing on the manifest yet — quiet ${day === "today" ? "day" : "tomorrow"} so far.`;
  }
  const snap = buildTodayLoadSnapshot(rows);

  const pax   = snap.totals.pax;
  const cents = snap.totals.revenue_cents;
  const lines = [`🏁 ${dayLabel}'S MANIFEST`];
  lines.push(`${rows.length} booking${rows.length !== 1 ? "s" : ""} · ${pax} guest${pax !== 1 ? "s" : ""} · $${Math.round(cents / 100).toLocaleString()}`);

  // ── Group by time block, list pickups ────────────────────────────────────
  const byBlock = { morning: [], midday: [], afternoon: [], evening: [], unknown: [] };
  for (const r of rows) byBlock[timeBlock(r.start_at)].push(r);

  const blockLabel = {
    morning:   "Morning (before 10 AM)",
    midday:    "Midday (10 AM – 1 PM)",
    afternoon: "Afternoon (1 – 5 PM)",
    evening:   "Evening (after 5 PM)",
    unknown:   "Unscheduled",
  };

  for (const key of ["morning", "midday", "afternoon", "evening", "unknown"]) {
    const block = byBlock[key];
    if (!block.length) continue;
    lines.push("");
    lines.push(blockLabel[key]);
    for (const r of block.slice(0, 6)) {
      const time  = formatMTTimeFromNaive(r.start_at);
      // Prefer MPWR-synced vehicle ("RZR PRO S4", "Ranger XP General") when
      // available — it's the actual booked asset. Fall back to the activity
      // classifier for legacy bookings without enrichment.
      const cls   = classifyActivity(r.activity);
      const label = r.vehicle ?? cls.short_label;
      const loc   = capLocation(r.location);
      const first = (r.customer_name ?? "?").split(" ")[0];
      const phone = shortPhone(r.phone);
      lines.push(`• ${time} — ${label} · ${loc} · ${first} (${r.pax ?? r.customer_count ?? "?"}p) · ${phone}`);
    }
    if (block.length > 6) lines.push(`  …+${block.length - 6} more`);
  }

  // ── Return flow — full-day + multi-day still out after 5pm ──────────────
  if (snap.late_returns.length) {
    lines.push("");
    lines.push("↩ RETURN FLOW");
    for (const r of snap.late_returns.slice(0, 4)) {
      const cls  = classifyActivity(r.activity);
      // arrival_display contains the return time in wall-clock format.
      const endHour = endHourFromArrival(r.arrival_display);
      let timeStr = "late";
      if (Number.isFinite(endHour)) {
        const ampm = endHour >= 12 ? "PM" : "AM";
        const h12 = endHour % 12 || 12;
        timeStr = `${h12} ${ampm}`;
      }
      const first = (r.customer_name ?? "?").split(" ")[0];
      lines.push(`• ${timeStr} return — ${cls.short_label} · ${first}`);
    }
  }
  if (snap.duration_mix.multi_day > 0 || snap.duration_mix.overnight > 0) {
    const overnightCount = (snap.duration_mix.overnight ?? 0) + (snap.duration_mix.multi_day ?? 0);
    lines.push(`• ${overnightCount} overnight/multi-day rental${overnightCount !== 1 ? "s" : ""} still out`);
  }

  // ── Watchouts — actionable risks for this manifest ──────────────────────
  const watch = [];
  if (snap.totals.missing_waivers > 0) {
    watch.push(`${snap.totals.missing_waivers} waiver${snap.totals.missing_waivers !== 1 ? "s" : ""} incomplete`);
  }
  if (snap.totals.unpaid_cents > 0) {
    watch.push(`$${Math.round(snap.totals.unpaid_cents / 100).toLocaleString()} unpaid balance remaining`);
  }
  const missingPhones = rows.filter((r) => !r.phone && !r.normalized_phone).length;
  if (missingPhones > 0) {
    watch.push(`${missingPhones} booking${missingPhones !== 1 ? "s" : ""} missing phone #`);
  }
  if (watch.length) {
    lines.push("");
    lines.push("⚠ WATCHOUTS");
    for (const w of watch) lines.push(`• ${w}`);
  }

  return lines.join("\n");
}

function formatBookingsResponse(slots, day) {
  if (!slots.length) return `No available slots for ${day} found in cache. Check FareHarbor directly.`;
  const lines = [`Available ${day}:`];
  for (const s of slots.slice(0, 5)) {
    lines.push(`• ${s.time} — ${s.name}`);
  }
  if (slots.length > 5) lines.push(`...and ${slots.length - 5} more. Check FareHarbor for full schedule.`);
  return lines.join("\n");
}

function formatLeadsResponse(leads, label) {
  if (!leads.length) return `${label}: No open leads.`;
  const lines = [`${label}:`];
  for (const l of leads) {
    const name  = (l.name ?? "Unknown").split(" ")[0];
    const svc   = l.service ?? "N/A";
    lines.push(`• ${name} — ${svc} [${l.status}]`);
  }
  return lines.join("\n");
}

function formatWeatherResponse(snap) {
  if (!snap) return "No weather data cached. Check back after the next refresh (every hour).";
  const lines = [];
  const emitted = new Set(); // track names to skip duplicates
  const emit = (label, text) => {
    const key = label.toLowerCase().replace(/\s+/g, "");
    if (emitted.has(key)) return;
    emitted.add(key);
    lines.push(text);
  };

  const w = snap.weather;
  const s = snap.snow;

  if (w?.steamboat) {
    const sb = w.steamboat;
    emit("steamboat", `Steamboat: ${sb.temp}°F, ${sb.desc}, wind ${sb.wind_mph}mph`);
  }
  if (w?.rabbit_ears_pass) {
    const rp = w.rabbit_ears_pass;
    emit("rabbitears", `Rabbit Ears Pass: ${rp.temp}°F, ${rp.desc}`);
  }
  if (w?.kremmling) {
    const kr = w.kremmling;
    emit("kremmling", `Kremmling: ${kr.temp}°F, ${kr.desc}`);
  }
  // Custom per-client locations — skip any that duplicate a global entry
  for (const loc of (snap.custom_locations ?? [])) {
    emit(loc.name, `${loc.name}: ${loc.temp}°F, ${loc.desc}`);
  }

  if (s?.stations) {
    for (const st of Object.values(s.stations).slice(0, 2)) {
      const depth = st.snow_depth_in != null ? `${st.snow_depth_in}" snow` : "N/A";
      lines.push(`${st.name}: ${depth}`);
    }
  }
  if (s?.avalanche_danger) {
    lines.push(`Avalanche: ${s.avalanche_danger.split("|")[0].trim()}`);
  }

  const updatedAt = snap.fetched_at
    ? `Updated: ${new Date(snap.fetched_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" })} MT`
    : "";
  if (updatedAt) lines.push(updatedAt);

  return lines.join("\n") || "No conditions data available.";
}

function formatRevenueResponse(rev) {
  if (rev.source === "manifest") {
    return `Revenue (${rev.period}): $${rev.estimated.toLocaleString()} across ${rev.bookings} booking${rev.bookings !== 1 ? "s" : ""} (FareHarbor).`;
  }
  return `Est. revenue (${rev.period}): $${rev.estimated.toLocaleString()} (~${rev.bookings} converted leads × $175 avg).\nFor exact figures, check FareHarbor reports.`;
}

// Formatter — unpaid bookings list with per-booking dollar amount + date.
export function formatUnpaidResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "UNPAID BOOKINGS\n\nNothing unpaid — every booking is square.";
  }
  const total = rows.reduce((s, r) => s + (Number(r.balance_due_cents) || 0), 0);
  const lines = [`UNPAID BOOKINGS — ${rows.length} totaling $${Math.round(total / 100).toLocaleString()}`, ""];
  for (const r of rows.slice(0, 8)) {
    const name = (r.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    const dol  = `$${Math.round((r.balance_due_cents ?? 0) / 100).toLocaleString()}`;
    const date = formatMTDateFromNaive(r.start_at, { month: "short", day: "numeric" });
    const act  = compactActivity(r.activity).slice(0, 22);
    lines.push(`• ${name} — ${dol} (${date}, ${act})`);
  }
  return lines.join("\n");
}

// Formatter — missing waivers, prioritized by arrival proximity.
export function formatMissingWaiversResponse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "MISSING WAIVERS\n\nAll upcoming guests have waivers on file.";
  }
  const arrivingToday = rows.filter((r) => isToday(r.start_at));
  const lines = [`MISSING WAIVERS — ${rows.length} guest${rows.length !== 1 ? "s" : ""}${arrivingToday.length ? `, ${arrivingToday.length} arriving today` : ""}`, ""];
  for (const r of rows.slice(0, 8)) {
    const name = (r.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
    const date = formatMTDateFromNaive(r.start_at, { month: "short", day: "numeric" });
    const time = formatMTTimeFromNaive(r.start_at);
    lines.push(`• ${name} — ${date} ${time} (${r.pax ?? r.customer_count ?? "?"}p, ${capLocation(r.location)})`);
  }
  return lines.join("\n");
}

// Formatter — operational risks summary (combines multiple signals).
export function formatRisksResponse({ unpaid, waivers, overlaps, duplicates, missingPhones }) {
  const lines = ["OPERATIONAL RISKS"];
  let hadAny = false;

  if (unpaid?.length) {
    hadAny = true;
    const total = unpaid.reduce((s, r) => s + (Number(r.balance_due_cents) || 0), 0);
    lines.push("");
    lines.push(`💸 ${unpaid.length} unpaid booking${unpaid.length !== 1 ? "s" : ""} — $${Math.round(total / 100).toLocaleString()} due`);
    const top = unpaid[0];
    lines.push(`  Biggest: ${(top.customer_name ?? "?").split(" ").slice(0,2).join(" ")} $${Math.round((top.balance_due_cents ?? 0)/100).toLocaleString()}`);
  }
  if (waivers?.length) {
    hadAny = true;
    const arrivingToday = waivers.filter((r) => isToday(r.start_at)).length;
    lines.push("");
    lines.push(`📝 ${waivers.length} guest${waivers.length !== 1 ? "s" : ""} missing waivers${arrivingToday ? ` (${arrivingToday} today)` : ""}`);
  }
  if (overlaps?.length) {
    hadAny = true;
    const o = overlaps[0];
    lines.push("");
    lines.push(`⏰ ${o.count} arrivals overlap at ${o.hour_label}`);
  }
  if (missingPhones?.length) {
    hadAny = true;
    lines.push("");
    lines.push(`📞 ${missingPhones.length} booking${missingPhones.length !== 1 ? "s" : ""} missing phone numbers`);
  }
  if (duplicates?.length) {
    hadAny = true;
    lines.push("");
    lines.push(`🔁 ${duplicates.length} duplicate BOT-/CO- reservation${duplicates.length !== 1 ? "s" : ""}`);
  }
  if (!hadAny) {
    return "OPERATIONAL RISKS\n\nNothing flagged — operations look clean.";
  }
  return lines.join("\n");
}

// Formatter — combined follow-up list (unpaid calls, hot leads, handoffs).
export function formatFollowupsResponse({ unpaid, hotLeads, handoffs }) {
  const lines = ["FOLLOW-UPS"];
  let hadAny = false;

  if (unpaid?.length) {
    hadAny = true;
    lines.push("");
    lines.push("💸 Unpaid (call to collect)");
    for (const r of unpaid.slice(0, 3)) {
      const name = (r.customer_name ?? "?").split(" ").slice(0, 2).join(" ");
      const dol  = `$${Math.round((r.balance_due_cents ?? 0) / 100).toLocaleString()}`;
      const date = formatMTDateFromNaive(r.start_at, { month: "short", day: "numeric" });
      lines.push(`• ${name} — ${dol} before ${date}`);
    }
  }
  if (hotLeads?.length) {
    hadAny = true;
    lines.push("");
    lines.push("🔥 Hot leads");
    for (const lead of hotLeads.slice(0, 3)) {
      const name = (lead.name ?? "Unknown").split(" ")[0];
      lines.push(`• ${name} — ${lead.service ?? "n/a"} (${lead.status})`);
    }
  }
  if (handoffs?.length) {
    hadAny = true;
    lines.push("");
    lines.push("🤝 Unresolved handoffs");
    for (const h of handoffs.slice(0, 2)) {
      const last  = Array.isArray(h.messages) ? h.messages[h.messages.length - 1] : null;
      const body  = (last?.content ?? "").slice(0, 50);
      const phone = (h.from_number ?? "").replace(/^\+1/, "");
      lines.push(`• ${phone}: "${body}…"`);
    }
  }
  if (!hadAny) {
    return "FOLLOW-UPS\n\nNothing waiting on you.";
  }
  return lines.join("\n");
}

// Compact "operations load" snapshot — combines staffing pressure signals.
export function formatOpsLoadResponse(issues, hotLeads, todaySlots) {
  const lines = [];
  lines.push(`OPS LOAD`);
  lines.push("");
  lines.push(`Today: ${todaySlots.length} booking${todaySlots.length !== 1 ? "s" : ""} on the manifest.`);
  lines.push(`Open leads: ${hotLeads.length} hot.`);

  if (issues.length === 0) {
    lines.push("");
    lines.push("No operational alerts.");
  } else {
    lines.push("");
    lines.push(`Alerts (${issues.length}):`);
    for (const issue of issues.slice(0, 5)) {
      lines.push(`! ${issue}`);
    }
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint B: expanded freeform operator handlers
// All handlers are graceful — DB unavailable returns a clean "couldn't pull
// X right now" message rather than throwing.
// ─────────────────────────────────────────────────────────────────────────────

const DOLLARS = (cents) => `$${Math.round((Number(cents) || 0) / 100).toLocaleString()}`;

export async function formatLargestBookings(client, crmSupabase, range) {
  if (!crmSupabase || !range) {
    return "LARGEST BOOKINGS\n\nCRM data not connected — can't pull this right now.";
  }
  try {
    const { data, error } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, start_at, pax, receipt_total_cents, location, company")
      .gte("start_at", range.start)
      .lt("start_at", range.end)
      .order("receipt_total_cents", { ascending: false })
      .limit(5);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return `LARGEST BOOKINGS (${range.label ?? "range"})\n\nNo bookings found in this window.`;
    const lines = [`LARGEST BOOKINGS (${range.label ?? "range"})`, ""];
    for (const r of rows) {
      const date = r.start_at?.slice(0, 10) ?? "?";
      lines.push(`• ${DOLLARS(r.receipt_total_cents)} — ${r.customer_name ?? "?"} (${r.pax ?? "?"} pax, ${r.activity ?? "?"}) ${date}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatLargestBookings failed:`, err.message);
    return "LARGEST BOOKINGS\n\nCouldn't pull biggest bookings right now.";
  }
}

export async function formatUnderbookedActivities(client, crmSupabase) {
  if (!crmSupabase) {
    return "UNDERBOOKED TOURS\n\nCRM data not connected — can't pull this right now.";
  }
  try {
    const startISO = new Date().toISOString();
    const endISO   = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await crmSupabase
      .from("daily_manifest")
      .select("activity, fareharbor_pk")
      .gte("start_at", startISO)
      .lt("start_at", endISO);
    if (error) throw error;
    const rows = data ?? [];
    // Group by activity, count distinct bookings
    const byActivity = new Map();
    for (const r of rows) {
      if (!r.activity) continue;
      const key = r.activity;
      if (!byActivity.has(key)) byActivity.set(key, new Set());
      byActivity.get(key).add(r.fareharbor_pk ?? Math.random());
    }
    const sorted = [...byActivity.entries()]
      .map(([activity, set]) => ({ activity, count: set.size }))
      .sort((a, b) => a.count - b.count)
      .slice(0, 5);
    if (!sorted.length) {
      return "UNDERBOOKED TOURS\n\nNo upcoming bookings in the next 14 days — every tour is underbooked.";
    }
    const lines = ["UNDERBOOKED TOURS (next 14 days)", ""];
    for (const r of sorted) {
      lines.push(`• ${r.activity}: ${r.count} booking${r.count !== 1 ? "s" : ""}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatUnderbookedActivities failed:`, err.message);
    return "UNDERBOOKED TOURS\n\nCouldn't pull utilization right now.";
  }
}

export async function formatBusiestHours(client, crmSupabase, range) {
  if (!crmSupabase || !range) {
    return "BUSIEST TIME\n\nCRM data not connected — can't pull this right now.";
  }
  try {
    const { data, error } = await crmSupabase
      .from("daily_manifest")
      .select("start_at, pax")
      .gte("start_at", range.start)
      .lt("start_at", range.end);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return `BUSIEST TIME (${range.label ?? "today"})\n\nNo bookings in this window.`;
    // Group by hour-of-day (MT)
    const byHour = new Map();
    for (const r of rows) {
      if (!r.start_at) continue;
      const hour = hourFromNaive(r.start_at);
      if (!Number.isFinite(hour)) continue;
      const cur = byHour.get(hour) ?? { bookings: 0, pax: 0 };
      cur.bookings += 1;
      cur.pax += Number(r.pax) || 0;
      byHour.set(hour, cur);
    }
    const top = [...byHour.entries()]
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 3);
    const lines = [`BUSIEST TIME (${range.label ?? "today"})`, ""];
    for (const t of top) {
      const ampm = t.hour === 0 ? "12am" : t.hour < 12 ? `${t.hour}am` : t.hour === 12 ? "12pm" : `${t.hour - 12}pm`;
      lines.push(`• ${ampm}: ${t.bookings} booking${t.bookings !== 1 ? "s" : ""} (${t.pax} guests)`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatBusiestHours failed:`, err.message);
    return "BUSIEST TIME\n\nCouldn't pull peak-hour data right now.";
  }
}

export async function formatNeedsFollowup(client, supabase) {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("leads")
      .select("name, phone, service, status, last_contacted_at, created_at")
      .eq("client_id", client.id)
      .in("status", ["contacted", "engaged"])
      .or(`last_contacted_at.lte.${cutoff},last_contacted_at.is.null`)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return "FOLLOW-UPS DUE\n\nNo leads waiting on a follow-up.";
    const lines = [`FOLLOW-UPS DUE (${rows.length})`, ""];
    for (const r of rows.slice(0, 5)) {
      const ageH = r.last_contacted_at ? Math.round((Date.now() - new Date(r.last_contacted_at).getTime()) / 36e5) : null;
      const ageStr = ageH != null ? `${ageH}h since contact` : "never contacted";
      const firstName = (r.name ?? "Unknown").split(" ")[0];
      lines.push(`• ${firstName} — ${r.service ?? "n/a"} (${ageStr})`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatNeedsFollowup failed:`, err.message);
    return "FOLLOW-UPS DUE\n\nCouldn't pull follow-up list right now.";
  }
}

export async function formatFirstTimers(client, crmSupabase, range) {
  if (!crmSupabase || !range) {
    return "FIRST-TIME GUESTS\n\nCRM data not connected — can't pull this right now.";
  }
  try {
    // Pull bookings in range with customer info
    const { data: scoped, error } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, phone, activity, start_at, pax")
      .gte("start_at", range.start)
      .lt("start_at", range.end);
    if (error) throw error;
    const rows = scoped ?? [];
    if (!rows.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo bookings in this window.`;

    // For each unique phone in scope, count their TOTAL bookings (any time).
    // A phone with exactly 1 booking total = first-timer.
    const phones = [...new Set(rows.map((r) => r.phone).filter(Boolean))];
    if (!phones.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo phone-keyed bookings in this window.`;

    const { data: allByPhone } = await crmSupabase
      .from("daily_manifest")
      .select("phone")
      .in("phone", phones);
    const countByPhone = new Map();
    for (const r of allByPhone ?? []) {
      countByPhone.set(r.phone, (countByPhone.get(r.phone) ?? 0) + 1);
    }
    const firstTimers = rows.filter((r) => (countByPhone.get(r.phone) ?? 0) <= 1);
    if (!firstTimers.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo first-timers — everyone has booked before.`;
    const lines = [`FIRST-TIME GUESTS (${range.label ?? "range"}) — ${firstTimers.length}`, ""];
    for (const r of firstTimers.slice(0, 5)) {
      const time = formatMTTimeFromNaive(r.start_at);
      const firstName = (r.customer_name ?? "Unknown").split(" ")[0];
      lines.push(`• ${firstName} — ${compactActivity(r.activity)} ${time} (${r.pax ?? "?"} pax)`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatFirstTimers failed:`, err.message);
    return "FIRST-TIME GUESTS\n\nCouldn't pull guest history right now.";
  }
}

// Surfaces conversations that need an operator response — handoff flag set
// and/or bot paused. Reads DB1 conversations; falls back gracefully if the
// column isn't present.
export async function formatUnansweredResponse(client, supabase) {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("from_number, handoff, bot_paused, updated_at, messages")
      .eq("client_id", client.id)
      .or("handoff.eq.true,bot_paused.eq.true")
      .order("updated_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) {
      return "UNANSWERED CONVOS\n\nAll conversations are resolved — nothing waiting on you.";
    }
    const lines = [`UNANSWERED CONVOS (${rows.length})`, ""];
    for (const r of rows.slice(0, 5)) {
      const last = Array.isArray(r.messages) ? r.messages[r.messages.length - 1] : null;
      const lastBody = (last?.content ?? "").slice(0, 60);
      const flag = r.handoff ? "handoff" : "paused";
      const phone = (r.from_number ?? "").replace(/^\+1/, "");
      lines.push(`• ${phone} [${flag}]: ${lastBody}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn(`[OPERATOR] formatUnansweredResponse failed:`, err.message);
    return "UNANSWERED CONVOS\n\nCouldn't pull conversation status right now.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL API DATA — used by GET /portal/api/operator
// ─────────────────────────────────────────────────────────────────────────────

export async function buildOperatorApiData(clientId, supabase, crmSupabase = null) {
  // Bookings come from DB2 daily_manifest (real bookings) when available;
  // fall back to FH availability KB only if no CRM is configured.
  const [manifest, todaySlots, hotLeads, weatherSnap, fhRows] = await Promise.all([
    getTodaysManifest(clientId, crmSupabase),
    crmSupabase ? Promise.resolve([]) : getTodaysAvailability(clientId, supabase),
    getHotLeads(clientId, supabase, 10),
    getWeatherSnapshot(supabase, clientId),
    getFhDataForClient(clientId, supabase),
  ]);

  const kbSyncedAt = fhRows.reduce((latest, row) => {
    if (!row.fetched_at) return latest;
    return !latest || row.fetched_at > latest ? row.fetched_at : latest;
  }, null);

  // Normalize manifest rows into the same shape the portal expects from
  // todaySlots — { time, name, capacity, pk } — so the Operations view UI
  // doesn't need to know which source it's reading from.
  const bookings = manifest.length
    ? manifest.map((r) => ({
        time:          formatMTTimeFromNaive(r.start_at),
        name:          `${r.customer_name ?? "?"} — ${compactActivity(r.activity)}`,
        capacity:      r.pax ?? r.customer_count ?? null,
        pk:            r.fareharbor_pk,
        revenue_cents: r.receipt_total_cents ?? r.total_cents ?? null,
        location:      capLocation(r.location),
        source:        "manifest",
      }))
    : todaySlots.map((s) => ({ ...s, source: "fh_kb" }));

  return {
    bookings,
    bookings_source: manifest.length ? "manifest" : (crmSupabase ? "manifest_empty" : "fh_kb"),
    hot_leads:    hotLeads,
    weather:      weatherSnap,
    kb_synced_at: kbSyncedAt,
    date:         todayMT(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR LIVE SNAPSHOT
// Compact text block injected into the system prompt for owner-mode Claude
// fallbacks. Grounds freeform questions in current DB2 numbers so Claude
// stops refusing or hallucinating. Pulls per-message; cap ~600 chars.
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_CHAR_BUDGET = 1200;

function fmtMoney(cents) {
  const dollars = Math.round((Number(cents) || 0) / 100);
  return "$" + dollars.toLocaleString();
}

function isoNDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function isoNDaysAhead(n) {
  return new Date(Date.now() + n * 86400000).toISOString();
}

// Sum bookings + revenue_cents in a date window from DB2 daily_manifest.
// Filters out BOT- placeholders so we don't double-count synthetic rows.
async function sumWindow(crmSupabase, startISO, endISO) {
  if (!crmSupabase) return { bookings: 0, revenue_cents: 0 };
  try {
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, receipt_total_cents, total")
      .gte("start_at", startISO)
      .lt("start_at", endISO);
    let cents = 0, bookings = 0;
    for (const r of data ?? []) {
      if (/^BOT-/i.test(r.fareharbor_pk ?? "")) continue;
      bookings += 1;
      if (r.receipt_total_cents != null) cents += Number(r.receipt_total_cents) || 0;
      else if (r.total != null)          cents += (Number(r.total) || 0) * 100;
    }
    return { bookings, revenue_cents: cents };
  } catch { return { bookings: 0, revenue_cents: 0 }; }
}

// Top-N location breakdown from DB2 bookings (uses the new `location` column
// populated by mpwrSync). Returns { location: count } sorted desc.
async function topLocationsRecent(crmSupabase, days = 7) {
  if (!crmSupabase) return [];
  try {
    const { data } = await crmSupabase
      .from("bookings")
      .select("location")
      .gte("start_at", isoNDaysAgo(0))
      .lt("start_at", isoNDaysAhead(days))
      .not("location", "is", null)
      .not("fareharbor_pk", "ilike", "BOT-%");
    const counts = new Map();
    for (const r of data ?? []) counts.set(r.location, (counts.get(r.location) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  } catch { return []; }
}

// Open-issue counts (missing waivers, unpaid balances) from DB2 daily_manifest.
async function getOpenIssues(crmSupabase, days = 7) {
  if (!crmSupabase) return { missing_waivers: 0, unpaid_count: 0, unpaid_cents: 0 };
  try {
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, waiver_signed, balance_due_cents, due")
      .gte("start_at", isoNDaysAgo(0))
      .lt("start_at", isoNDaysAhead(days));
    let waivers = 0, unpaidN = 0, unpaidC = 0;
    for (const r of data ?? []) {
      if (/^BOT-/i.test(r.fareharbor_pk ?? "")) continue;
      if (r.waiver_signed === false) waivers += 1;
      const dueC = r.balance_due_cents ?? (r.due != null ? Number(r.due) * 100 : 0);
      if (dueC > 0) { unpaidN += 1; unpaidC += dueC; }
    }
    return { missing_waivers: waivers, unpaid_count: unpaidN, unpaid_cents: unpaidC };
  } catch { return { missing_waivers: 0, unpaid_count: 0, unpaid_cents: 0 }; }
}

// Build the live snapshot text block. Runs all queries in parallel.
// Returns a compact, readable string suitable for system prompt injection.
export async function buildOperatorSnapshot(client, supabase, crmSupabase) {
  const now      = new Date();
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const endToday   = new Date(startToday); endToday.setDate(endToday.getDate() + 1);
  const startThisWeek = new Date(startToday); startThisWeek.setDate(startThisWeek.getDate() - 7);
  const startLastWeek = new Date(startThisWeek); startLastWeek.setDate(startLastWeek.getDate() - 7);

  const [todayManifest, thisWeek, lastWeek, next7d, topLocs, issues, hotLeads, recentLeads] = await Promise.all([
    getTodaysManifest(client?.id, crmSupabase),
    sumWindow(crmSupabase, startThisWeek.toISOString(), startToday.toISOString()),
    sumWindow(crmSupabase, startLastWeek.toISOString(), startThisWeek.toISOString()),
    getUpcomingRevenue(client?.id, crmSupabase, 7),
    topLocationsRecent(crmSupabase, 7),
    getOpenIssues(crmSupabase, 7),
    getHotLeads(client?.id, supabase, 3).catch(() => []),
    getRecentLeads(client?.id, supabase, 24).catch(() => []),
  ]);

  const lines = [];
  lines.push(`LIVE BUSINESS SNAPSHOT (${now.toLocaleString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} MT)`);

  // TODAY
  let todayCents = 0, todayPax = 0;
  for (const r of todayManifest) {
    if (/^BOT-/i.test(r.fareharbor_pk ?? "")) continue;
    todayCents += Number(r.receipt_total_cents) || 0;
    todayPax   += Number(r.pax ?? r.customer_count) || 0;
  }
  const todayN = todayManifest.filter(r => !/^BOT-/i.test(r.fareharbor_pk ?? "")).length;
  const todayPreview = todayManifest.slice(0, 3).map(r => {
    const first = (r.customer_name ?? "?").split(" ")[0];
    const time  = formatMTTimeFromNaive(r.start_at);
    const veh   = r.vehicle ?? classifyActivity(r.activity).short_label;
    return `${first} ${time} ${capLocation(r.location)} ${veh}`;
  }).join(" · ");
  lines.push(`TODAY: ${todayN} bookings · ${todayPax} guests · ${fmtMoney(todayCents)}${todayPreview ? " — " + todayPreview : ""}`);

  // WEEK-OVER-WEEK
  const trend = thisWeek.revenue_cents > lastWeek.revenue_cents ? "↑" : thisWeek.revenue_cents < lastWeek.revenue_cents ? "↓" : "→";
  lines.push(`LAST 7D: ${thisWeek.bookings} bookings · ${fmtMoney(thisWeek.revenue_cents)} (prior 7d: ${lastWeek.bookings} · ${fmtMoney(lastWeek.revenue_cents)}) ${trend}`);

  // PIPELINE
  lines.push(`NEXT 7D PIPELINE: ${next7d.bookings} bookings · ${fmtMoney(next7d.revenue_cents)}`);

  // TOP LOCATIONS
  if (topLocs.length) {
    lines.push(`TOP LOCATIONS (next 7d): ${topLocs.map(([loc, n]) => `${capLocation(loc)} ${n}`).join(", ")}`);
  }

  // OPEN ISSUES
  const issueBits = [];
  if (issues.missing_waivers > 0) issueBits.push(`${issues.missing_waivers} missing waiver${issues.missing_waivers !== 1 ? "s" : ""}`);
  if (issues.unpaid_count    > 0) issueBits.push(`${fmtMoney(issues.unpaid_cents)} unpaid (${issues.unpaid_count})`);
  if (issueBits.length) lines.push(`OPEN ISSUES: ${issueBits.join(" · ")}`);

  // LEADS
  if (recentLeads.length || hotLeads.length) {
    lines.push(`LEADS: ${recentLeads.length} in 24h, ${hotLeads.length} hot`);
  }

  let out = lines.join("\n");
  if (out.length > SNAPSHOT_CHAR_BUDGET) out = out.slice(0, SNAPSHOT_CHAR_BUDGET - 1) + "…";
  return out;
}

// Detect "FirstName LastName" sequences in a message, then look up matching
// customers + recent bookings in DB2. Returns a compact text block or null
// if no plausible name match was found. Used by the orchestrator to attach
// customer context when an operator asks about a specific guest.
export async function lookupCustomerByName(message, crmSupabase) {
  if (!message || !crmSupabase) return null;
  // Match capitalized 2-3 word sequences. Skip leading sentence capitalizations
  // by requiring NOT preceded by a sentence-start punctuation.
  const matches = String(message).match(/\b([A-Z][a-z]{1,15})(?:\s+([A-Z][a-z]{1,15})){1,2}\b/g);
  if (!matches?.length) return null;

  // Ignore common false positives (place names, day names, brand names).
  const STOPWORDS = new Set([
    "Steamboat Springs", "Rabbit Ears", "North Routt", "Colorado Sled",
    "Kremmling RZR", "RZR Pro", "Pro S4", "Ranger XP", "XP General",
    "Today Tomorrow", "Last Week", "This Week", "Next Week", "Monday",
    "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Polaris Adventures",
  ]);
  const candidates = [...new Set(matches)].filter(n => !STOPWORDS.has(n)).slice(0, 3);
  if (!candidates.length) return null;

  try {
    const blocks = [];
    for (const name of candidates) {
      const { data: customers } = await crmSupabase
        .from("customers").select("id, name, normalized_phone, company")
        .ilike("name", `%${name}%`).limit(2);
      if (!customers?.length) continue;

      for (const c of customers) {
        // bookings table doesn't expose balance_due_cents (that's view-only);
        // derive it from total_cents - total_paid_cents.
        const { data: bookings } = await crmSupabase
          .from("bookings")
          .select("fareharbor_pk, start_at, status, location, product_title, vehicle, customer_count, total_cents, amount_paid_cents, total_paid_cents")
          .eq("customer_id", c.id)
          .order("start_at", { ascending: false })
          .limit(3);
        const bkLines = (bookings ?? []).slice(0, 3).map(b => {
          const when = (b.start_at ?? "").slice(0, 10);
          const loc  = capLocation(b.location ?? "");
          const veh  = b.vehicle ?? "";
          const due  = (b.total_cents ?? 0) - (b.total_paid_cents ?? b.amount_paid_cents ?? 0);
          const paid = due > 0 ? "(unpaid)" : "";
          return `  • ${when} ${loc} ${veh} ${b.status} ${fmtMoney(b.total_cents)} ${paid}`.replace(/\s+/g, " ").trim();
        });
        blocks.push(`${c.name} (${c.normalized_phone ?? "no phone"})\n${bkLines.join("\n") || "  (no bookings)"}`);
      }
    }
    if (!blocks.length) return null;
    return "CUSTOMER LOOKUP:\n" + blocks.join("\n");
  } catch { return null; }
}
