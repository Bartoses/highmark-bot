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
export async function getTodaysManifest(clientId, crmSupabase) {
  if (!crmSupabase) return [];
  try {
    const startMT = new Date();
    startMT.setHours(0, 0, 0, 0);
    const endMT = new Date(startMT);
    endMT.setDate(endMT.getDate() + 1);
    const { data } = await crmSupabase
      .from("daily_manifest")
      .select("fareharbor_pk, customer_name, activity, start_at, customer_count, total_cents, location, status")
      .gte("start_at", startMT.toISOString())
      .lt("start_at", endMT.toISOString())
      .order("start_at", { ascending: true });
    return data ?? [];
  } catch {
    return [];
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
        .select("fareharbor_pk, total_cents, total")
        .gte("start_at", startISO)
        .lt("start_at", endISO);
      if (data?.length) {
        const seenPks = new Set();
        let totalCents = 0;
        for (const r of data) {
          if (r.fareharbor_pk != null) seenPks.add(r.fareharbor_pk);
          // total_cents stored in cents; total stored as dollars (legacy)
          if (r.total_cents != null) totalCents += Number(r.total_cents) || 0;
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

// New bookings created in the last N hours. Tries DB2 bookings.created_at
// (covers MPWR + FH writes). Falls back to DB1 confirmations_sent on error.
// Returns { last_24h, last_7d, source } counts.
export async function getNewBookingsStats(crmSupabase, supabase) {
  const now    = Date.now();
  const since24 = new Date(now -  24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Try DB2 bookings table (covers MPWR + FH inserts)
  if (crmSupabase) {
    try {
      const [r24, r7] = await Promise.all([
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", since24),
        crmSupabase.from("bookings").select("id", { count: "exact", head: true }).gte("created_at", since7d),
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

export async function getWeeklyRevenueEstimate(clientId, supabase, crmSupabase = null) {
  // Prefer DB2 daily_manifest (real FH revenue data)
  if (crmSupabase) {
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await crmSupabase
        .from("daily_manifest")
        .select("fareharbor_pk, total")
        .gte("start_at", since);
      if (rows?.length) {
        const seenPks = new Set();
        let totalRev = 0;
        for (const r of rows) {
          if (r.fareharbor_pk != null) seenPks.add(r.fareharbor_pk);
          if (r.total != null) totalRev += Number(r.total) || 0;
        }
        const bookings = seenPks.size || rows.length;
        return { bookings, estimated: Math.round(totalRev), period: "7 days", source: "manifest" };
      }
    } catch {
      // fall through to estimate
    }
  }
  // Fallback: estimate from DB1 leads
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
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

// ─────────────────────────────────────────────────────────────────────────────
// BRIEFING TEXT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export function buildBriefingText(client, todaySlotsOrIgnored, hotLeads, weatherSnap, extras = {}) {
  const biz      = client.name ?? "Your business";
  const dateStr  = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric",
  });

  const lines = [];
  lines.push(`Good morning! Here's your day for ${biz}:`);
  lines.push("");

  // ── Today's manifest (real DB2 rows preferred via extras.manifest) ───────
  const manifest = extras.manifest ?? null;
  if (Array.isArray(manifest)) {
    const todayPax      = manifest.reduce((s, r) => s + (Number(r.customer_count) || 0), 0);
    const todayRevCents = manifest.reduce((s, r) => s + (Number(r.total_cents) || 0), 0);
    lines.push(`TODAY (${dateStr}): ${manifest.length} booking${manifest.length !== 1 ? "s" : ""} · ${todayPax} guest${todayPax !== 1 ? "s" : ""} · $${Math.round(todayRevCents / 100).toLocaleString()}`);
    if (manifest.length === 0) {
      lines.push("Nothing on the manifest yet — quiet day so far.");
    } else {
      for (const r of manifest.slice(0, 5)) {
        const time = r.start_at
          ? new Date(r.start_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" })
          : "?";
        const name = (r.customer_name ?? "?").split(" ")[0];
        const act  = (r.activity ?? "?").replace(/^.*?[•\-]\s*/, "").slice(0, 28);
        lines.push(`• ${time} — ${name} (${r.customer_count ?? "?"}p, ${act})`);
      }
      if (manifest.length > 5) lines.push(`  …+${manifest.length - 5} more`);
    }
  } else {
    // Legacy path — FH availability slots
    lines.push(`TODAY'S OPENINGS (${dateStr}):`);
    const bookingLines = (todaySlotsOrIgnored ?? []).slice(0, 5);
    if (bookingLines.length === 0) {
      lines.push("Nothing on the manifest yet — quiet day so far.");
    } else {
      for (const s of bookingLines) lines.push(`• ${s.time} — ${s.name}`);
    }
  }

  // ── New bookings created (24h / 7d) ──────────────────────────────────────
  const fresh = extras.newBookings ?? null;
  if (fresh && (fresh.last_24h > 0 || fresh.last_7d > 0)) {
    lines.push("");
    lines.push(`NEW BOOKINGS: ${fresh.last_24h} in last 24h · ${fresh.last_7d} this week`);
  }

  // ── Hot leads ────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`HOT LEADS (${hotLeads.length}):`);
  if (hotLeads.length === 0) {
    lines.push("No open leads needing follow-up.");
  } else {
    for (const lead of hotLeads.slice(0, 3)) {
      const firstName = (lead.name ?? "Unknown").split(" ")[0];
      const svc       = lead.service ?? "N/A";
      lines.push(`• ${firstName} — ${svc}, ${lead.status}`);
    }
  }

  // ── Conditions ───────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`CONDITIONS: ${buildConditionsLine(weatherSnap)}`);

  // ── Revenue: 7-day + season-to-date ──────────────────────────────────────
  const rev    = extras.revenue ?? null;
  const season = extras.seasonRevenue ?? null;
  if ((rev && (rev.estimated > 0 || rev.bookings > 0)) || (season && season.revenue_cents > 0)) {
    lines.push("");
    if (rev && (rev.estimated > 0 || rev.bookings > 0)) {
      const tag = rev.source === "manifest" ? "" : " (est)";
      lines.push(`7-DAY${tag}: $${rev.estimated.toLocaleString()} · ${rev.bookings} booking${rev.bookings !== 1 ? "s" : ""}`);
    }
    if (season && season.revenue_cents > 0) {
      const tag = season.source === "manifest" ? "" : " (est)";
      lines.push(`${season.period_label.toUpperCase()}${tag}: $${Math.round(season.revenue_cents / 100).toLocaleString()} · ${season.bookings} booking${season.bookings !== 1 ? "s" : ""}`);
    }
  }

  // ── Alerts ───────────────────────────────────────────────────────────────
  const issues = extras.issues ?? [];
  if (issues.length) {
    lines.push("");
    lines.push(`ALERTS (${issues.length}):`);
    for (const issue of issues.slice(0, 3)) {
      lines.push(`! ${issue}`);
    }
  }

  // ── Quick-reply menu ─────────────────────────────────────────────────────
  lines.push("");
  lines.push("Reply 1-7 or ask anything:");
  lines.push("1 Today's manifest   5 Weather/conditions");
  lines.push("2 Revenue            6 Tomorrow outlook");
  lines.push("3 Open leads         7 Unanswered convos");
  lines.push("4 Ops load");

  let text = lines.join("\n");
  if (text.length > 1280) text = smartTruncate(text, 1280);
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// NUMERIC QUICK-REPLY MENU
// Maps "1"-"7" inbound replies to internal operator commands. The mapping is
// stable across briefings so an operator can scroll back and reply with a
// number at any time of day.
// ─────────────────────────────────────────────────────────────────────────────
export const OPERATOR_MENU = {
  "1": "bookings today",
  "2": "revenue this week",
  "3": "leads",
  "4": "ops load",
  "5": "weather",
  "6": "bookings tomorrow",
  "7": "unanswered",
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

  // Gather all data in parallel
  const [todaySlots, manifest, hotLeads, weatherSnap, revenue, seasonRevenue, newBookings, issues] = await Promise.all([
    getTodaysAvailability(client.id, supabase),
    getTodaysManifest(client.id, crmSupabase),
    getHotLeads(client.id, supabase, 3),
    getWeatherSnapshot(supabase, client.id),
    getWeeklyRevenueEstimate(client.id, supabase, crmSupabase),
    getSeasonRevenue(client, crmSupabase, supabase),
    getNewBookingsStats(crmSupabase, supabase),
    detectOperationalIssues(client, supabase, crmSupabase),
  ]);

  const briefing = buildBriefingText(client, todaySlots, hotLeads, weatherSnap, {
    manifest,
    revenue,
    seasonRevenue,
    newBookings,
    issues,
    digestTypes: options.digestTypes ?? ["all"],
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
      .select("id, client_id, phone, role, label, digest_times, digest_types, timezone, daily_digest_enabled")
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

  // OPS LOAD (menu #4) — operational issues + workload at a glance
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
          .select("fareharbor_pk, customer_name, activity, start_at, customer_count, total_cents")
          .gte("start_at", start.toISOString())
          .lt("start_at", end.toISOString())
          .order("start_at", { ascending: true });
        return formatManifestResponse(data ?? [], "tomorrow");
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

export function formatManifestResponse(rows, day) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `${day === "today" ? "TODAY" : "TOMORROW"}\n\nNothing on the manifest yet — quiet ${day === "today" ? "day" : "tomorrow"} so far.`;
  }
  const pax    = rows.reduce((s, r) => s + (Number(r.customer_count) || 0), 0);
  const cents  = rows.reduce((s, r) => s + (Number(r.total_cents) || 0), 0);
  const header = `${day === "today" ? "TODAY" : "TOMORROW"}: ${rows.length} booking${rows.length !== 1 ? "s" : ""} · ${pax} guest${pax !== 1 ? "s" : ""} · $${Math.round(cents / 100).toLocaleString()}`;
  const lines  = [header, ""];
  for (const r of rows.slice(0, 8)) {
    const time = r.start_at
      ? new Date(r.start_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" })
      : "?";
    const name = (r.customer_name ?? "?").split(" ")[0];
    const act  = (r.activity ?? "?").replace(/^.*?[•\-]\s*/, "").slice(0, 30);
    lines.push(`• ${time} — ${name} (${r.customer_count ?? "?"}p, ${act})`);
  }
  if (rows.length > 8) lines.push(`  …+${rows.length - 8} more`);
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
      .select("fareharbor_pk, customer_name, activity, start_at, customer_count, total_cents, location, company")
      .gte("start_at", range.start)
      .lt("start_at", range.end)
      .order("total_cents", { ascending: false })
      .limit(5);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return `LARGEST BOOKINGS (${range.label ?? "range"})\n\nNo bookings found in this window.`;
    const lines = [`LARGEST BOOKINGS (${range.label ?? "range"})`, ""];
    for (const r of rows) {
      const date = r.start_at?.slice(0, 10) ?? "?";
      lines.push(`• ${DOLLARS(r.total_cents)} — ${r.customer_name ?? "?"} (${r.customer_count ?? "?"} pax, ${r.activity ?? "?"}) ${date}`);
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
      .select("start_at, customer_count")
      .gte("start_at", range.start)
      .lt("start_at", range.end);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) return `BUSIEST TIME (${range.label ?? "today"})\n\nNo bookings in this window.`;
    // Group by hour-of-day (MT)
    const byHour = new Map();
    for (const r of rows) {
      if (!r.start_at) continue;
      const hourStr = new Date(r.start_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: false });
      const hour = parseInt(hourStr, 10);
      if (!Number.isFinite(hour)) continue;
      const cur = byHour.get(hour) ?? { bookings: 0, pax: 0 };
      cur.bookings += 1;
      cur.pax += Number(r.customer_count) || 0;
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
      .select("fareharbor_pk, customer_name, normalized_phone, activity, start_at, customer_count")
      .gte("start_at", range.start)
      .lt("start_at", range.end);
    if (error) throw error;
    const rows = scoped ?? [];
    if (!rows.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo bookings in this window.`;

    // For each unique phone in scope, count their TOTAL bookings (any time).
    // A phone with exactly 1 booking total = first-timer.
    const phones = [...new Set(rows.map((r) => r.normalized_phone).filter(Boolean))];
    if (!phones.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo phone-keyed bookings in this window.`;

    const { data: allByPhone } = await crmSupabase
      .from("daily_manifest")
      .select("normalized_phone")
      .in("normalized_phone", phones);
    const countByPhone = new Map();
    for (const r of allByPhone ?? []) {
      countByPhone.set(r.normalized_phone, (countByPhone.get(r.normalized_phone) ?? 0) + 1);
    }
    const firstTimers = rows.filter((r) => (countByPhone.get(r.normalized_phone) ?? 0) <= 1);
    if (!firstTimers.length) return `FIRST-TIME GUESTS (${range.label ?? "range"})\n\nNo first-timers — everyone has booked before.`;
    const lines = [`FIRST-TIME GUESTS (${range.label ?? "range"}) — ${firstTimers.length}`, ""];
    for (const r of firstTimers.slice(0, 5)) {
      const time = r.start_at ? new Date(r.start_at).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" }) : "";
      const firstName = (r.customer_name ?? "Unknown").split(" ")[0];
      lines.push(`• ${firstName} — ${r.activity ?? "?"} ${time} (${r.customer_count ?? "?"} pax)`);
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

export async function buildOperatorApiData(clientId, supabase) {
  const [todaySlots, hotLeads, weatherSnap, fhRows] = await Promise.all([
    getTodaysAvailability(clientId, supabase),
    getHotLeads(clientId, supabase, 10),
    getWeatherSnapshot(supabase, clientId),
    getFhDataForClient(clientId, supabase),
  ]);

  const kbSyncedAt = fhRows.reduce((latest, row) => {
    if (!row.fetched_at) return latest;
    return !latest || row.fetched_at > latest ? row.fetched_at : latest;
  }, null);

  return {
    bookings:     todaySlots,
    hot_leads:    hotLeads,
    weather:      weatherSnap,
    kb_synced_at: kbSyncedAt,
    date:         todayMT(),
  };
}
