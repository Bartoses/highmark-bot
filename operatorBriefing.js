// ─────────────────────────────────────────────────────────────────────────────
// operatorBriefing.js — Operator Mode: Morning Briefing + SMS Command Handling
// Highmark by Whiteout Solutions — Sprint 4A
//
// Exports:
//   sendOperatorBriefing(client, supabase, twilioClient)     → send/preview briefing
//   detectAndHandleOperatorCommand(msg, client, supabase)    → command string | null
//   buildOperatorApiData(clientId, supabase)                 → { bookings, hot_leads, weather, kb_synced_at }
// ─────────────────────────────────────────────────────────────────────────────

import { getAllClients } from "./clients.js";

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

export async function getWeeklyRevenueEstimate(clientId, supabase) {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("client_id", clientId)
      .in("status", ["converted", "engaged"])
      .gte("created_at", since);
    const count = data?.length ?? 0;
    return { bookings: count, estimated: count * 175, period: "7 days" };
  } catch {
    return { bookings: 0, estimated: 0, period: "7 days" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BRIEFING TEXT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export function buildBriefingText(client, todaySlots, hotLeads, weatherSnap) {
  const biz      = client.name ?? "Your business";
  const dateStr  = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric",
  });

  const lines = [];
  lines.push(`Good morning! Here's your day for ${biz}:`);
  lines.push("");
  lines.push(`TODAY'S BOOKINGS (${dateStr}):`);

  const bookingLines = todaySlots.slice(0, 5);
  if (bookingLines.length === 0) {
    lines.push("No bookings found in cache — check FareHarbor directly.");
  } else {
    for (const s of bookingLines) {
      lines.push(`• ${s.time} — ${s.name}`);
    }
  }

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

  lines.push("");
  const condLine = buildConditionsLine(weatherSnap);
  lines.push(`CONDITIONS: ${condLine}`);

  lines.push("");
  lines.push("Reply: LEADS, BOOKINGS, WEATHER for details.");

  let text = lines.join("\n");
  if (text.length > 960) text = smartTruncate(text, 960);
  return text;
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
// OPERATOR COMMAND DETECTION
// Call before Claude in owner mode. Returns formatted string or null.
// ─────────────────────────────────────────────────────────────────────────────

export async function detectAndHandleOperatorCommand(message, client, supabase) {
  const msg = (message ?? "").toLowerCase().trim();

  // BOOKINGS TODAY
  if (msg.match(/\bbookings?\s+(today|for today)\b/) || msg === "bookings today" || msg === "today's bookings" || msg === "todays bookings") {
    const slots = await getTodaysAvailability(client.id, supabase);
    return formatBookingsResponse(slots, "today");
  }

  // BOOKINGS TOMORROW
  if (msg.match(/\bbookings?\s+(tomorrow|for tomorrow)\b/) || msg === "bookings tomorrow") {
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

  // REVENUE / EARNINGS
  if (msg.match(/\brevenue\b/) || msg.match(/\bearnings?\b/)) {
    const rev = await getWeeklyRevenueEstimate(client.id, supabase);
    return formatRevenueResponse(rev);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE FORMATTERS
// ─────────────────────────────────────────────────────────────────────────────

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

  const w = snap.weather;
  const s = snap.snow;

  if (w?.steamboat) {
    const sb = w.steamboat;
    lines.push(`Steamboat: ${sb.temp}°F, ${sb.desc}, wind ${sb.wind_mph}mph`);
  }
  if (w?.rabbit_ears_pass) {
    const rp = w.rabbit_ears_pass;
    lines.push(`Rabbit Ears Pass: ${rp.temp}°F, ${rp.desc}`);
  }
  if (w?.kremmling) {
    const kr = w.kremmling;
    lines.push(`Kremmling: ${kr.temp}°F, ${kr.desc}`);
  }
  // Custom per-client locations
  for (const loc of (snap.custom_locations ?? [])) {
    lines.push(`${loc.name}: ${loc.temp}°F, ${loc.desc}`);
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
  return `Est. revenue (${rev.period}): $${rev.estimated.toLocaleString()} (~${rev.bookings} converted leads × $175 avg).\nFor exact figures, check FareHarbor reports.`;
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
