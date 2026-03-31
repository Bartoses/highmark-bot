// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGNS — Outbound SMS campaign engine
//
// createCampaign()    — insert a new campaign in DRAFT status
// selectAudience()    — resolve leads for a given audience_type + client
// enqueueCampaign()   — create recipients + schedule messages, returns counts
// getCampaignStats()  — aggregate counts from campaign_recipients
//
// Sending flow:
//   POST /admin/campaigns/:id/send
//   → enqueueCampaign() selects audience, creates campaign_recipients rows,
//     and inserts one scheduled_messages row per recipient.
//   → The existing cron worker (cron-worker.js, every 5 min) sends the messages.
//   → Worker updates campaign_recipients status on send/fail via metadata.
//
// Adding a new audience_type:
//   Add a case to selectAudience() below — no other changes required.
//
// Rate pacing:
//   Messages are staggered 200ms apart via send_at offsets so the worker
//   doesn't hammer Twilio with all recipients in a single batch.
// ─────────────────────────────────────────────────────────────────────────────

import { scheduleMessage } from "./scheduler.js";
import { trackDemoEvent }  from "./demoAnalytics.js";

const VALID_AUDIENCE_TYPES = ["all_leads", "engaged_leads", "new_leads"];
const VALID_STATUSES       = ["draft", "scheduled", "sending", "sent", "failed"];
const PACE_MS              = 200; // ms between messages to avoid Twilio rate limits

// ── createCampaign ────────────────────────────────────────────────────────────
// Inserts a new campaign in DRAFT status. Returns the created row.

export async function createCampaign(supabase, {
  clientId,
  name,
  messageBody,
  audienceType  = "all_leads",
  scheduledAt   = null,
  metadata      = {},
}) {
  if (!VALID_AUDIENCE_TYPES.includes(audienceType)) {
    throw new Error(`Invalid audience_type: ${audienceType}. Must be one of: ${VALID_AUDIENCE_TYPES.join(", ")}`);
  }

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      client_id:    clientId,
      name,
      message_body: messageBody,
      audience_type: audienceType,
      status:       scheduledAt ? "scheduled" : "draft",
      scheduled_at: scheduledAt ?? null,
      metadata,
    })
    .select()
    .single();

  if (error) throw new Error(`[CAMPAIGNS] createCampaign failed: ${error.message}`);

  console.log(`[CAMPAIGNS] Created "${name}" (id=${data.id}, type=${audienceType}, client=${clientId})`);

  // Analytics
  trackDemoEvent(supabase, {
    eventName: "campaign_created",
    clientId,
    metadata:  { campaign_id: data.id, audience_type: audienceType },
  });

  return data;
}

// ── selectAudience ────────────────────────────────────────────────────────────
// Returns the list of leads to target for a given campaign.
// Filters: must have a contact_phone, must not have opted out (future).

export async function selectAudience(supabase, { clientId, audienceType }) {
  let query = supabase
    .from("leads")
    .select("id, contact_phone, contact_name, status")
    .eq("client_id", clientId)
    .not("contact_phone", "is", null);

  switch (audienceType) {
    case "engaged_leads":
      query = query.eq("status", "engaged");
      break;
    case "new_leads":
      query = query.eq("status", "new");
      break;
    case "all_leads":
    default:
      // all active leads — exclude converted/closed/ignored
      query = query.in("status", ["new", "contacted", "engaged", "scheduled"]);
      break;
  }

  const { data, error } = await query;
  if (error) throw new Error(`[CAMPAIGNS] selectAudience failed: ${error.message}`);
  return data ?? [];
}

// ── enqueueCampaign ───────────────────────────────────────────────────────────
// Core send function:
//   1. Select audience
//   2. Create campaign_recipients rows (one per lead)
//   3. Schedule one message per recipient via scheduled_messages
//   4. Update campaign status → sending | scheduled
//
// fromPhone: the Twilio number to send from (stored in metadata for the worker)
// Returns { recipientCount, enqueued, skipped }

export async function enqueueCampaign(supabase, campaign, fromPhone, crmSupabase) {
  const now = Date.now();

  // 1. Select audience
  const leads = await selectAudience(supabase, {
    clientId:     campaign.client_id,
    audienceType: campaign.audience_type,
  });

  if (leads.length === 0) {
    console.log(`[CAMPAIGNS] ${campaign.id} — no recipients for audience=${campaign.audience_type}`);
    await supabase.from("campaigns").update({
      status:     "sent",
      sent_at:    new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata:   { ...(campaign.metadata ?? {}), recipient_count: 0, note: "No recipients matched" },
    }).eq("id", campaign.id);
    return { recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  // 1b. Filter opted-out leads at enqueue time (defense-in-depth — scheduler also checks)
  let eligibleLeads = leads;
  let optedOutSkipped = 0;
  if (crmSupabase) {
    try {
      const { data: optOuts } = await crmSupabase.from("opt_outs").select("phone");
      const optOutSet = new Set((optOuts ?? []).map((o) => o.phone));
      eligibleLeads = leads.filter((l) => {
        if (optOutSet.has(l.contact_phone)) { optedOutSkipped++; return false; }
        return true;
      });
      if (optedOutSkipped > 0) {
        console.log(`[CAMPAIGNS] ${campaign.id} — skipped ${optedOutSkipped} opted-out leads`);
      }
    } catch (err) {
      console.error("[CAMPAIGNS] opt-out pre-filter failed, proceeding without filter:", err.message);
    }
  }

  // Determine send_at base: scheduled campaigns use scheduled_at, immediate use now
  const sendBase = campaign.scheduled_at
    ? new Date(campaign.scheduled_at).getTime()
    : now;

  let enqueued = 0;
  let skipped  = optedOutSkipped;

  // 2 + 3. Create recipient rows and schedule messages
  for (let i = 0; i < eligibleLeads.length; i++) {
    const lead = eligibleLeads[i];

    try {
      // Insert recipient record
      const { data: recipient, error: rErr } = await supabase
        .from("campaign_recipients")
        .insert({
          campaign_id: campaign.id,
          lead_id:     lead.id ?? null,
          phone:       lead.contact_phone,
          status:      "pending",
        })
        .select("id")
        .single();

      if (rErr) {
        console.warn(`[CAMPAIGNS] recipient insert failed for ${lead.contact_phone}:`, rErr.message);
        skipped++;
        continue;
      }

      // Schedule message — stagger 200ms per recipient
      const sendAt = new Date(sendBase + i * PACE_MS).toISOString();

      await scheduleMessage(supabase, {
        phone:        lead.contact_phone,
        body:         interpolateMessage(campaign.message_body, lead),
        message_type: "campaign",
        client_id:    campaign.client_id,
        lead_id:      lead.id ?? null,
        send_at:      sendAt,
        metadata: {
          from_phone:           fromPhone ?? null,
          campaign_id:          campaign.id,
          campaign_recipient_id: recipient.id,
          audience_type:        campaign.audience_type,
        },
      });

      enqueued++;
    } catch (err) {
      console.error(`[CAMPAIGNS] enqueue failed for ${lead.contact_phone}:`, err.message);
      skipped++;
    }
  }

  // 4. Update campaign status
  const isScheduled = campaign.scheduled_at && new Date(campaign.scheduled_at) > new Date();
  const newStatus   = isScheduled ? "scheduled" : "sending";

  await supabase.from("campaigns").update({
    status:     newStatus,
    sent_at:    new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {
      ...(campaign.metadata ?? {}),
      recipient_count: leads.length,
      enqueued,
      skipped,
      opted_out_skipped: optedOutSkipped,
      from_phone: fromPhone ?? null,
    },
  }).eq("id", campaign.id);

  console.log(`[CAMPAIGNS] ${campaign.id} "${campaign.name}" → status=${newStatus}, enqueued=${enqueued}/${leads.length}${optedOutSkipped ? ` (${optedOutSkipped} opted-out skipped)` : ""}`);

  // Analytics
  trackDemoEvent(supabase, {
    eventName: "campaign_sent",
    clientId:  campaign.client_id,
    metadata:  { campaign_id: campaign.id, enqueued, skipped, recipient_count: leads.length },
  });

  return { recipientCount: leads.length, enqueued, skipped, optedOutSkipped };
}

// ── getCampaignStats ──────────────────────────────────────────────────────────
// Returns aggregate counts from campaign_recipients for a given campaign.

export async function getCampaignStats(supabase, campaignId) {
  const { data, error } = await supabase
    .from("campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);

  if (error || !data) return { total: 0, pending: 0, sent: 0, failed: 0, cancelled: 0 };

  const counts = { total: data.length, pending: 0, sent: 0, failed: 0, cancelled: 0 };
  for (const row of data) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

// ── interpolateMessage ────────────────────────────────────────────────────────
// Lightweight template substitution. Replaces {{name}} with lead.contact_name.
// Structured for future expansion — add new variables here as needed.

export function interpolateMessage(body, lead = {}) {
  return body
    .replace(/\{\{name\}\}/gi,     lead.contact_name ?? "there")
    .replace(/\{\{first_name\}\}/gi, (lead.contact_name ?? "there").split(" ")[0]);
}
