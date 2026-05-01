// ─────────────────────────────────────────────────────────────────────────────
// actionEngine.js — Agent Action Execution Layer (Phase 4 + Phase X)
// Highmark by Whiteout Solutions
//
// Transforms AI-generated action directives into real-world operations.
// All actions are wrapped in try/catch and return a structured result.
// Never throws — always returns { success, result, fallbackMessage }.
//
// Caller contract:
//   integrations.booking    — availability checks, booking link resolution
//   integrations.crm        — contact upsert, tagging, opt-out enforcement
//   integrations.messaging  — scheduled messages, Twilio sends
//   integrations.database   — raw Supabase query access (DB1)
//   integrations.crmDatabase — CRM Supabase query access (DB2, opt-out check)
//
// Each integration is optional. If missing, the action fails gracefully.
//
// Phase X additions — owner mode BI actions:
//   get_lead_summary    — lead counts by status + timeframe (real DB)
//   get_recent_leads    — last N leads with name/service/status (real DB)
//   get_missed_leads    — unconverted leads older than 24h (real DB)
//   analyze_performance — 30-day conversion rate + lead velocity (real DB)
//   get_campaign_stats  — recent campaign performance (real DB)
//   send_campaign       — creates draft + confirmation prompt (requires YES)
//   execute_campaign    — actual send post-confirmation (real enqueue)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// RESULT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function ok(result = {}) {
  return { success: true, result, fallbackMessage: null };
}

function fail(fallbackMessage, result = {}) {
  return { success: false, result, fallbackMessage };
}

// Owner-mode result: always succeeds, includes formatted reply to override Claude's
function ownerOk(result = {}, ownerReply = null) {
  return { success: true, result, fallbackMessage: null, ownerReply };
}

// Owner-mode confirmation: pauses execution, returns prompt to owner
// The orchestrator reads requiresConfirmation and stores { pendingAction, pendingData }
function ownerConfirm(result = {}, ownerReply = null) {
  return { success: true, requiresConfirmation: true, result, fallbackMessage: null, ownerReply };
}

const GLOBAL_FALLBACK = fail("Something went wrong — let me help another way.");

// ─────────────────────────────────────────────────────────────────────────────
// GUEST ACTION HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// ── create_booking ────────────────────────────────────────────────────────────
async function handleCreateBooking(data, context, client, integrations) {
  try {
    const date        = data.date        ?? context?.date        ?? null;
    const groupSize   = data.groupSize   ?? context?.groupSize   ?? null;
    const serviceType = data.serviceType ?? context?.serviceType ?? null;

    if (!date || !serviceType) {
      const link = integrations?.booking?.getBookingLink?.(serviceType, client) ?? null;
      return fail(
        link
          ? `To book, head here: ${link}`
          : "I need a date and service type to check bookings. What are you looking for?",
        { missing: { date: !date, serviceType: !serviceType } }
      );
    }

    if (integrations?.booking?.createBooking) {
      const booking = await integrations.booking.createBooking({ date, groupSize, serviceType, client });
      if (booking?.bookingId) {
        return ok({ bookingId: booking.bookingId, confirmationDetails: booking.confirmationDetails ?? {} });
      }
    }

    const link = integrations?.booking?.getBookingLink?.(serviceType, client) ?? null;
    return fail(
      link
        ? `Couldn't complete booking automatically — book directly here: ${link}`
        : "Couldn't complete booking. Please call us to reserve your spot.",
      {}
    );
  } catch (e) {
    console.error("[actionEngine] create_booking error:", e.message);
    const link = integrations?.booking?.getBookingLink?.(data?.serviceType, client) ?? null;
    return fail(
      link ? `Couldn't complete booking — book here: ${link}` : "Couldn't complete booking — please call us.",
      {}
    );
  }
}

// ── check_availability ────────────────────────────────────────────────────────
async function handleCheckAvailability(data, context, client, integrations) {
  try {
    const date        = data.date        ?? context?.date        ?? null;
    const serviceType = data.serviceType ?? context?.serviceType ?? null;

    if (!integrations?.booking?.checkAvailability) {
      const link = integrations?.booking?.getBookingLink?.(serviceType, client) ?? null;
      return fail(
        link
          ? `Availability may vary — check here: ${link}`
          : "I can't check availability right now. Please call us for current openings.",
        {}
      );
    }

    const avail = await integrations.booking.checkAvailability({ date, serviceType, client });
    if (!avail) {
      const link = integrations?.booking?.getBookingLink?.(serviceType, client) ?? null;
      return fail(
        link ? `Availability may vary — check here: ${link}` : "Couldn't retrieve availability — please call us.",
        {}
      );
    }

    return ok({
      available: avail.available ?? false,
      slots:     avail.slots     ?? [],
      nextOpen:  avail.nextOpen  ?? null,
      date,
    });
  } catch (e) {
    console.error("[actionEngine] check_availability error:", e.message);
    const link = integrations?.booking?.getBookingLink?.(data?.serviceType, client) ?? null;
    return fail(
      link ? `Availability may vary — check here: ${link}` : "Couldn't retrieve availability right now.",
      {}
    );
  }
}

// ── capture_lead ──────────────────────────────────────────────────────────────
async function handleCaptureLead(data, context, client, integrations) {
  try {
    const phone  = data.phone  ?? context?.phone  ?? null;
    const name   = data.name   ?? context?.name   ?? null;
    const tags   = Array.isArray(data.tags) ? data.tags : (data.intent ? [data.intent] : []);
    const intent = data.intent ?? context?.intent ?? null;

    if (!phone) {
      return fail("I need a phone number to save your info. What's the best number to reach you?", {});
    }

    if (!integrations?.crm?.upsertContact) {
      return fail("Couldn't save your info right now. We'll follow up manually.", {});
    }

    const contactData = {
      name:      name ?? null,
      intent:    intent ?? null,
      source:    data.source ?? "sms_agent",
      client_id: client?.id ?? null,
    };

    const result = await integrations.crm.upsertContact(phone, contactData);

    if (tags.length && integrations.crm.addTags) {
      await integrations.crm.addTags(phone, tags, client?.id);
    }

    return ok({ contactId: result?.id ?? null, phone, name, tags });
  } catch (e) {
    console.error("[actionEngine] capture_lead error:", e.message);
    return fail("Couldn't save your info right now — we'll follow up.", {});
  }
}

// ── update_contact ────────────────────────────────────────────────────────────
async function handleUpdateContact(data, context, client, integrations) {
  try {
    const phone = data.phone ?? context?.phone ?? null;
    if (!phone) return fail("No phone number provided to update contact.", {});

    if (!integrations?.crm?.upsertContact) {
      return fail("CRM update unavailable right now.", {});
    }

    const { opted_out, phone: _phone, ...safeData } = data;

    await integrations.crm.upsertContact(phone, safeData);

    if (data.tags?.length && integrations.crm.addTags) {
      await integrations.crm.addTags(phone, data.tags, client?.id);
    }

    return ok({ phone, updated: Object.keys(safeData) });
  } catch (e) {
    console.error("[actionEngine] update_contact error:", e.message);
    return fail("Couldn't update contact info right now.", {});
  }
}

// ── send_followup ─────────────────────────────────────────────────────────────
async function handleSendFollowup(data, context, client, integrations) {
  try {
    const phone   = data.phone   ?? context?.phone   ?? null;
    const body    = data.body    ?? data.message      ?? null;
    const send_at = data.send_at ?? data.sendAt       ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();

    if (!phone || !body) {
      return fail("Missing phone or message body for follow-up.", { missing: { phone: !phone, body: !body } });
    }

    if (!integrations?.messaging?.scheduleMessage) {
      return fail("Messaging system unavailable — follow-up not scheduled.", {});
    }

    const scheduled = await integrations.messaging.scheduleMessage({
      phone,
      body,
      send_at,
      message_type: data.message_type ?? "followup",
      client_id:    client?.id        ?? null,
      metadata:     data.metadata     ?? {},
    });

    return ok({ scheduled: true, send_at, phone, messageId: scheduled?.id ?? null });
  } catch (e) {
    console.error("[actionEngine] send_followup error:", e.message);
    return fail("Couldn't schedule follow-up right now.", {});
  }
}

// ── escalate_to_human ─────────────────────────────────────────────────────────
function handleEscalateToHuman(data, context, client) {
  try {
    const phone   = client?.handoffPhone ?? client?.supportPhone ?? client?.contact?.phone ?? null;
    const botName = client?.botName ?? "our team";
    const message = phone
      ? `Let me connect you with ${botName === "our team" ? "" : "the "}team — call ${phone} 🤙`
      : "Let me connect you with our team — they'll get you sorted right away.";
    return { success: true, result: { escalated: true, handoffPhone: phone }, fallbackMessage: message };
  } catch (e) {
    console.error("[actionEngine] escalate_to_human error:", e.message);
    return { success: true, result: { escalated: true }, fallbackMessage: "Let me connect you with our team." };
  }
}

// ── generate_report ───────────────────────────────────────────────────────────
// Legacy handler — now superseded by get_lead_summary + analyze_performance.
// Kept for backward compatibility with older prompts.
async function handleGenerateReport(data, context, client, integrations) {
  try {
    if (!integrations?.database?.supabase) {
      return fail("Database unavailable for reporting.", {});
    }

    const supabase  = integrations.database.supabase;
    const clientId  = client?.id ?? null;
    const report    = {};

    try {
      const { count: bookingCount } = await supabase
        .from("confirmations_sent")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      report.totalBookings = bookingCount ?? 0;
    } catch { report.totalBookings = null; }

    try {
      const { count: leadCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      report.totalLeads = leadCount ?? 0;
    } catch { report.totalLeads = null; }

    try {
      const { count: pendingCount } = await supabase
        .from("scheduled_messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("status", "pending");
      report.pendingFollowups = pendingCount ?? 0;
    } catch { report.pendingFollowups = null; }

    report.generatedAt = new Date().toISOString();
    report.clientId    = clientId;

    return ok(report);
  } catch (e) {
    console.error("[actionEngine] generate_report error:", e.message);
    return fail("Couldn't generate report right now.", {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER MODE — BUSINESS INTELLIGENCE HANDLERS (Phase X)
// All handlers query real DB and return ownerOk() with a formatted reply.
// No hallucinated numbers. If DB unavailable → graceful fail.
// ─────────────────────────────────────────────────────────────────────────────

// ── get_lead_summary ──────────────────────────────────────────────────────────
// Returns lead counts by status for a given timeframe.
// data.timeframe: "today" | "week" | "month" | "all" (default: "week")
async function handleGetLeadSummary(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    console.log(`[actionEngine] get_lead_summary — clientId=${client?.id} hasDb=${!!supabase} timeframe=${data.timeframe ?? "week(default)"}`);
    if (!supabase) return fail("Database unavailable for lead summary.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID available.");

    const timeframe = String(data.timeframe ?? "week").toLowerCase().replace(/\s+/g, "_");
    const now = new Date();
    let startDate = null;
    let label = "all time";

    if (timeframe === "today") {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      label = "today";
    } else if (timeframe.includes("week")) {
      startDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      label = "this week";
    } else if (timeframe.includes("month")) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      label = "this month";
    }

    let query = supabase.from("leads").select("status, created_at").eq("client_id", clientId);
    if (startDate) query = query.gte("created_at", startDate);

    const { data: leads, error } = await query;
    if (error) {
      console.error("[actionEngine] get_lead_summary DB error:", error.message, "clientId:", clientId, "timeframe:", timeframe);
      return fail("Couldn't retrieve lead data right now.");
    }

    const rows = leads ?? [];
    const total = rows.length;
    const byStatus = {};
    for (const l of rows) {
      byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
    }

    const converted  = byStatus.converted ?? 0;
    const rate       = total > 0 ? Math.round((converted / total) * 100) : 0;
    const pending    = (byStatus.new ?? 0) + (byStatus.contacted ?? 0) + (byStatus.engaged ?? 0);

    const statusParts = ["new", "contacted", "engaged", "converted", "closed"]
      .filter(s => byStatus[s])
      .map(s => `${s}: ${byStatus[s]}`)
      .join(" | ");

    let reply = `Leads ${label}: ${total}\n${statusParts || "none"}\nConversion: ${rate}%`;
    if (pending > 0) {
      reply += `\n\n${pending} lead${pending !== 1 ? "s" : ""} still in pipeline. Want me to follow up or run a campaign?`;
    }

    return ownerOk({ timeframe: label, total, byStatus, converted, rate, pending }, reply);
  } catch (e) {
    console.error("[actionEngine] get_lead_summary error:", e.message);
    return fail("Couldn't retrieve lead summary right now.");
  }
}

// ── get_recent_leads ──────────────────────────────────────────────────────────
// Returns the most recent N leads. data.limit defaults to 5.
async function handleGetRecentLeads(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Database unavailable.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID.");

    const limit = Math.min(parseInt(data.limit ?? 5), 10);

    const { data: leads, error } = await supabase
      .from("leads")
      .select("contact_name, contact_phone, requested_service, status, created_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[actionEngine] get_recent_leads DB error:", error.message, "clientId:", clientId);
      return fail("Couldn't retrieve leads right now.");
    }

    const rows = leads ?? [];
    if (!rows.length) {
      return ownerOk({ leads: [] }, "No leads found yet.");
    }

    const lines = rows.map((l, i) => {
      const name    = l.contact_name     ?? "Unknown";
      const service = l.requested_service ?? "—";
      const status  = l.status           ?? "new";
      return `${i + 1}. ${name} — ${service} (${status})`;
    });

    const reply = `Recent ${rows.length} leads:\n${lines.join("\n")}`;
    return ownerOk({ leads: rows }, reply);
  } catch (e) {
    console.error("[actionEngine] get_recent_leads error:", e.message);
    return fail("Couldn't retrieve recent leads.");
  }
}

// ── get_missed_leads ──────────────────────────────────────────────────────────
// Leads that are still "new" or "contacted" after 24 hours with no conversion.
async function handleGetMissedLeads(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Database unavailable.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID.");

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: leads, error } = await supabase
      .from("leads")
      .select("id, contact_name, contact_phone, requested_service, status, created_at")
      .eq("client_id", clientId)
      .in("status", ["new", "contacted"])
      .lte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) return fail("Couldn't retrieve missed leads.");

    const rows = leads ?? [];
    if (!rows.length) {
      return ownerOk({ leads: [], count: 0 }, "No missed leads — all caught up! 👍");
    }

    const count = rows.length;
    const names = rows.slice(0, 3).map(l => l.contact_name ?? "Unknown").join(", ");
    const more  = count > 3 ? ` + ${count - 3} more` : "";

    const reply = `${count} missed lead${count !== 1 ? "s" : ""} (no activity >24h):\n${names}${more}\n\nWant me to create a follow-up campaign for them?`;
    return ownerOk({ leads: rows, count }, reply);
  } catch (e) {
    console.error("[actionEngine] get_missed_leads error:", e.message);
    return fail("Couldn't retrieve missed leads.");
  }
}

// ── analyze_performance ───────────────────────────────────────────────────────
// 30-day conversion rate, lead velocity, top services. All real DB data.
async function handleAnalyzePerformance(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Database unavailable for analysis.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID.");

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString();

    const [allLeadsRes, weekLeadsRes] = await Promise.all([
      supabase
        .from("leads")
        .select("status, requested_service, created_at")
        .eq("client_id", clientId)
        .gte("created_at", thirtyDaysAgo),
      supabase
        .from("leads")
        .select("status")
        .eq("client_id", clientId)
        .gte("created_at", sevenDaysAgo),
    ]);

    const allLeads  = allLeadsRes.data  ?? [];
    const weekLeads = weekLeadsRes.data ?? [];

    const total30     = allLeads.length;
    const converted30 = allLeads.filter(l => l.status === "converted").length;
    const rate30      = total30 > 0 ? Math.round((converted30 / total30) * 100) : 0;
    const total7      = weekLeads.length;
    const converted7  = weekLeads.filter(l => l.status === "converted").length;

    // Top service
    const serviceCounts = {};
    for (const l of allLeads) {
      const s = l.requested_service ?? "unspecified";
      serviceCounts[s] = (serviceCounts[s] ?? 0) + 1;
    }
    const topServiceEntry = Object.entries(serviceCounts).sort(([, a], [, b]) => b - a)[0];

    let reply = `Last 30 days:\nLeads: ${total30} | Converted: ${converted30} | Rate: ${rate30}%\nThis week: ${total7} leads (${converted7} converted)`;
    if (topServiceEntry) reply += `\nTop: ${topServiceEntry[0]} (${topServiceEntry[1]} leads)`;

    if (rate30 < 20 && total30 > 5) {
      reply += `\n\nConversion is below 20% — want strategy suggestions?`;
    } else if (total7 === 0 && total30 > 0) {
      reply += `\n\nNo new leads this week. Want to run a campaign?`;
    }

    return ownerOk({
      leads30:    { total: total30, converted: converted30, rate: rate30 },
      leads7:     { total: total7, converted: converted7 },
      topService: topServiceEntry ? { service: topServiceEntry[0], count: topServiceEntry[1] } : null,
    }, reply);
  } catch (e) {
    console.error("[actionEngine] analyze_performance error:", e.message);
    return fail("Couldn't analyze performance right now.");
  }
}

// ── get_campaign_stats ────────────────────────────────────────────────────────
// Returns recent campaign list with recipient counts + status.
async function handleGetCampaignStats(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Database unavailable.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID.");

    const { data: campaigns, error } = await supabase
      .from("campaigns")
      .select("id, name, status, message_body, metadata, created_at, sent_at")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) return fail("Couldn't retrieve campaign stats.");

    const rows = campaigns ?? [];
    if (!rows.length) {
      return ownerOk({ campaigns: [] }, "No campaigns yet. Want to create one?");
    }

    const lines = rows.map((c, i) => {
      const recipients = c.metadata?.recipient_count ?? c.metadata?.enqueued ?? "?";
      return `${i + 1}. ${c.name} — ${recipients} recipients (${c.status})`;
    });

    const reply = `Recent campaigns:\n${lines.join("\n")}`;
    return ownerOk({ campaigns: rows }, reply);
  } catch (e) {
    console.error("[actionEngine] get_campaign_stats error:", e.message);
    return fail("Couldn't retrieve campaign stats.");
  }
}

// ── send_campaign ─────────────────────────────────────────────────────────────
// Phase X: Creates a campaign draft + counts audience + returns confirmation prompt.
// Owner must reply YES to actually send (handled by orchestrator + execute_campaign).
async function handleSendCampaign(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Campaign system unavailable.");

    const clientId = client?.id;
    if (!clientId) return fail("No client ID for campaign.");

    const message = data.message ?? data.body ?? null;
    if (!message) return fail("What message should I send? Describe the campaign and I'll draft it.");

    const VALID_AUDIENCES = ["all_leads", "engaged_leads", "new_leads", "missed_leads"];
    const audienceType = VALID_AUDIENCES.includes(data.audience ?? "") ? data.audience : "all_leads";

    const { createCampaign, selectAudience } = await import("./campaigns.js");

    // Count audience first — no fake numbers
    const audienceLeads = await selectAudience(supabase, { clientId, audienceType });
    const count = audienceLeads.length;

    if (count === 0) {
      const audienceLabel = audienceType.replace(/_/g, " ");
      return fail(`No leads found in "${audienceLabel}". Try a different audience or add more leads first.`);
    }

    // Create draft campaign in DB
    const campaignName = data.name
      ?? `Campaign — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

    const campaign = await createCampaign(supabase, {
      clientId,
      name:         campaignName,
      messageBody:  message,
      audienceType,
    });

    if (!campaign?.id) return fail("Couldn't create campaign draft right now.");

    const preview      = message.length > 90 ? message.slice(0, 87) + "…" : message;
    const audienceLabel = { all_leads: "all leads", engaged_leads: "engaged leads", new_leads: "new leads", missed_leads: "missed leads" }[audienceType] ?? audienceType;

    const confirmReply =
      `Ready to send to ${count} ${audienceLabel}:\n"${preview}"\n\nReply YES to send, NO to cancel.`;

    return ownerConfirm(
      { pendingAction: "execute_campaign", pendingData: { campaign_id: campaign.id, count, audienceLabel } },
      confirmReply
    );
  } catch (e) {
    console.error("[actionEngine] send_campaign error:", e.message);
    return fail("Couldn't set up campaign right now.");
  }
}

// ── flag_issue ────────────────────────────────────────────────────────────────
// Log an operator-flagged issue. We persist a record to operator_briefings
// (existing table, repurposed with status='flag') when the table is available;
// otherwise we just acknowledge so the owner never sees a raw error.
async function handleFlagIssue(data, context, client, integrations) {
  try {
    const description = data.description ?? data.message ?? data.body ?? data.note ?? null;

    if (!description) {
      return ownerOk({ logged: false, awaiting: "description" }, "Got it — what should I flag? I’ll log it for review.");
    }

    const supabase = integrations?.database?.supabase;
    if (supabase) {
      try {
        await supabase.from("operator_briefings").insert({
          client_id: client?.id ?? null,
          content:   `[FLAG] ${description}`,
          sent_at:   new Date().toISOString(),
          status:    "flag",
        });
      } catch (dbErr) {
        // Schema may not allow status='flag' — degrade gracefully
        console.warn("[actionEngine] flag_issue persist failed:", dbErr.message);
      }
    }

    return ownerOk(
      { logged: true, description, clientId: client?.id ?? null },
      `Flagged for review: "${description}". I’ll keep an eye on it.`
    );
  } catch (e) {
    console.error("[actionEngine] flag_issue error:", e.message);
    return ownerOk({ logged: false }, "Got it — I’ll flag that for review.");
  }
}

// ── Booking source resolver ───────────────────────────────────────────────────
// Prefers DB2 daily_manifest (real FH manifest mirror with fareharbor_pk + pax +
// total) when crmDatabase is available. Falls back to DB1 confirmations_sent
// (bot-sent confirmations only — incomplete until CONFIRMATIONS_ENABLED=true).
//
// Returns { source, supabase, table, columns, dedupKey, paxField, totalField,
//           itemField } so the caller can fetch + summarize uniformly.
function resolveBookingSource(integrations) {
  const crmSb = integrations?.crmDatabase?.supabase ?? null;
  if (crmSb) {
    return {
      source:     "manifest",
      supabase:   crmSb,
      table:      "daily_manifest",
      columns:    "fareharbor_pk, company, activity, start_at, pax, total",
      dedupKey:   "fareharbor_pk",
      paxField:   "pax",
      totalField: "total",
      itemField:  "activity",
    };
  }
  const sb = integrations?.database?.supabase ?? null;
  if (sb) {
    return {
      source:     "confirmations",
      supabase:   sb,
      table:      "confirmations_sent",
      columns:    "company, item_name, start_at",
      dedupKey:   null,
      paxField:   null,
      totalField: null,
      itemField:  "item_name",
    };
  }
  return null;
}

// ── aggregateBookings (exported) ──────────────────────────────────────────────
// Aggregate daily_manifest (or confirmations_sent) rows into summary stats.
// Exported so callers and tests can call it directly.
export function aggregateBookings(rows, src) {
  const byCompany = {};
  const byItem    = {};
  const seenPks   = src.dedupKey ? new Set() : null;
  let totalRows   = 0;
  let totalPax    = 0;
  let totalRev    = 0;

  for (const r of rows) {
    totalRows += 1;
    const c = r.company ?? "unknown";
    byCompany[c] = (byCompany[c] ?? 0) + 1;
    const it = r[src.itemField] ?? "unspecified";
    byItem[it] = (byItem[it] ?? 0) + 1;
    if (seenPks && r[src.dedupKey] != null) seenPks.add(r[src.dedupKey]);
    if (src.paxField   && typeof r[src.paxField]   === "number") totalPax += r[src.paxField];
    if (src.totalField && r[src.totalField] != null) totalRev += Number(r[src.totalField]) || 0;
  }

  return {
    totalRows,
    distinctBookings: seenPks ? seenPks.size : totalRows,
    totalPax,
    totalRev,
    byCompany,
    byItem,
  };
}

// Internal alias kept for backward compatibility inside this file
function summarizeBookingRows(rows, src) { return aggregateBookings(rows, src); }

// ── buildBookingQuery (exported) ──────────────────────────────────────────────
// Constructs a Supabase query against the resolved booking source.
// Filters: { company: string|string[], activity: string, location: string }
export function buildBookingQuery(src, { start, end, filters = {} }) {
  let query = src.supabase
    .from(src.table)
    .select(src.columns)
    .gte("start_at", start)
    .lte("start_at", end)
    .order("start_at", { ascending: true });

  if (Array.isArray(filters.company) && filters.company.length) {
    query = query.in("company", filters.company);
  } else if (typeof filters.company === "string" && filters.company) {
    query = query.ilike("company", `%${filters.company}%`);
  }
  if (filters.activity) query = query.ilike(src.itemField, `%${filters.activity}%`);
  if (filters.location) query = query.ilike("location", `%${filters.location}%`);

  return query;
}

// Top-N entries from a { name: count } map, sorted by count desc.
function limitTopResults(entries, n = 5) {
  return Object.entries(entries)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n);
}

// ── get_bookings_by_date_range ────────────────────────────────────────────────
// Counts bookings for a date window; breaks down by company + top activity.
// Uses DB2 daily_manifest when available (real numbers + revenue + pax),
// otherwise falls back to DB1 confirmations_sent (bot-sent confirmations only).
async function handleGetBookingsByDateRange(data, context, client, integrations) {
  try {
    const src = resolveBookingSource(integrations);
    if (!src) return fail("Database unavailable for bookings.");

    const range = data.date_range ?? null;
    if (!range?.start || !range?.end) {
      return fail("I need a date range to look up bookings. Try \"bookings today\" or \"bookings in Feb 2026\".");
    }

    const shortnames = (client?.fareharborCompanies ?? [])
      .map(c => c?.shortname)
      .filter(Boolean);

    let query = src.supabase
      .from(src.table)
      .select(src.columns)
      .gte("start_at", range.start)
      .lte("start_at", range.end)
      .order("start_at", { ascending: true });

    if (shortnames.length) {
      query = query.in("company", shortnames);
    }

    const { data: rows, error } = await query;
    if (error) {
      console.error(`[actionEngine] get_bookings_by_date_range ${src.table} error:`, error.message);
      return fail("Couldn't retrieve bookings right now.");
    }

    const list   = rows ?? [];
    const label  = range.label ?? "that range";
    const metric = data.metric ?? "bookings";

    if (!list.length) {
      return ownerOk(
        { total: 0, range, source: src.source },
        `I couldn't find any records in your CRM for ${label}.\n\nTry adjusting the timeframe or filters.`
      );
    }

    const sum      = aggregateBookings(list, src);
    const headline = src.dedupKey ? sum.distinctBookings : sum.totalRows;
    const capLabel = label.charAt(0).toUpperCase() + label.slice(1);

    const lines = [`${capLabel}:`, `Total bookings: ${headline.toLocaleString()}`];

    if (src.source === "manifest") {
      if (sum.totalPax > 0) lines.push(`Total pax: ${sum.totalPax.toLocaleString()}`);
      if (sum.totalRev > 0) lines.push(`Revenue: $${Math.round(sum.totalRev).toLocaleString()}`);
    }

    // Top activities (limit 5)
    const topItems = limitTopResults(sum.byItem, 5).map(([n, c]) => {
      const entry = list.find(r => (r[src.itemField] ?? "unspecified") === n);
      const paxPart = src.paxField && entry ? ` (${sum.byItem[n]} bookings)` : ` (${c})`;
      return `- ${n}${paxPart}`;
    });
    if (topItems.length) lines.push("", "Top activities:", ...topItems);

    // By company (only when >1 company)
    const companySorted = limitTopResults(sum.byCompany);
    if (companySorted.length > 1) {
      lines.push("", "By company:", ...companySorted.map(([c, n]) => `- ${c}: ${n}`));
    }

    return ownerOk(
      {
        total:             headline,
        line_items:        sum.totalRows,
        distinct_bookings: sum.distinctBookings,
        pax:               sum.totalPax,
        revenue:           sum.totalRev,
        byCompany:         sum.byCompany,
        byItem:            sum.byItem,
        range,
        source:            src.source,
        metric,
      },
      lines.join("\n")
    );
  } catch (e) {
    console.error("[actionEngine] get_bookings_by_date_range error:", e.message);
    return fail("Couldn't retrieve bookings right now.");
  }
}

// ── daily_summary ─────────────────────────────────────────────────────────────
// Bookings today + tomorrow + new leads (24h) + open-lead pipeline status.
// Cached for 60s per client to stay snappy on repeated hits.
const DAILY_SUMMARY_CACHE = new Map();
const DAILY_SUMMARY_TTL_MS = 60 * 1000;

async function handleDailySummary(data, context, client, integrations) {
  try {
    const dbSb = integrations?.database?.supabase ?? null;
    const src  = resolveBookingSource(integrations);
    if (!dbSb && !src) return fail("Database unavailable for daily summary.");

    const clientId = client?.id ?? null;
    const cacheKey = `summary:${clientId}:${src?.source ?? "none"}`;
    const cached   = DAILY_SUMMARY_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < DAILY_SUMMARY_TTL_MS) {
      return ownerOk(cached.data, cached.reply);
    }

    const { parseDateRange } = await import("./operatorIntentParser.js");
    const todayRange    = parseDateRange("today");
    const tomorrowRange = parseDateRange("tomorrow");
    const since24h      = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const shortnames = (client?.fareharborCompanies ?? [])
      .map(c => c?.shortname)
      .filter(Boolean);

    const fetchRange = (range) => {
      if (!src) return Promise.resolve({ data: [], error: null });
      let q = src.supabase.from(src.table).select(src.columns)
        .gte("start_at", range.start).lte("start_at", range.end);
      if (shortnames.length) q = q.in("company", shortnames);
      return q;
    };

    const [todayRes, tomorrowRes, newLeadsRes, pipelineRes] = await Promise.all([
      fetchRange(todayRange),
      fetchRange(tomorrowRange),
      clientId && dbSb
        ? dbSb
            .from("leads")
            .select("id, status, created_at", { count: "exact" })
            .eq("client_id", clientId)
            .gte("created_at", since24h)
        : Promise.resolve({ data: [], count: 0 }),
      clientId && dbSb
        ? dbSb
            .from("leads")
            .select("status")
            .eq("client_id", clientId)
            .in("status", ["new", "contacted", "engaged"])
        : Promise.resolve({ data: [] }),
    ]);

    const summarize = (res) => {
      if (!src) return { distinctBookings: 0, totalPax: 0, totalRev: 0 };
      return summarizeBookingRows(res.data ?? [], src);
    };

    const todaySum    = summarize(todayRes);
    const tomorrowSum = summarize(tomorrowRes);
    const newLeads    = newLeadsRes.count ?? (newLeadsRes.data?.length ?? 0);
    const pipeline    = (pipelineRes.data ?? []).length;

    const todayCount    = src?.dedupKey ? todaySum.distinctBookings    : (todayRes.data?.length    ?? 0);
    const tomorrowCount = src?.dedupKey ? tomorrowSum.distinctBookings : (tomorrowRes.data?.length ?? 0);

    const confirmStatus = (process.env.CONFIRMATIONS_ENABLED === "true")
      ? "live"
      : "test mode";

    const lines = ["Daily Summary:"];
    if (src?.source === "manifest") {
      lines.push(`• Bookings today: ${todayCount} (${todaySum.totalPax} pax, $${Math.round(todaySum.totalRev).toLocaleString()})`);
      lines.push(`• Bookings tomorrow: ${tomorrowCount} (${tomorrowSum.totalPax} pax, $${Math.round(tomorrowSum.totalRev).toLocaleString()})`);
    } else {
      lines.push(`• Bookings today: ${todayCount}`);
      lines.push(`• Bookings tomorrow: ${tomorrowCount}`);
    }
    lines.push(`• New leads (24h): ${newLeads}`);
    lines.push(`• Open pipeline: ${pipeline}`);
    lines.push(`• Confirmations: ${confirmStatus}`);
    const reply = lines.join("\n");

    const result = {
      bookings_today:    todayCount,
      bookings_tomorrow: tomorrowCount,
      pax_today:         todaySum.totalPax,
      pax_tomorrow:      tomorrowSum.totalPax,
      revenue_today:     todaySum.totalRev,
      revenue_tomorrow:  tomorrowSum.totalRev,
      new_leads_24h:     newLeads,
      pipeline,
      confirm_status:    confirmStatus,
      source:            src?.source ?? "none",
    };

    DAILY_SUMMARY_CACHE.set(cacheKey, { at: Date.now(), data: result, reply });
    return ownerOk(result, reply);
  } catch (e) {
    console.error("[actionEngine] daily_summary error:", e.message);
    return fail("Couldn't build daily summary right now.");
  }
}

// ── report ────────────────────────────────────────────────────────────────────
// Season-aware grouped report: bookings/revenue/pax by activity or company.
// Prefers DB2 daily_manifest (real FH data); falls back to confirmations_sent.
async function handleReport(data, context, client, integrations) {
  try {
    const src = resolveBookingSource(integrations);
    if (!src) return fail("Database unavailable for this report.");

    const range = data.date_range ?? null;
    if (!range?.start || !range?.end) {
      return fail("Need a date range for this report. Try: 'bookings in winter 2025/2026 by activity'.");
    }

    const metric     = data.metric   ?? "bookings";
    const groupBy    = data.group_by ?? "activity";
    const groupField = groupBy === "company" ? "company" : src.itemField;

    const shortnames = (client?.fareharborCompanies ?? [])
      .map(c => c?.shortname).filter(Boolean);

    let query = src.supabase
      .from(src.table)
      .select(src.columns)
      .gte("start_at", range.start)
      .lte("start_at", range.end)
      .order("start_at", { ascending: true });
    if (shortnames.length) query = query.in("company", shortnames);

    const { data: rows, error } = await query;
    if (error) {
      console.error(`[actionEngine] report ${src.table} error:`, error.message);
      return fail("Couldn't retrieve report data right now.");
    }

    const list  = rows ?? [];
    const label = range.label ?? "that period";

    if (!list.length) {
      return ownerOk(
        { total: 0, groups: {}, range, source: src.source },
        `I couldn't find any records in your CRM for ${label}.\n\nTry adjusting the timeframe or filters.`
      );
    }

    // Aggregate in memory — one pass
    const groups  = {};
    const seenPks = src.dedupKey ? new Set() : null;
    let totalPax = 0, totalRev = 0;

    for (const r of list) {
      const key = r[groupField] ?? "unknown";
      if (!groups[key]) groups[key] = { count: 0, pax: 0, revenue: 0 };
      groups[key].count += 1;

      if (src.paxField && typeof r[src.paxField] === "number") {
        groups[key].pax += r[src.paxField];
        totalPax += r[src.paxField];
      }
      if (src.totalField && r[src.totalField] != null) {
        const rev = Number(r[src.totalField]) || 0;
        groups[key].revenue += rev;
        totalRev += rev;
      }
      if (seenPks && r[src.dedupKey] != null) seenPks.add(r[src.dedupKey]);
    }

    const totalDistinct = seenPks ? seenPks.size : list.length;
    const sorted = Object.entries(groups).sort(([, a], [, b]) => b.count - a.count);

    // Format response
    const capLabel = label.charAt(0).toUpperCase() + label.slice(1);
    const lines = [`${capLabel}:`, `Total bookings: ${totalDistinct}`];
    if (src.source === "manifest" && totalPax  > 0) lines.push(`Total pax: ${totalPax}`);
    if (src.source === "manifest" && totalRev  > 0) lines.push(`Revenue: $${Math.round(totalRev).toLocaleString()}`);

    const groupLabel = groupBy === "company" ? "By company:" : "Top activities:";
    lines.push("", groupLabel);

    for (const [name, g] of sorted.slice(0, 8)) {
      let line = `• ${name}: ${g.count}`;
      if (metric === "revenue" && g.revenue > 0) {
        line += ` ($${Math.round(g.revenue).toLocaleString()})`;
      } else if (src.source === "manifest" && g.pax > 0) {
        line += ` (${g.pax} pax)`;
      }
      lines.push(line);
    }
    if (sorted.length > 8) lines.push(`…and ${sorted.length - 8} more.`);

    // Company breakdown (only when grouping by activity and multiple companies present)
    if (groupBy === "activity") {
      const byCompany = {};
      for (const r of list) {
        const c = r.company ?? "unknown";
        byCompany[c] = (byCompany[c] ?? 0) + 1;
      }
      const compEntries = Object.entries(byCompany).sort(([, a], [, b]) => b - a);
      if (compEntries.length > 1) {
        lines.push("", "By company:", ...compEntries.map(([c, n]) => `  • ${c}: ${n}`));
      }
    }

    return ownerOk(
      {
        total:    totalDistinct,
        pax:      totalPax,
        revenue:  Math.round(totalRev),
        groups:   Object.fromEntries(sorted),
        range,
        source:   src.source,
        metric,
        group_by: groupBy,
      },
      lines.join("\n")
    );
  } catch (e) {
    console.error("[actionEngine] report error:", e.message);
    return fail("Couldn't generate report right now.");
  }
}

// ── execute_campaign ──────────────────────────────────────────────────────────
// Called after owner confirms with YES. Enqueues the draft campaign for real send.
async function handleExecuteCampaign(data, context, client, integrations) {
  try {
    const supabase = integrations?.database?.supabase;
    if (!supabase) return fail("Database unavailable.");

    const campaignId = data.campaign_id;
    if (!campaignId) return fail("No campaign ID to execute.");

    const { data: campaignRow, error: fetchErr } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (fetchErr || !campaignRow) return fail("Couldn't find campaign. It may have expired.");

    const { enqueueCampaign } = await import("./campaigns.js");

    const fromPhone = client?.outboundPhone ?? client?.inboundPhones?.[0] ?? null;
    if (!fromPhone) return fail("No outbound phone configured for this client.");

    const crmSb = integrations?.crmDatabase?.supabase ?? null;
    const result = await enqueueCampaign(supabase, campaignRow, fromPhone, crmSb);

    const enqueued = result.enqueued ?? 0;
    const skipped  = result.skipped  ?? 0;
    const optedOut = result.optedOutSkipped ?? 0;

    let reply = `✓ Campaign queued to ${enqueued} lead${enqueued !== 1 ? "s" : ""}`;
    if (optedOut > 0) reply += ` (${optedOut} opted out, skipped)`;
    if (skipped > 0 && optedOut === 0) reply += ` (${skipped} skipped)`;
    reply += ".";

    return ownerOk({ campaignId, enqueued, skipped, optedOut, status: "sending" }, reply);
  } catch (e) {
    console.error("[actionEngine] execute_campaign error:", e.message);
    return fail("Couldn't send campaign right now.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DISPATCHER
// Routes action strings to their handlers. All paths are try/catch wrapped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute an agent action and return a structured result.
 *
 * @param {{ action: string, data?: object, context?: object, client?: object, integrations?: object }} params
 * @returns {Promise<{ success: boolean, result: object, fallbackMessage: string|null, ownerReply?: string, requiresConfirmation?: boolean }>}
 */
export async function executeAction(params) {
  const { action, data = {}, context = {}, client = {}, integrations = {} } =
    (params && typeof params === "object" && !Array.isArray(params)) ? params : {};
  try {
    if (!action || typeof action !== "string") {
      return fail("No action specified.");
    }

    switch (action.toLowerCase().trim()) {
      // ── Guest actions ──────────────────────────────────────────────────────
      case "create_booking":
        return await handleCreateBooking(data, context, client, integrations);

      case "check_availability":
        return await handleCheckAvailability(data, context, client, integrations);

      case "capture_lead":
        return await handleCaptureLead(data, context, client, integrations);

      case "update_contact":
        return await handleUpdateContact(data, context, client, integrations);

      case "send_followup":
        return await handleSendFollowup(data, context, client, integrations);

      case "escalate_to_human":
        return handleEscalateToHuman(data, context, client);

      case "generate_report":
        return await handleGenerateReport(data, context, client, integrations);

      // ── Owner / BI actions (Phase X) ───────────────────────────────────────
      case "get_lead_summary":
        return await handleGetLeadSummary(data, context, client, integrations);

      case "get_recent_leads":
        return await handleGetRecentLeads(data, context, client, integrations);

      case "get_missed_leads":
        return await handleGetMissedLeads(data, context, client, integrations);

      case "analyze_performance":
        return await handleAnalyzePerformance(data, context, client, integrations);

      case "get_campaign_stats":
        return await handleGetCampaignStats(data, context, client, integrations);

      case "send_campaign":
        return await handleSendCampaign(data, context, client, integrations);

      case "execute_campaign":
        return await handleExecuteCampaign(data, context, client, integrations);

      case "flag_issue":
      case "log_issue":
      case "report_issue":
        return await handleFlagIssue(data, context, client, integrations);

      case "get_bookings_by_date_range":
      case "bookings_by_date":
      case "bookings_in_range":
        return await handleGetBookingsByDateRange(data, context, client, integrations);

      case "report":
      case "grouped_report":
      case "season_report":
        return await handleReport(data, context, client, integrations);

      case "daily_summary":
      case "morning_summary":
      case "today_summary":
        return await handleDailySummary(data, context, client, integrations);

      default:
        console.warn(`[actionEngine] Unknown action: "${action}"`);
        return ownerOk(
          { unknown_action: action },
          "Try asking:\n• bookings today\n• bookings this weekend\n• revenue this month\n• daily summary"
        );
    }
  } catch (e) {
    console.error("[actionEngine] executeAction fatal error:", e.message);
    return { ...GLOBAL_FALLBACK };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION BUILDER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the integrations object from live Highmark module instances.
 *
 * @param {{ supabase, crmSupabase, twilioClient, client }} opts
 * @returns {object} integrations
 */
export function buildIntegrations({ supabase = null, crmSupabase = null, twilioClient = null, client = null } = {}) {
  return {
    booking: {
      getBookingLink(serviceType, c) {
        try {
          const cl    = c ?? client;
          const links = cl?.bookingLinks ?? [];
          const urls  = cl?.bookingUrls  ?? {};

          if (Array.isArray(links) && links.length) {
            const match = links.find((l) => {
              if (!l?.url) return false;
              if (!serviceType) return !!l.metadata_json?.category?.includes("browse");
              return (l.title ?? "").toLowerCase().includes(serviceType.toLowerCase())
                || (l.metadata_json?.category ?? "").includes(serviceType.toLowerCase());
            });
            if (match?.url) return match.url;
            const browse = links.find((l) => l.title?.toLowerCase().includes("browse"));
            if (browse?.url) return browse.url;
          }

          if (Object.keys(urls).length) {
            const urlEntry = Object.entries(urls).find(([k]) =>
              serviceType ? k.toLowerCase().includes(serviceType.toLowerCase()) : k.includes("browse")
            );
            if (urlEntry) return urlEntry[1];
            const browseEntry = Object.entries(urls).find(([k]) => k.includes("browse"));
            if (browseEntry) return browseEntry[1];
            return Object.values(urls)[0] ?? null;
          }

          return null;
        } catch {
          return null;
        }
      },
      createBooking:     null,
      checkAvailability: null,
    },

    crm: supabase
      ? {
          async upsertContact(phone, data) {
            try {
              const { upsertContact } = await import("./crm.js");
              return await upsertContact(phone, crmSupabase ?? supabase, data?.client_id ?? "unknown", data);
            } catch { return null; }
          },
          async addTags(phone, tags, clientId) {
            try {
              const { addTagsToContact } = await import("./crm.js");
              await addTagsToContact(phone, tags, crmSupabase ?? supabase, clientId ?? "unknown");
            } catch { /* silent */ }
          },
          sendCampaign: null,
        }
      : null,

    messaging: supabase && twilioClient
      ? {
          async scheduleMessage(opts) {
            try {
              const { scheduleMessage } = await import("./scheduler.js");
              return await scheduleMessage(supabase, opts);
            } catch { return null; }
          },
        }
      : null,

    database:    supabase    ? { supabase }    : null,
    crmDatabase: crmSupabase ? { supabase: crmSupabase } : null,
  };
}
