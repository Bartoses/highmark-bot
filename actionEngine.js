// ─────────────────────────────────────────────────────────────────────────────
// actionEngine.js — Agent Action Execution Layer (Phase 4)
// Highmark by Whiteout Solutions
//
// Transforms AI-generated action directives into real-world operations.
// All actions are wrapped in try/catch and return a structured result.
// Never throws — always returns { success, result, fallbackMessage }.
//
// Caller contract:
//   integrations.booking   — availability checks, booking link resolution
//   integrations.crm       — contact upsert, tagging, opt-out enforcement
//   integrations.messaging — scheduled messages, Twilio sends
//   integrations.database  — raw Supabase query access
//
// Each integration is optional. If missing, the action fails gracefully.
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

const GLOBAL_FALLBACK = fail("Something went wrong — let me help another way.");

// ─────────────────────────────────────────────────────────────────────────────
// ACTION HANDLERS
// Each handler receives (data, context, client, integrations) and returns
// { success, result, fallbackMessage }. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

// ── create_booking ────────────────────────────────────────────────────────────
// Attempts to create a booking via integrations.booking.createBooking().
// If integration unavailable or creation fails, returns a direct booking link.
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

    // Integration missing or returned nothing — fall back to booking link
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
// Queries the booking integration for open slots on a given date.
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
// Saves a new contact/lead to the CRM.
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
// Merges new fields into an existing CRM contact. Never overwrites opted_out.
async function handleUpdateContact(data, context, client, integrations) {
  try {
    const phone = data.phone ?? context?.phone ?? null;
    if (!phone) return fail("No phone number provided to update contact.", {});

    if (!integrations?.crm?.upsertContact) {
      return fail("CRM update unavailable right now.", {});
    }

    // Strip opted_out from update payload — never allow downstream override
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
// Schedules a follow-up message via the messaging integration.
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

// ── send_campaign ─────────────────────────────────────────────────────────────
// Triggers an outbound campaign to a segment, respecting opt-outs.
async function handleSendCampaign(data, context, client, integrations) {
  try {
    if (!integrations?.crm?.sendCampaign) {
      return fail("Campaign system unavailable.", {});
    }

    const campaignData = {
      client_id: client?.id    ?? null,
      segment:   data.segment  ?? "all_leads",
      message:   data.message  ?? data.body ?? null,
      name:      data.name     ?? `Agent campaign ${new Date().toISOString().slice(0, 10)}`,
    };

    if (!campaignData.message) {
      return fail("No message body provided for campaign.", {});
    }

    const result = await integrations.crm.sendCampaign(campaignData);
    return ok({ campaignId: result?.id ?? null, segment: campaignData.segment, status: result?.status ?? "queued" });
  } catch (e) {
    console.error("[actionEngine] send_campaign error:", e.message);
    return fail("Couldn't launch campaign right now.", {});
  }
}

// ── generate_report ───────────────────────────────────────────────────────────
// Queries the database for a structured operational summary.
async function handleGenerateReport(data, context, client, integrations) {
  try {
    if (!integrations?.database?.supabase) {
      return fail("Database unavailable for reporting.", {});
    }

    const supabase  = integrations.database.supabase;
    const clientId  = client?.id ?? null;
    const report    = {};

    // Bookings count (from confirmations_sent)
    try {
      const { count: bookingCount } = await supabase
        .from("confirmations_sent")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      report.totalBookings = bookingCount ?? 0;
    } catch {
      report.totalBookings = null;
    }

    // Lead count
    try {
      const { count: leadCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      report.totalLeads = leadCount ?? 0;
    } catch {
      report.totalLeads = null;
    }

    // Scheduled messages pending
    try {
      const { count: pendingCount } = await supabase
        .from("scheduled_messages")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("status", "pending");
      report.pendingFollowups = pendingCount ?? 0;
    } catch {
      report.pendingFollowups = null;
    }

    // Open slots (from knowledge_base availability summary)
    try {
      const { data: kbRows } = await supabase
        .from("knowledge_base")
        .select("summary")
        .eq("client_id", clientId)
        .ilike("key", "%fareharbor%")
        .order("fetched_at", { ascending: false })
        .limit(1);
      report.availabilitySummary = kbRows?.[0]?.summary ?? null;
    } catch {
      report.availabilitySummary = null;
    }

    report.generatedAt = new Date().toISOString();
    report.clientId    = clientId;

    return ok(report);
  } catch (e) {
    console.error("[actionEngine] generate_report error:", e.message);
    return fail("Couldn't generate report right now.", {});
  }
}

// ── escalate_to_human ─────────────────────────────────────────────────────────
// Returns a handoff fallback message. No API calls needed.
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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DISPATCHER
// Routes action strings to their handlers. All paths are try/catch wrapped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute an agent action and return a structured result.
 *
 * @param {{ action: string, data?: object, context?: object, client?: object, integrations?: object }} params
 * @returns {Promise<{ success: boolean, result: object, fallbackMessage: string|null }>}
 */
export async function executeAction(params) {
  // Accept null/undefined/non-object input gracefully
  const { action, data = {}, context = {}, client = {}, integrations = {} } = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};
  try {
    if (!action || typeof action !== "string") {
      return fail("No action specified.");
    }

    switch (action.toLowerCase().trim()) {
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

      case "send_campaign":
        return await handleSendCampaign(data, context, client, integrations);

      case "generate_report":
        return await handleGenerateReport(data, context, client, integrations);

      case "escalate_to_human":
        return handleEscalateToHuman(data, context, client);

      default:
        console.warn(`[actionEngine] Unknown action: "${action}"`);
        return fail(`Action "${action}" is not supported.`);
    }
  } catch (e) {
    console.error("[actionEngine] executeAction fatal error:", e.message);
    return { ...GLOBAL_FALLBACK };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION BUILDER HELPERS
// Convenience factories for constructing the integrations object from existing
// Highmark modules. Pass the result into executeAction({ integrations }).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the integrations object from live Highmark module instances.
 * All fields are optional — missing integrations cause graceful fallbacks.
 *
 * @param {{ supabase, crmSupabase, twilioClient, client }} opts
 * @returns {object} integrations
 */
export function buildIntegrations({ supabase = null, crmSupabase = null, twilioClient = null, client = null } = {}) {
  return {
    booking: {
      // Resolve a direct booking link for a service type using client config
      getBookingLink(serviceType, c) {
        try {
          const cl       = c ?? client;
          const links    = cl?.bookingLinks ?? [];
          const urls     = cl?.bookingUrls  ?? {};

          // Try portal-managed booking options first
          if (Array.isArray(links) && links.length) {
            const match = links.find((l) => {
              if (!l?.url) return false;
              if (!serviceType) return !!l.metadata_json?.category?.includes("browse");
              return (l.title ?? "").toLowerCase().includes(serviceType.toLowerCase())
                || (l.metadata_json?.category ?? "").includes(serviceType.toLowerCase());
            });
            if (match?.url) return match.url;
            // Fallback to browse-all within portal links
            const browse = links.find((l) => l.title?.toLowerCase().includes("browse"));
            if (browse?.url) return browse.url;
          }

          // Try static bookingUrls
          if (Object.keys(urls).length) {
            const urlEntry = Object.entries(urls).find(([k]) =>
              serviceType ? k.toLowerCase().includes(serviceType.toLowerCase()) : k.includes("browse")
            );
            if (urlEntry) return urlEntry[1];
            // Browse-all fallback
            const browseEntry = Object.entries(urls).find(([k]) => k.includes("browse"));
            if (browseEntry) return browseEntry[1];
            // First available link
            return Object.values(urls)[0] ?? null;
          }

          return null;
        } catch {
          return null;
        }
      },
      // createBooking and checkAvailability are plugged in when FH integration is live
      createBooking:    null,
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
          sendCampaign: null, // wired in when campaign module ready
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

    database: supabase ? { supabase } : null,
  };
}
