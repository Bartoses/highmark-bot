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
import { normalizePhone }  from "./phoneUtils.js";

const VALID_AUDIENCE_TYPES = [
  "all_leads", "engaged_leads", "new_leads", "missed_leads",
  "crm_contacts",    // DB2 opted-in CRM contacts (FareHarbor customers)
  "all_contacts",    // DB1 leads + DB2 CRM contacts merged & deduped
  "past_guests",     // DB2 daily_manifest filtered by activity/season/category/company/pax/start_date
  "custom_phones",   // Manually entered phone numbers (testing or one-off sends)
];
const VALID_STATUSES       = ["draft", "scheduled", "sending", "sent", "failed"];
const PACE_MS              = 200; // ms between messages to avoid Twilio rate limits

// ── createCampaign ────────────────────────────────────────────────────────────
// Inserts a new campaign in DRAFT status. Returns the created row.

export async function createCampaign(supabase, {
  clientId,
  name,
  messageBody,
  audienceType   = "all_leads",
  scheduledAt    = null,
  metadata       = {},
  // Smart event campaign fields
  campaignType   = "manual",
  triggerType    = null,
  triggerConfig  = {},
  cooldownDays   = 7,
  audienceFilter = null,
}) {
  if (!VALID_AUDIENCE_TYPES.includes(audienceType)) {
    throw new Error(`Invalid audience_type: ${audienceType}. Must be one of: ${VALID_AUDIENCE_TYPES.join(", ")}`);
  }

  // Event-triggered campaigns are always "active" (ready to fire); manual campaigns start as draft
  const initialStatus = campaignType === "event_triggered" ? "active" : (scheduledAt ? "scheduled" : "draft");

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      client_id:       clientId,
      name,
      message_body:    messageBody,
      audience_type:   audienceType,
      status:          initialStatus,
      scheduled_at:    scheduledAt ?? null,
      metadata,
      campaign_type:   campaignType,
      trigger_type:    triggerType ?? null,
      trigger_config:  triggerConfig,
      cooldown_days:   cooldownDays,
      audience_filter: audienceFilter ?? audienceType,
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
// Returns the list of contacts to target for a given campaign.
// Result shape: [{ id, contact_phone, contact_name, source }]
//   source: "lead" | "crm" | "manifest" | "manual"
//
// audience_type values:
//   all_leads / engaged_leads / new_leads / missed_leads — DB1 leads only
//   crm_contacts   — DB2 opted-in CRM contacts (FareHarbor customers)
//   all_contacts   — DB1 leads + DB2 CRM contacts, merged & deduped by phone
//   past_guests    — DB2 daily_manifest with filters (activity/season/category/company/pax/start_date)
//   custom_phones  — manually supplied phone list (filterConfig.phones[])
//
// filterConfig for past_guests:
//   { activity, category, company, season, start_date, booked_after, booked_before, min_pax }
// filterConfig for custom_phones:
//   { phones: ["+15550001234", ...] }

export async function selectAudience(supabase, { clientId, audienceType, filterConfig = {} }, crmSupabase = null) {
  // ── Manually entered phones ────────────────────────────────────────────────
  if (audienceType === "custom_phones") {
    return parsePhoneList(filterConfig.phones ?? []);
  }

  // ── DB2 CRM contacts only ──────────────────────────────────────────────────
  if (audienceType === "crm_contacts") {
    return fetchCrmContacts(crmSupabase);
  }

  // ── DB2 past/upcoming guests from daily_manifest with filters ─────────────
  if (audienceType === "past_guests") {
    return fetchPastGuests(crmSupabase, filterConfig);
  }

  // ── DB1 leads query ────────────────────────────────────────────────────────
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
    case "missed_leads":
      // leads that came in 7+ days ago with no engagement — recovery targets
      query = query
        .in("status", ["new", "contacted"])
        .lte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case "all_leads":
    default:
      // all active leads — exclude converted/closed/ignored
      query = query.in("status", ["new", "contacted", "engaged", "scheduled"]);
      break;
  }

  const { data, error } = await query;
  if (error) throw new Error(`[CAMPAIGNS] selectAudience failed: ${error.message}`);
  const db1Leads = (data ?? []).map((l) => ({ ...l, source: "lead" }));

  // ── Merge DB2 contacts for all_contacts ───────────────────────────────────
  if (audienceType === "all_contacts") {
    const crmContacts = await fetchCrmContacts(crmSupabase);
    return mergeByPhone(db1Leads, crmContacts);
  }

  return db1Leads;
}

// Parse a raw phone list (array or comma/newline-separated string) into contact rows.
// Normalizes each number; silently drops blanks and unparseable entries.
function parsePhoneList(rawPhones) {
  const lines = Array.isArray(rawPhones)
    ? rawPhones
    : String(rawPhones).split(/[\n,]+/);

  const seen = new Set();
  const result = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizePhone(trimmed) ?? trimmed;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ id: null, contact_phone: normalized, contact_name: null, source: "manual" });
  }
  return result;
}

// Fetch opted-in contacts from DB2 CRM.
// Falls back to empty array if crmSupabase is not configured.
async function fetchCrmContacts(crmSupabase) {
  if (!crmSupabase) {
    console.warn("[CAMPAIGNS] crm_contacts requested but CRM_SUPABASE_URL is not configured");
    return [];
  }
  const { data, error } = await crmSupabase
    .from("contacts")
    .select("phone, first_name, last_name")
    .eq("opted_in", true)
    .not("phone", "is", null);

  if (error) throw new Error(`[CAMPAIGNS] fetchCrmContacts failed: ${error.message}`);

  return (data ?? []).map((c) => ({
    id:            null,
    contact_phone: c.phone,
    contact_name:  [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
    source:        "crm",
  }));
}

// Merge two contact arrays, deduplicating by phone. DB1 leads take precedence.
function mergeByPhone(db1Leads, crmContacts) {
  const seen = new Set(db1Leads.map((l) => l.contact_phone));
  const newFromCrm = crmContacts.filter((c) => !seen.has(c.contact_phone));
  return [...db1Leads, ...newFromCrm];
}

// Maps a season keyword to { after, before } ISO date strings.
// Targets the most recently completed or current season.
function seasonToDateRange(season) {
  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12

  switch (season) {
    case "winter": {
      // Current/most-recent winter: Dec (year-1) – Mar year if Jan-May, else Dec year – Mar (year+1)
      const wy = month <= 5 ? year - 1 : year;
      return { after: `${wy}-12-01`, before: `${wy + 1}-03-31` };
    }
    case "last_winter": {
      const wy = month <= 5 ? year - 2 : year - 1;
      return { after: `${wy}-12-01`, before: `${wy + 1}-03-31` };
    }
    case "summer": {
      // Current/most-recent summer: Jun-Oct
      const sy = (month >= 6 && month <= 10) ? year : year - 1;
      return { after: `${sy}-06-01`, before: `${sy}-10-31` };
    }
    case "last_summer": {
      const sy = (month >= 6 && month <= 10) ? year - 1 : year - 2;
      return { after: `${sy}-06-01`, before: `${sy}-10-31` };
    }
    default:
      return null;
  }
}

// Queries DB2 daily_manifest with optional filters, deduplicates by phone,
// then joins contacts to get names and exclude opted-out numbers.
async function fetchPastGuests(crmSupabase, filterConfig = {}) {
  if (!crmSupabase) {
    console.warn("[CAMPAIGNS] past_guests requested but CRM_SUPABASE_URL is not configured");
    return [];
  }

  let query = crmSupabase
    .from("daily_manifest")
    .select("phone, customer_name, activity, category, company, start_at, pax")
    .not("phone", "is", null);

  if (filterConfig.activity) {
    query = query.ilike("activity", `%${filterConfig.activity}%`);
  }
  if (filterConfig.category) {
    query = query.ilike("category", `%${filterConfig.category}%`);
  }
  if (filterConfig.company) {
    query = query.ilike("company", `%${filterConfig.company}%`);
  }
  // Specific day takes full precedence — used for "tomorrow's bookings" etc.
  if (filterConfig.start_date) {
    query = query
      .gte("start_at", filterConfig.start_date + "T00:00:00")
      .lte("start_at", filterConfig.start_date + "T23:59:59");
  } else {
    // Season preset → date range (explicit dates can further narrow)
    if (filterConfig.season && filterConfig.season !== "all") {
      const range = seasonToDateRange(filterConfig.season);
      if (range) query = query.gte("start_at", range.after).lte("start_at", range.before);
    }
    if (filterConfig.booked_after)  query = query.gte("start_at", filterConfig.booked_after);
    if (filterConfig.booked_before) query = query.lte("start_at", filterConfig.booked_before + "T23:59:59");
  }
  if (filterConfig.min_pax) query = query.gte("pax", Number(filterConfig.min_pax));

  const { data, error } = await query;
  if (error) throw new Error(`[CAMPAIGNS] fetchPastGuests failed: ${error.message}`);

  // Deduplicate by phone — first occurrence wins
  const phoneMap = new Map();
  for (const row of data ?? []) {
    if (row.phone && !phoneMap.has(row.phone)) {
      phoneMap.set(row.phone, {
        id:            null,
        contact_phone: row.phone,
        contact_name:  row.customer_name ?? null,
        source:        "manifest",
      });
    }
  }
  if (phoneMap.size === 0) return [];

  // Join contacts to get better names and filter opted-out numbers
  const phones = [...phoneMap.keys()];
  try {
    const { data: contacts } = await crmSupabase
      .from("contacts")
      .select("phone, first_name, last_name, opted_in")
      .in("phone", phones);

    const contactMap = new Map((contacts ?? []).map((c) => [c.phone, c]));

    return [...phoneMap.values()]
      .filter((p) => {
        const c = contactMap.get(p.contact_phone);
        return !c || c.opted_in !== false; // exclude only explicitly opted-out
      })
      .map((p) => {
        const c = contactMap.get(p.contact_phone);
        if (c) {
          const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ");
          if (fullName) p.contact_name = fullName;
        }
        return p;
      });
  } catch {
    // Contacts join unavailable — return manifest data without opt-in filtering
    return [...phoneMap.values()];
  }
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

  // 1. Select audience (filterConfig from metadata supports past_guests filters)
  const leads = await selectAudience(supabase, {
    clientId:     campaign.client_id,
    audienceType: campaign.audience_type,
    filterConfig: campaign.metadata?.filter_config ?? {},
  }, crmSupabase);

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

export function interpolateMessage(body, lead = {}, client = {}) {
  const bookingLink = client.bookingLink ?? client.booking_link ?? "";
  return String(body)
    .replace(/\{\{name\}\}/gi,         lead.contact_name ?? "there")
    .replace(/\{\{first_name\}\}/gi,   (lead.contact_name ?? "there").split(" ")[0])
    .replace(/\{\{booking_link\}\}/gi, bookingLink)
    .replace(/\{\{\w+\}\}/gi,          "");
}
