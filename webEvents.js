// ─────────────────────────────────────────────────────────────────────────────
// WEB EVENTS — Phase 11.5: Visitor tracking + attribution
//
// Lightweight event log for all web chat interactions.
// All writes are fire-and-forget — never block the response path.
//
// Event types:
//   chat_started     — first message in a new session
//   message_sent     — each subsequent user message
//   lead_captured    — passive or structured lead saved
//   booking_clicked  — booking link injected into reply
//
// Table: web_events (db1_web_events.sql)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// trackWebEvent — insert a single event row; silently swallows all errors.
//
// opts:
//   clientId   (string)  — required
//   eventType  (string)  — required: chat_started | message_sent | lead_captured | booking_clicked
//   sessionId  (string)  — web session UUID; null for SMS
//   channel    (string)  — "web" | "sms"; defaults "web"
//   pageUrl    (string)  — URL of the page hosting the widget; null if not available
//   metadata   (object)  — optional extra context stored as JSONB
// ─────────────────────────────────────────────────────────────────────────────
export async function trackWebEvent(supabase, {
  clientId,
  eventType,
  sessionId  = null,
  channel    = "web",
  pageUrl    = null,
  metadata   = {},
} = {}) {
  if (!supabase || !clientId || !eventType) return;
  try {
    await supabase.from("web_events").insert({
      client_id:  clientId,
      session_id: sessionId,
      channel,
      page_url:   pageUrl,
      event_type: eventType,
      metadata,
    });
  } catch { /* non-fatal — tracking must never block the response */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// getAttributionData — aggregate events by page for the portal Attribution view.
//
// Returns:
//   topPages  — sorted by chats desc, max 25 rows
//   summary   — cross-page totals
//   insights  — 1-3 human-readable highlight strings
// ─────────────────────────────────────────────────────────────────────────────
export async function getAttributionData(supabase, clientId, days = 30) {
  if (!supabase || !clientId) return null;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("web_events")
    .select("page_url, event_type")
    .eq("client_id", clientId)
    .gte("created_at", since);

  if (error || !data) return { topPages: [], summary: {}, insights: [] };

  // Aggregate by page_url × event_type
  const pageMap = new Map(); // pageUrl → { chats, messages, leads, bookings }
  let totalChats = 0, totalMessages = 0, totalLeads = 0, totalBookings = 0;

  for (const row of data) {
    const key = row.page_url ?? "(no page)";
    if (!pageMap.has(key)) pageMap.set(key, { pageUrl: key, chats: 0, messages: 0, leads: 0, bookings: 0 });
    const p = pageMap.get(key);
    switch (row.event_type) {
      case "chat_started":    p.chats++;    totalChats++;    break;
      case "message_sent":    p.messages++; totalMessages++; break;
      case "lead_captured":   p.leads++;    totalLeads++;    break;
      case "booking_clicked": p.bookings++; totalBookings++; break;
    }
  }

  const topPages = Array.from(pageMap.values())
    .sort((a, b) => b.chats - a.chats || b.leads - a.leads)
    .slice(0, 25);

  const summary = { totalChats, totalMessages, totalLeads, totalBookings };

  // Simple insights — 1-3 one-liners for the portal card
  const insights = [];
  const topConverter = topPages.find((p) => p.bookings > 0 || p.leads > 0);
  const topChat      = topPages[0];
  if (topConverter) {
    const what = topConverter.bookings > 0 ? `${topConverter.bookings} booking click${topConverter.bookings !== 1 ? "s" : ""}` : `${topConverter.leads} lead${topConverter.leads !== 1 ? "s" : ""}`;
    insights.push(`Top converting page: ${formatPageLabel(topConverter.pageUrl)} (${what})`);
  }
  if (topChat && topChat !== topConverter) {
    insights.push(`Most conversations: ${formatPageLabel(topChat.pageUrl)} (${topChat.chats} chat${topChat.chats !== 1 ? "s" : ""})`);
  }
  if (totalLeads === 0 && totalChats > 0) {
    insights.push("No leads captured yet — consider enabling lead capture in Bot Config.");
  }

  return { topPages, summary, insights };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeConversionRate — pure helper: leads / chatStarts as a percentage.
// Returns a number with one decimal place (e.g. 23.5), clamped at 0.
// Safe against null / zero chatStarts.
// ─────────────────────────────────────────────────────────────────────────────
export function computeConversionRate(chatStarts, leads) {
  if (!chatStarts || chatStarts <= 0 || !leads || leads < 0) return 0;
  return Math.round((leads / chatStarts) * 1000) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// getPerformanceData — primary analytics query for the portal Analytics tab.
//
// Aggregates web_events for the given client over `days` days.
// Returns:
//   chatStarts      — total chat_started events (all channels)
//   leadsWeb        — lead_captured events (web channel)
//   bookingClicks   — booking_clicked events (all channels)
//   conversionRate  — leadsWeb / chatStarts as a percentage (1 decimal)
//   channelBreakdown — { web: { chats, leads, bookings }, sms: { ... } }
//   topPages        — top 10 pages by chats, each with label
//   insights        — 1-3 plain-language highlight strings
// ─────────────────────────────────────────────────────────────────────────────
export async function getPerformanceData(supabase, clientId, days = 7) {
  if (!supabase || !clientId) return null;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("web_events")
    .select("event_type, channel, page_url")
    .eq("client_id", clientId)
    .gte("created_at", since);

  if (error) return null;
  const rows = data ?? [];

  let chatStarts = 0, leadsWeb = 0, bookingClicks = 0;
  const channelMap = {
    web: { chats: 0, leads: 0, bookings: 0 },
    sms: { chats: 0, leads: 0, bookings: 0 },
  };
  const pageMap = new Map();

  for (const row of rows) {
    const ch = row.channel === "sms" ? "sms" : "web";
    const pKey = row.page_url ?? "(no page)";
    if (!pageMap.has(pKey)) pageMap.set(pKey, { pageUrl: pKey, chats: 0, leads: 0, bookings: 0 });
    const p = pageMap.get(pKey);

    switch (row.event_type) {
      case "chat_started":
        chatStarts++;
        channelMap[ch].chats++;
        p.chats++;
        break;
      case "lead_captured":
        if (ch === "web") leadsWeb++;
        channelMap[ch].leads++;
        p.leads++;
        break;
      case "booking_clicked":
        bookingClicks++;
        channelMap[ch].bookings++;
        p.bookings++;
        break;
    }
  }

  const conversionRate = computeConversionRate(chatStarts, leadsWeb);

  const topPages = Array.from(pageMap.values())
    .sort((a, b) => b.chats - a.chats || b.leads - a.leads)
    .slice(0, 10)
    .map(p => ({ ...p, label: formatPageLabel(p.pageUrl) }));

  const insights = [];
  if (chatStarts === 0) {
    insights.push("No conversations started in this period.");
  } else {
    if (conversionRate >= 20) {
      insights.push(`Strong conversion: ${conversionRate}% of chats become leads.`);
    } else if (conversionRate > 0) {
      insights.push(`Lead conversion: ${conversionRate}% of chats result in a lead.`);
    } else {
      insights.push("No leads captured yet — consider enabling lead capture in Bot Config.");
    }
    if (bookingClicks > 0) {
      insights.push(`${bookingClicks} booking link click${bookingClicks !== 1 ? "s" : ""} tracked this period.`);
    }
    const topPage = topPages[0];
    if (topPage && topPage.pageUrl !== "(no page)") {
      insights.push(`Most active page: ${topPage.label} (${topPage.chats} chat${topPage.chats !== 1 ? "s" : ""}).`);
    }
  }

  return { days, chatStarts, leadsWeb, bookingClicks, conversionRate, channelBreakdown: channelMap, topPages, insights };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export function formatPageLabel(url) {
  if (!url || url === "(no page)") return "Unknown page";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "Homepage" : u.pathname;
    return path.length > 40 ? path.slice(0, 38) + "…" : path;
  } catch {
    return url.slice(0, 40);
  }
}
