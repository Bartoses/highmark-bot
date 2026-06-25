// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN TRIGGERS — Sprint 4B Smart Event Campaigns
//
// Evaluates trigger conditions from cached knowledge_base data.
// Never makes external API calls — KB cache is the source of truth.
// If data is unavailable, returns false (never fire on missing data).
//
// Exports:
//   evaluateTrigger(supabase, type, config, clientId, overrideData?)
//   fireCampaign(supabase, campaign, client, crmSupabase)
//   evaluateEventCampaigns(supabase, crmSupabase)
// ─────────────────────────────────────────────────────────────────────────────

import { scheduleMessage } from "./scheduler.js";

const PACE_MS = 200;

// ── Trigger evaluation ────────────────────────────────────────────────────────

export async function evaluateTrigger(supabase, triggerType, triggerConfig = {}, clientId, overrideData = null) {
  switch (triggerType) {
    case "snow_fresh":    return evaluateSnowFresh(supabase, triggerConfig, clientId, overrideData);
    case "good_weather":  return evaluateGoodWeather(supabase, triggerConfig, clientId, overrideData);
    case "opening_date":  return evaluateOpeningDate(triggerConfig);
    case "custom_date":   return evaluateCustomDate(triggerConfig);
    default:              return false;
  }
}

async function evaluateSnowFresh(supabase, config, clientId, override) {
  const threshold = Number(config.threshold_inches ?? 6);

  // Use override data (for simulation/testing)
  if (override) {
    const newSnow = override.new_snow_24h ?? override.snow_depth_in ?? 0;
    return Number(newSnow) >= threshold;
  }

  // Check SNOTEL snow depth first
  try {
    const { data: snowRow } = await supabase
      .from("knowledge_base")
      .select("data, fetched_at")
      .eq("key", "snow_conditions")
      .single();

    if (snowRow?.data?.stations) {
      const maxDepth = Math.max(
        0,
        ...Object.values(snowRow.data.stations)
          .map(s => s.snow_depth_in ?? 0)
          .filter(v => !isNaN(v))
      );
      if (maxDepth > 0) return maxDepth >= threshold;
    }
  } catch { /* fall through to weather */ }

  // Fall back to weather forecast snow accumulation (today)
  try {
    const { data: weatherRow } = await supabase
      .from("knowledge_base")
      .select("data")
      .eq("key", "weather_steamboat")
      .single();

    if (weatherRow?.data?.forecast) {
      const today = new Date().toISOString().slice(0, 10);
      const todayForecast = weatherRow.data.forecast[today];
      if (todayForecast?.snow > 0) return todayForecast.snow >= threshold;
    }
  } catch { /* no data */ }

  return false;
}

async function evaluateGoodWeather(supabase, config, clientId, override) {
  const minTemp = Number(config.min_temp_f ?? 32);
  const badConditions = ["rain", "storm", "blizzard", "heavy snow", "thunderstorm", "showers"];

  let temp, condition, isWeekend;

  if (override) {
    temp      = override.high_f ?? override.temperature ?? 0;
    condition = (override.condition ?? "").toLowerCase();
    isWeekend = override.is_weekend ?? ([0, 6].includes(new Date().getDay()));
  } else {
    const dayOfWeek = new Date().getDay();
    isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if (!isWeekend) return false;

    try {
      const { data: weatherRow } = await supabase
        .from("knowledge_base")
        .select("data")
        .eq("key", "weather_steamboat")
        .single();

      if (!weatherRow?.data?.steamboat) return false;
      const sb = weatherRow.data.steamboat;
      temp      = sb.temp ?? 0;
      condition = (sb.desc ?? "").toLowerCase();

      // Also check today's forecast high if available
      const today = new Date().toISOString().slice(0, 10);
      const forecast = weatherRow.data.forecast?.[today];
      if (forecast?.high) temp = Math.max(temp, forecast.high);
    } catch { return false; }
  }

  const tempOk      = Number(temp) >= minTemp;
  const conditionOk = !badConditions.some(bad => condition.includes(bad));
  return tempOk && conditionOk && isWeekend;
}

export function evaluateOpeningDate(config) {
  if (!config.open_date) return false;
  const today = new Date().toISOString().slice(0, 10);
  return today === config.open_date;
}

export function evaluateCustomDate(config) {
  if (!config.fire_date) return false;
  const today = new Date().toISOString().slice(0, 10);
  return today === config.fire_date;
}

export function isCooledDown(lastFiredAt, cooldownDays) {
  if (!lastFiredAt) return true;
  const daysSince = (Date.now() - new Date(lastFiredAt).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= Number(cooldownDays ?? 7);
}

// ── Audience resolution ───────────────────────────────────────────────────────

async function getCampaignAudience(supabase, clientId, audienceFilter) {
  let query = supabase
    .from("leads")
    .select("id, contact_phone, contact_name, status, created_at")
    .eq("client_id", clientId)
    .not("contact_phone", "is", null);

  switch (audienceFilter) {
    case "engaged_leads":
      query = query.in("status", ["engaged", "high_intent", "considering", "scheduled"]);
      break;
    case "new_leads":
      query = query.eq("status", "new")
        .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case "missed_leads":
      query = query
        .in("status", ["new", "contacted"])
        .lte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      break;
    case "all_leads":
    default:
      query = query.in("status", ["new", "contacted", "engaged", "high_intent", "considering", "scheduled"]);
      break;
  }

  const { data, error } = await query;
  if (error) throw new Error(`getCampaignAudience failed: ${error.message}`);
  return data ?? [];
}

async function filterEligibleContacts(supabase, contacts, campaignId, cooldownDays, crmSupabase) {
  const cutoff = new Date(Date.now() - Number(cooldownDays ?? 7) * 24 * 60 * 60 * 1000).toISOString();

  // Per-contact cooldown: who already received this campaign recently?
  const { data: recentSends } = await supabase
    .from("campaign_sends")
    .select("contact_phone")
    .eq("campaign_id", campaignId)
    .gte("sent_at", cutoff);

  const recentPhones = new Set((recentSends ?? []).map(s => s.contact_phone));

  // Opt-out list
  let optOutSet = new Set();
  const optOutSource = crmSupabase || supabase;
  try {
    const { data: optOuts } = await optOutSource.from("opt_outs").select("phone");
    optOutSet = new Set((optOuts ?? []).map(o => o.phone));
  } catch { /* no opt-out data — proceed */ }

  return contacts.filter(c => {
    if (!c.contact_phone) return false;
    if (recentPhones.has(c.contact_phone)) return false;
    if (optOutSet.has(c.contact_phone)) return false;
    return true;
  });
}

// ── Message personalization ───────────────────────────────────────────────────

export function personalizeEventMessage(template, lead, client) {
  const firstName   = lead.contact_name ? lead.contact_name.split(" ")[0] : "there";
  const name        = lead.contact_name || "there";
  const bookingLink = client.bookingLink ?? client.booking_link ?? "";
  return String(template)
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{name\}\}/gi, name)
    .replace(/\{\{booking_link\}\}/gi, bookingLink)
    .replace(/\{\{\w+\}\}/gi, "");  // remove unknown vars
}

// ── Fire campaign ─────────────────────────────────────────────────────────────

export async function fireCampaign(supabase, campaign, client, crmSupabase, { dryRun = false } = {}) {
  const audienceFilter = campaign.audience_filter || campaign.audience_type || "all_leads";
  const cooldownDays   = Number(campaign.cooldown_days ?? 7);

  const allContacts = await getCampaignAudience(supabase, campaign.client_id, audienceFilter);
  const eligible    = await filterEligibleContacts(supabase, allContacts, campaign.id, cooldownDays, crmSupabase);

  const fromPhone = client.outboundPhone ?? client.outbound_phone ?? process.env.TWILIO_PHONE_NUMBER ?? null;

  // Outbound guard — NEVER enqueue real sends from the test server (TEST_MODE)
  // or an explicit dry-run/preview. The test suite runs the web server with
  // TEST_MODE=true; without this, a simulate-event test would write real
  // scheduled_messages to the shared prod DB that the live cron then delivers.
  const noSend = dryRun || process.env.TEST_MODE === "true";
  if (noSend) {
    return { fired: true, eligible_count: eligible.length, scheduled: 0, dry_run: true };
  }

  let scheduled = 0;
  for (let i = 0; i < eligible.length; i++) {
    const lead = eligible[i];
    try {
      const msg    = personalizeEventMessage(campaign.message_body ?? campaign.message_template ?? "", lead, client);
      const sendAt = new Date(Date.now() + i * PACE_MS).toISOString();

      await scheduleMessage(supabase, {
        phone:        lead.contact_phone,
        body:         msg,
        message_type: "campaign",
        client_id:    campaign.client_id,
        lead_id:      lead.id ?? null,
        send_at:      sendAt,
        metadata: {
          from_phone:  fromPhone,
          campaign_id: campaign.id,
          event_triggered: true,
        },
      });

      await supabase.from("campaign_sends").insert({
        campaign_id:   campaign.id,
        client_id:     campaign.client_id,
        contact_phone: lead.contact_phone,
        status:        "scheduled",
      });

      scheduled++;
    } catch (err) {
      console.error(`[CAMPAIGN TRIGGERS] schedule failed for ${lead.contact_phone}:`, err.message);
    }
  }

  // Update stats regardless of eligible count
  await supabase.from("campaigns").update({
    last_fired_at: new Date().toISOString(),
    fire_count:    (Number(campaign.fire_count) || 0) + 1,
    updated_at:    new Date().toISOString(),
  }).eq("id", campaign.id);

  console.log(`[CAMPAIGN TRIGGERS] "${campaign.name}" fired — eligible=${eligible.length} scheduled=${scheduled}`);
  return { fired: true, eligible_count: eligible.length, scheduled };
}

// ── Cron evaluation loop ──────────────────────────────────────────────────────

export async function evaluateEventCampaigns(supabase, crmSupabase) {
  if (!supabase) return;
  try {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("*")
      .eq("campaign_type", "event_triggered")
      .eq("status", "active");

    if (!campaigns?.length) return;

    for (const campaign of campaigns) {
      try {
        if (!isCooledDown(campaign.last_fired_at, campaign.cooldown_days)) continue;

        const { data: clientRow } = await supabase
          .from("clients")
          .select("*")
          .eq("id", campaign.client_id)
          .single();

        if (!clientRow) continue;

        const shouldFire = await evaluateTrigger(
          supabase,
          campaign.trigger_type,
          campaign.trigger_config ?? {},
          campaign.client_id
        );

        if (shouldFire) await fireCampaign(supabase, campaign, clientRow, crmSupabase);
      } catch (err) {
        console.error(`[CAMPAIGN TRIGGERS] eval failed for ${campaign.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[CAMPAIGN TRIGGERS] evaluateEventCampaigns error:", err.message);
  }
}
