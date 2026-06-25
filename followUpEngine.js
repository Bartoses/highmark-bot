// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UP ENGINE — Automated lead follow-up sequencing
//
// scheduleFollowUps(supabase, lead, fromPhone)
//   Inserts follow-up messages into scheduled_messages immediately after a
//   lead is captured. The cron worker (cron-worker.js) handles actual sending.
//   Safe to call without await — never blocks the SMS response path.
//
// checkAndMarkLeadEngaged(supabase, fromPhone)
//   Called fire-and-forget on every inbound SMS. If the sender has a lead in
//   NEW or CONTACTED status, marks it ENGAGED and cancels pending follow-ups.
//
// ── Adding / editing sequences ────────────────────────────────────────────────
// Edit the SEQUENCES object below. Each key is a lead_type value.
// Each step has: delayMs, messageType (logged in scheduled_messages), template(lead).
// template(lead) receives the full lead row from the DB — use any column.
// The worker sends from msg.metadata.from_phone (falls back to TWILIO_PHONE_NUMBER).
// ─────────────────────────────────────────────────────────────────────────────

import { scheduleMessage } from "./scheduler.js";
import { trackDemoEvent }  from "./demoAnalytics.js";

// ── Follow-up sequences ───────────────────────────────────────────────────────

const SEQUENCES = {
  demo: [
    {
      delayMs:     1 * 60 * 1000,           // ~1 minute
      messageType: "followup_1",
      template: (lead) =>
        `Hey${lead.contact_name ? ` ${lead.contact_name}` : ""} — this is Sean from Highmark. ` +
        `Saw you checked out the demo. Want me to set this up for your business this week?`,
    },
    {
      delayMs:     24 * 60 * 60 * 1000,     // +1 day
      messageType: "followup_2",
      template: () =>
        `Quick question — what kind of business are you running? ` +
        `I can tailor Highmark to your exact setup.`,
    },
    {
      delayMs:     3 * 24 * 60 * 60 * 1000, // +3 days
      messageType: "followup_3",
      template: () =>
        `Most businesses use Highmark to capture 10–30 extra leads/month. ` +
        `Want to see what it would look like for yours?`,
    },
  ],

  booking: [
    {
      delayMs:     2 * 60 * 1000,           // ~2 minutes
      messageType: "followup_1",
      template: (lead) =>
        `Hey${lead.contact_name ? ` ${lead.contact_name}` : ""} — ` +
        `thanks for reaching out! We received your request and will be in touch shortly.`,
    },
  ],

  waitlist: [
    {
      delayMs:     5 * 60 * 1000,           // ~5 minutes
      messageType: "followup_1",
      template: (lead) =>
        `Hey${lead.contact_name ? ` ${lead.contact_name}` : ""} — ` +
        `you're on the list! We'll reach out as soon as a spot opens up.`,
    },
  ],
};

// ── scheduleFollowUps ─────────────────────────────────────────────────────────
// Inserts all sequence messages for the lead into scheduled_messages.
// fromPhone: the Twilio number to send from (stored in metadata for the worker).

export async function scheduleFollowUps(supabase, lead, fromPhone) {
  if (!supabase || !lead?.id || !lead?.contact_phone) return;

  // Outbound guard — the test server runs in TEST_MODE; never write real
  // follow-up rows to the shared prod DB that the live cron would then deliver.
  // (Unit tests call this directly in the runner process, which has no
  // TEST_MODE, so their mock-DB assertions are unaffected.)
  if (process.env.TEST_MODE === "true") return;

  const leadType = lead.lead_type ?? "booking";
  const sequence = SEQUENCES[leadType] ?? SEQUENCES.booking;
  const now      = Date.now();

  let scheduledCount = 0;
  for (const step of sequence) {
    try {
      await scheduleMessage(supabase, {
        phone:        lead.contact_phone,
        body:         step.template(lead),
        message_type: step.messageType,
        client_id:    lead.client_id ?? "highmark_demo",
        lead_id:      lead.id,
        send_at:      new Date(now + step.delayMs).toISOString(),
        metadata: {
          from_phone: fromPhone ?? null,
          lead_type:  leadType,
          sequence:   "auto_followup",
        },
      });
      scheduledCount++;
    } catch (err) {
      console.error(`[FOLLOWUP] scheduleMessage failed (${step.messageType}):`, err.message);
    }
  }

  if (scheduledCount === 0) return;

  console.log(`[FOLLOWUP] Scheduled ${scheduledCount} follow-up(s) for lead ${lead.id} (type=${leadType})`);

  // Update next_follow_up_at on the lead (fire-and-forget)
  const firstSendAt = new Date(now + sequence[0].delayMs).toISOString();
  supabase.from("leads")
    .update({ next_follow_up_at: firstSendAt, updated_at: new Date().toISOString() })
    .eq("id", lead.id)
    .then()
    .catch((err) => console.error("[FOLLOWUP] next_follow_up_at update failed:", err.message));

  // Analytics (fire-and-forget)
  trackDemoEvent(supabase, {
    eventName:  "followup_scheduled",
    fromNumber: lead.contact_phone,
    clientId:   lead.client_id ?? "highmark_demo",
    metadata:   { lead_id: lead.id, count: scheduledCount, lead_type: leadType },
  });
}

// ── checkAndMarkLeadEngaged ───────────────────────────────────────────────────
// Called on every inbound SMS after TCPA/opt-out checks.
// Marks the lead ENGAGED and cancels pending follow-ups when a reply arrives.
// Non-throwing — never blocks inbound SMS handling.

export async function checkAndMarkLeadEngaged(supabase, fromPhone) {
  if (!supabase || !fromPhone) return;
  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("id, status, client_id")
      .eq("contact_phone", fromPhone)
      .in("status", ["new", "contacted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lead) return;

    const now = new Date().toISOString();

    await supabase.from("leads").update({
      status:            "engaged",
      last_contacted_at: now,
      updated_at:        now,
    }).eq("id", lead.id);

    console.log(`[FOLLOWUP] Lead ${lead.id} marked ENGAGED — inbound reply from ${fromPhone}`);

    // Cancel all pending follow-ups for this lead
    const { count } = await supabase
      .from("scheduled_messages")
      .update({
        status:     "cancelled",
        error:      "Lead replied — auto-follow-up cancelled",
        updated_at: now,
      })
      .eq("lead_id", lead.id)
      .eq("status", "pending")
      .select("id", { count: "exact", head: true });

    if (count > 0) {
      console.log(`[FOLLOWUP] Cancelled ${count} pending follow-up(s) for lead ${lead.id}`);
    }

    // Analytics (fire-and-forget)
    trackDemoEvent(supabase, {
      eventName:  "lead_engaged",
      fromNumber: fromPhone,
      clientId:   lead.client_id ?? "highmark_demo",
      metadata:   { lead_id: lead.id },
    });
  } catch (err) {
    console.error("[FOLLOWUP] checkAndMarkLeadEngaged error:", err.message);
  }
}
