// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CAMPAIGNS — Campaign management routes
//
// Mounted in index.js under requireUiAccess middleware.
// All routes read/write the campaigns + campaign_recipients tables in Supabase DB1.
//
// Routes:
//   POST  /admin/campaigns            — create a new campaign (draft or scheduled)
//   GET   /admin/campaigns            — list campaigns for a client
//   GET   /admin/campaigns/:id        — single campaign with stats
//   PATCH /admin/campaigns/:id        — update draft campaign (name, message_body, etc.)
//   POST  /admin/campaigns/:id/send   — enqueue campaign for immediate or scheduled send
//
// Requires db1_campaigns.sql migration to have been run.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCampaign,
  enqueueCampaign,
  getCampaignStats,
} from "./campaigns.js";
import {
  evaluateTrigger,
  fireCampaign,
  isCooledDown,
} from "./campaignTriggers.js";
import { getAllClients } from "./clients.js";

// ── POST /admin/campaigns ─────────────────────────────────────────────────────
export async function handleCreateCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const {
    client_id, name, message_body, audience_type, scheduled_at, metadata,
    campaign_type, trigger_type, trigger_config, cooldown_days, audience_filter,
  } = req.body;

  if (!client_id)    return res.status(400).json({ error: "client_id is required" });
  if (!name)         return res.status(400).json({ error: "name is required" });
  if (!message_body) return res.status(400).json({ error: "message_body is required" });

  if (campaign_type === "event_triggered" && !trigger_type) {
    return res.status(400).json({ error: "trigger_type is required for event_triggered campaigns" });
  }

  try {
    const campaign = await createCampaign(supabase, {
      clientId:      client_id,
      name,
      messageBody:   message_body,
      audienceType:  audience_type ?? audience_filter ?? "all_leads",
      scheduledAt:   scheduled_at ?? null,
      metadata:      metadata ?? {},
      campaignType:  campaign_type ?? "manual",
      triggerType:   trigger_type ?? null,
      triggerConfig: trigger_config ?? {},
      cooldownDays:  cooldown_days ?? 7,
      audienceFilter: audience_filter ?? audience_type ?? "all_leads",
    });
    return res.status(201).json({ campaign });
  } catch (err) {
    console.error("[ADMIN CAMPAIGNS] create error:", err.message);
    return res.status(400).json({ error: err.message });
  }
}

// ── GET /admin/campaigns ──────────────────────────────────────────────────────
// Query params: client_id (required), status, limit (default 50), offset (default 0)
export async function handleListCampaigns(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { client_id, status, limit = 50, offset = 0 } = req.query;
  if (!client_id) return res.status(400).json({ error: "client_id query param is required" });

  let query = supabase
    .from("campaigns")
    .select("*", { count: "exact" })
    .eq("client_id", client_id)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) {
    console.error("[ADMIN CAMPAIGNS] list error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ campaigns: data ?? [], total: count ?? 0 });
}

// ── GET /admin/campaigns/:id ──────────────────────────────────────────────────
export async function handleGetCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .single();

  if (error) return res.status(404).json({ error: "Campaign not found" });

  const stats = await getCampaignStats(supabase, id);
  return res.json({ campaign: data, stats });
}

// ── PATCH /admin/campaigns/:id ────────────────────────────────────────────────
// Only drafts can be edited.
export async function handleUpdateCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;

  // Verify the campaign exists and is still a draft
  const { data: existing, error: fetchErr } = await supabase
    .from("campaigns")
    .select("id, status")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) return res.status(404).json({ error: "Campaign not found" });
  if (existing.status !== "draft") {
    return res.status(409).json({ error: `Cannot edit campaign in status "${existing.status}" — only drafts can be updated` });
  }

  const allowed = [
    "name", "message_body", "audience_type", "scheduled_at", "metadata",
    "trigger_type", "trigger_config", "cooldown_days", "audience_filter",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("campaigns")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[ADMIN CAMPAIGNS] update error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ campaign: data });
}

// ── POST /admin/campaigns/:id/send ────────────────────────────────────────────
// Enqueues the campaign: selects audience, creates recipients, schedules messages.
// Body: { from_phone } (optional — falls back to TWILIO_PHONE_NUMBER)
export async function handleSendCampaign(req, res, supabase, crmSupabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;

  // Fetch campaign
  const { data: campaign, error: fetchErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !campaign) return res.status(404).json({ error: "Campaign not found" });

  // Prefer: explicit override → client's configured outbound phone → global env var
  const client = getAllClients()[campaign.client_id];
  const fromPhone = req.body?.from_phone ?? client?.outboundPhone ?? process.env.TWILIO_PHONE_NUMBER ?? null;

  // Only draft or scheduled campaigns can be sent
  if (!["draft", "scheduled"].includes(campaign.status)) {
    return res.status(409).json({
      error: `Campaign is already in status "${campaign.status}" — only draft or scheduled campaigns can be sent`,
    });
  }

  try {
    const result = await enqueueCampaign(supabase, campaign, fromPhone, crmSupabase);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[ADMIN CAMPAIGNS] send error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /admin/simulate-event ────────────────────────────────────────────────
// Forces a trigger evaluation for active event campaigns matching client_id + trigger_type.
// override_data bypasses the KB cache for testing.
// bypass_cooldown: true skips the cooldown check.
export async function handleSimulateEvent(req, res, supabase, crmSupabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { client_id, trigger_type, override_data, bypass_cooldown } = req.body;
  if (!client_id)    return res.status(400).json({ error: "client_id is required" });
  if (!trigger_type) return res.status(400).json({ error: "trigger_type is required" });

  try {
    // Find matching active event campaigns for this client + trigger
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("client_id", client_id)
      .eq("campaign_type", "event_triggered")
      .eq("trigger_type", trigger_type)
      .eq("status", "active");

    if (!campaigns?.length) {
      return res.json({ fired: false, reason: "no_matching_campaigns", eligible_count: 0, scheduled: 0 });
    }

    const results = [];
    for (const campaign of campaigns) {
      // Cooldown check
      if (!bypass_cooldown && !isCooledDown(campaign.last_fired_at, campaign.cooldown_days)) {
        const nextEligibleAt = new Date(
          new Date(campaign.last_fired_at).getTime() +
          Number(campaign.cooldown_days ?? 7) * 24 * 60 * 60 * 1000
        ).toISOString();
        results.push({
          campaign_id:      campaign.id,
          campaign_name:    campaign.name,
          fired:            false,
          reason:           "cooldown",
          last_fired_at:    campaign.last_fired_at,
          next_eligible_at: nextEligibleAt,
          cooldown_days:    campaign.cooldown_days,
        });
        continue;
      }

      // Evaluate trigger (override_data bypasses KB lookup)
      const shouldFire = await evaluateTrigger(
        supabase,
        trigger_type,
        campaign.trigger_config ?? {},
        client_id,
        override_data ?? null
      );

      if (!shouldFire) {
        results.push({ campaign_id: campaign.id, campaign_name: campaign.name, fired: false, reason: "trigger_not_met" });
        continue;
      }

      // Get client row
      const { data: clientRow } = await supabase.from("clients").select("*").eq("id", client_id).single();
      if (!clientRow) {
        results.push({ campaign_id: campaign.id, campaign_name: campaign.name, fired: false, reason: "client_not_found" });
        continue;
      }

      const result = await fireCampaign(supabase, campaign, clientRow, crmSupabase);
      results.push({ campaign_id: campaign.id, campaign_name: campaign.name, ...result });
    }

    // Summary response
    const anyFired    = results.some(r => r.fired);
    const totalSched  = results.reduce((s, r) => s + (r.scheduled ?? 0), 0);
    const totalElig   = results.reduce((s, r) => s + (r.eligible_count ?? 0), 0);
    const firstResult = results[0] ?? {};
    return res.json({
      fired:           anyFired,
      campaigns_count: campaigns.length,
      eligible_count:  totalElig,
      scheduled:       totalSched,
      results,
      // backward compat: expose top-level cooldown fields if single campaign
      ...(results.length === 1 ? firstResult : {}),
    });
  } catch (err) {
    console.error("[ADMIN SIMULATE-EVENT] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
