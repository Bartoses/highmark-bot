// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — AI Optimization Engine
//
// Rule-based analysis of real conversations to surface actionable insights.
// No ML — pure heuristics on stored conversation + lead data.
//
// Exports:
//   runOptimizationAnalysis(supabase, client)
//     → runs full pipeline: collect → analyze → generate → save
//   getOptimizationInsights(supabase, clientId)
//     → fetch latest insights + score from DB
//   dismissInsight(supabase, id, clientId)
//     → mark an insight dismissed
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS_WINDOW_DAYS  = 30;  // look back 30 days
const MIN_CONVERSATIONS      = 5;   // don't analyze if fewer than 5 convos

// ── Data collection ───────────────────────────────────────────────────────────

async function collectConversationMetrics(supabase, clientId) {
  const since = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 86400_000).toISOString();

  // Fetch recent conversations for this client (exclude test sessions)
  const { data: convos, error } = await supabase
    .from("conversations")
    .select("from_number, to_number, messages, booking_step, booking_data, handoff, consecutive_frustrated, created_at, updated_at, session_type")
    .eq("client_id", clientId)
    .neq("session_type", "test")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error || !convos) return { convos: [], leads: [], total: 0 };

  // Fetch leads for this client in the same window
  const { data: leads } = await supabase
    .from("leads")
    .select("id, from_number, status, lead_type, source, created_at")
    .eq("client_id", clientId)
    .neq("source", "ui")
    .gte("created_at", since);

  return {
    convos: convos ?? [],
    leads:  leads  ?? [],
    total:  convos?.length ?? 0,
  };
}

// ── Per-conversation feature extraction ───────────────────────────────────────

function extractConvoFeatures(convo) {
  const messages  = convo.messages ?? [];
  const userMsgs  = messages.filter(m => m.role === "user");
  const botMsgs   = messages.filter(m => m.role === "assistant");

  // Intent and sentiment are stored on message objects
  const intents   = messages.map(m => m.intent).filter(Boolean);
  const sentiments= messages.map(m => m.sentiment).filter(Boolean);

  const bookingData = convo.booking_data ?? {};
  const stage       = bookingData._stage ?? "new";

  return {
    id:               `${convo.from_number}:${convo.to_number}`,
    messageCount:     messages.length,
    userMessageCount: userMsgs.length,
    botMessageCount:  botMsgs.length,
    intents:          [...new Set(intents)],
    sentiments,
    finalStage:       stage,
    bookingStep:      convo.booking_step ?? null,
    handoff:          !!convo.handoff,
    frustrated:       (convo.consecutive_frustrated ?? 0) > 0 ||
                      sentiments.includes("frustrated"),
    leadCaptured:     stage === "lead_captured" ||
                      ["lead_captured", "closed"].includes(stage),
    hasBookingIntent: intents.includes("booking"),
    hasConditionsIntent: intents.includes("conditions"),
    hasPricingIntent: userMsgs.some(m =>
                        /price|pric|cost|how much|fee|rate/i.test(m.content ?? "")),
    hasAvailabilityIntent: userMsgs.some(m =>
                        /available|availab|open|slot|spot|date|when/i.test(m.content ?? "")),
    lastUserMsg:      userMsgs.at(-1)?.content ?? "",
    firstBotMsg:      botMsgs[0]?.content ?? "",
    daysSinceUpdate:  (Date.now() - new Date(convo.updated_at).getTime()) / 86400_000,
  };
}

// ── Analysis functions ─────────────────────────────────────────────────────────

function analyzeDropOffs(features) {
  // Conversation ended without meaningful action: user sent >= 2 messages,
  // no lead captured, no booking step, not handed off, inactive > 1 day
  const dropOffs = features.filter(f =>
    f.userMessageCount >= 2 &&
    !f.leadCaptured &&
    !f.bookingStep &&
    !f.handoff &&
    f.daysSinceUpdate > 1 &&
    !["lead_captured", "closed"].includes(f.finalStage)
  );
  return {
    count:      dropOffs.length,
    rate:       features.length ? dropOffs.length / features.length : 0,
    hasBookingIntent: dropOffs.filter(f => f.hasBookingIntent).length,
    hasAvailability:  dropOffs.filter(f => f.hasAvailabilityIntent).length,
    hasPricing:       dropOffs.filter(f => f.hasPricingIntent).length,
  };
}

function analyzeMissedLeads(features, leads, total) {
  // Conversations where user showed high intent (booking or conditions) but no lead was captured
  const leadPhones = new Set(leads.map(l => l.from_number));
  const missedLeadConvos = features.filter(f =>
    (f.hasBookingIntent || f.finalStage === "high_intent" || f.finalStage === "considering") &&
    !f.leadCaptured &&
    !leadPhones.has(f.id) // rough proxy — can't join by phone without from_number on convo
  );

  const leadRate = total > 0 ? leads.length / total : 0;

  return {
    missedCount: missedLeadConvos.length,
    leadRate,
    totalLeads:  leads.length,
  };
}

function analyzeBookingGaps(features) {
  // Users asked about booking/availability but no booking step was initiated
  const bookingIntentConvos = features.filter(f => f.hasBookingIntent || f.hasAvailabilityIntent);
  const bookedConvos        = features.filter(f => f.bookingStep && f.bookingStep > 0);
  const gapped              = bookingIntentConvos.filter(f => !f.bookingStep || f.bookingStep === 0);

  return {
    bookingIntentConvos: bookingIntentConvos.length,
    bookedConvos:        bookedConvos.length,
    gapCount:            gapped.length,
    gapRate:             bookingIntentConvos.length > 0
                          ? gapped.length / bookingIntentConvos.length : 0,
  };
}

function analyzeFrustration(features) {
  const frustrated = features.filter(f => f.frustrated);
  const handoffs   = features.filter(f => f.handoff);
  return {
    frustratedCount: frustrated.length,
    frustratedRate:  features.length ? frustrated.length / features.length : 0,
    handoffCount:    handoffs.length,
    handoffRate:     features.length ? handoffs.length / features.length : 0,
  };
}

function analyzeEarlyDropOffs(features) {
  const earlyExits = features.filter(f =>
    f.userMessageCount === 1 &&
    !f.leadCaptured &&
    !f.bookingStep
  );
  return {
    count: earlyExits.length,
    rate:  features.length ? earlyExits.length / features.length : 0,
  };
}

function analyzeFirstMessageLength(features) {
  const lengths = features
    .map(f => f.firstBotMsg.length)
    .filter(l => l > 0);
  if (!lengths.length) return { avgLen: 0, longCount: 0, longRate: 0 };
  const avg      = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const longMsgs = lengths.filter(l => l > 480);
  return {
    avgLen:    Math.round(avg),
    longCount: longMsgs.length,
    longRate:  lengths.length ? longMsgs.length / lengths.length : 0,
  };
}

function analyzeConfigGaps(client) {
  const bookingLinks = client.bookingLinks ?? client.bookingUrls ?? {};
  const fhCompanies  = client.fareharborCompanies ?? [];
  return {
    noBookingLinks:   Object.keys(bookingLinks).length === 0 && fhCompanies.length === 0,
    noFareharbor:     fhCompanies.length === 0,
    noLeadCapture:    !client.leadCaptureEnabled,
    bookingMode:      client.bookingMode ?? "unknown",
  };
}

// ── Insight generation ────────────────────────────────────────────────────────

const pct = (rate) => `${Math.round(rate * 100)}%`;
const n   = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function generateOptimizationInsights(analysis, total) {
  const { dropOffs, missedLeads, bookingGaps, frustration, earlyDropOffs, firstMessage, configGaps } = analysis;
  const insights = [];

  // ── High-severity insights ─────────────────────────────────────────────────

  if (missedLeads.missedCount >= 3 && missedLeads.leadRate < 0.15) {
    insights.push({
      insight_type:   "missed_lead",
      severity:       "high",
      category:       "lead_capture",
      title:          "High-intent conversations aren't capturing leads",
      description:    `${n(missedLeads.missedCount, "conversation")} showed strong booking intent in the last 30 days, but no lead was captured. Your current lead capture rate is ${pct(missedLeads.leadRate)}.`,
      suggestion:     "Enable lead capture or lower the intent threshold so the bot asks for contact info earlier in high-intent conversations.",
      action_section: "bot-config",
      action_label:   "Edit Bot Config",
      metric_value:   Math.round(missedLeads.leadRate * 100),
      metric_label:   `${pct(missedLeads.leadRate)} lead capture rate across ${n(total, "conversation")}`,
    });
  }

  if (bookingGaps.gapRate > 0.5 && bookingGaps.bookingIntentConvos >= 5) {
    insights.push({
      insight_type:   "booking_gap",
      severity:       "high",
      category:       "booking",
      title:          "Users ask about booking but don't follow through",
      description:    `${pct(bookingGaps.gapRate)} of conversations with booking or availability intent did not result in a booking step (${n(bookingGaps.gapCount, "conversation")} out of ${bookingGaps.bookingIntentConvos}).`,
      suggestion:     "Make sure your booking links are configured and clearly offered when guests show interest. Consider connecting a live booking integration.",
      action_section: "booking-config",
      action_label:   "Edit Booking Config",
      metric_value:   Math.round(bookingGaps.gapRate * 100),
      metric_label:   `${pct(bookingGaps.gapRate)} of booking-intent conversations didn't proceed`,
    });
  }

  if (dropOffs.rate > 0.55 && dropOffs.count >= 5) {
    insights.push({
      insight_type:   "early_dropoff",
      severity:       "high",
      category:       "messaging",
      title:          "More than half your conversations end without any action",
      description:    `${pct(dropOffs.rate)} of conversations (${n(dropOffs.count, "conversation")}) ended with no lead, no booking, and no handoff in the last 30 days.`,
      suggestion:     "Review your bot's responses to common questions. Make sure every response ends with a clear next step — a soft CTA, a question, or a booking link.",
      action_section: "bot-config",
      action_label:   "Edit Bot Config",
      metric_value:   Math.round(dropOffs.rate * 100),
      metric_label:   `${pct(dropOffs.rate)} drop-off rate`,
    });
  }

  // ── Medium-severity insights ───────────────────────────────────────────────

  if (configGaps.noBookingLinks && total > 0) {
    insights.push({
      insight_type:   "no_booking_config",
      severity:       "medium",
      category:       "config",
      title:          "No booking links configured",
      description:    "Your bot has no booking links or FareHarbor integration. Guests asking to book will receive a generic response with no direct next step.",
      suggestion:     "Add your booking URL in Booking Config, or connect FareHarbor in Integrations for real-time availability.",
      action_section: "booking-config",
      action_label:   "Set Up Booking",
      metric_value:   null,
      metric_label:   null,
    });
  }

  if (frustration.frustratedRate > 0.2 && frustration.frustratedCount >= 3) {
    insights.push({
      insight_type:   "frustrated",
      severity:       "medium",
      category:       "messaging",
      title:          "High frustration rate in conversations",
      description:    `${pct(frustration.frustratedRate)} of conversations (${n(frustration.frustratedCount, "conversation")}) included signs of guest frustration. This often signals slow or unclear responses.`,
      suggestion:     "Review your bot's tone and speed. Make sure it gives direct answers quickly — especially for pricing and availability questions.",
      action_section: "bot-config",
      action_label:   "Tune Bot Tone",
      metric_value:   Math.round(frustration.frustratedRate * 100),
      metric_label:   `${pct(frustration.frustratedRate)} frustration rate`,
    });
  }

  if (dropOffs.hasAvailability >= 3 && configGaps.noFareharbor) {
    insights.push({
      insight_type:   "no_api_integration",
      severity:       "medium",
      category:       "integration",
      title:          "Availability questions aren't getting real answers",
      description:    `${n(dropOffs.hasAvailability, "conversation")} asked about availability and dropped off without booking. Without a live integration, the bot can't confirm real availability.`,
      suggestion:     "Connect FareHarbor or add a Custom API integration so the bot can answer availability questions with live data.",
      action_section: "integrations",
      action_label:   "Connect Integration",
      metric_value:   dropOffs.hasAvailability,
      metric_label:   `${n(dropOffs.hasAvailability, "conversation")} with unanswered availability questions`,
    });
  }

  if (frustration.handoffRate > 0.3 && frustration.handoffCount >= 5) {
    insights.push({
      insight_type:   "handoff_heavy",
      severity:       "medium",
      category:       "messaging",
      title:          "Too many conversations escalating to human handoff",
      description:    `${pct(frustration.handoffRate)} of conversations (${n(frustration.handoffCount, "conversation")}) required a human handoff. This suggests the bot is struggling with common questions.`,
      suggestion:     "Identify the questions that trigger handoffs and add them to your knowledge base or FAQ. Reduce reliance on human escalation for routine inquiries.",
      action_section: "knowledge",
      action_label:   "Update Knowledge Base",
      metric_value:   Math.round(frustration.handoffRate * 100),
      metric_label:   `${pct(frustration.handoffRate)} handoff rate`,
    });
  }

  // ── Low-severity insights ──────────────────────────────────────────────────

  if (earlyDropOffs.rate > 0.3 && earlyDropOffs.count >= 5) {
    insights.push({
      insight_type:   "one_message_dropoff",
      severity:       "low",
      category:       "messaging",
      title:          "Many users send one message and disappear",
      description:    `${n(earlyDropOffs.count, "conversation")} (${pct(earlyDropOffs.rate)}) consisted of only one user message with no follow-up. Your opening message may not be engaging enough.`,
      suggestion:     "Shorten and sharpen your opening message. Ask a specific question to keep the conversation going — e.g., 'What brings you here today?'",
      action_section: "bot-config",
      action_label:   "Edit Opening Message",
      metric_value:   Math.round(earlyDropOffs.rate * 100),
      metric_label:   `${pct(earlyDropOffs.rate)} of conversations end after one message`,
    });
  }

  if (firstMessage.longRate > 0.4 && firstMessage.longCount >= 3) {
    insights.push({
      insight_type:   "long_intro",
      severity:       "low",
      category:       "messaging",
      title:          "Your opening messages are too long",
      description:    `${pct(firstMessage.longRate)} of your opening bot responses (${n(firstMessage.longCount, "message")}) exceeded 480 characters. Long openers can overwhelm guests and cause drop-off.`,
      suggestion:     "Shorten your first response to 2–3 sentences maximum. Save the detail for follow-up messages once the guest is engaged.",
      action_section: "bot-config",
      action_label:   "Edit Bot Config",
      metric_value:   firstMessage.avgLen,
      metric_label:   `Average first response: ${firstMessage.avgLen} characters`,
    });
  }

  if (dropOffs.hasPricing >= 3) {
    insights.push({
      insight_type:   "pricing_no_action",
      severity:       "low",
      category:       "lead_capture",
      title:          "Pricing questions aren't converting",
      description:    `${n(dropOffs.hasPricing, "conversation")} where guests asked about pricing ended without any next step — no lead, no booking link, no follow-up.`,
      suggestion:     "After answering a pricing question, always follow up with a booking CTA or an offer to check availability. Strike while the interest is hot.",
      action_section: "booking-config",
      action_label:   "Configure Booking Links",
      metric_value:   dropOffs.hasPricing,
      metric_label:   `${n(dropOffs.hasPricing, "drop-off")} after pricing question`,
    });
  }

  // Sort: high → medium → low
  const order = { high: 0, medium: 1, low: 2 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);

  return insights;
}

// ── Performance scoring ───────────────────────────────────────────────────────

export function scoreClientPerformance(analysis, total) {
  let score = 100;

  const { dropOffs, missedLeads, bookingGaps, frustration, earlyDropOffs, configGaps } = analysis;

  // High deductions
  if (dropOffs.rate > 0.55)      score -= 25;
  else if (dropOffs.rate > 0.35) score -= 12;

  if (bookingGaps.gapRate > 0.5) score -= 20;
  else if (bookingGaps.gapRate > 0.3) score -= 10;

  if (missedLeads.leadRate < 0.05 && total >= 10) score -= 20;
  else if (missedLeads.leadRate < 0.15 && total >= 10) score -= 10;

  // Medium deductions
  if (frustration.frustratedRate > 0.2) score -= 10;
  if (frustration.handoffRate > 0.3)    score -= 8;
  if (earlyDropOffs.rate > 0.3)         score -= 8;
  if (configGaps.noBookingLinks)        score -= 10;

  // Low deductions
  if (analysis.firstMessage.longRate > 0.4) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ── Persist / retrieve ─────────────────────────────────────────────────────────

async function saveOptimizationResults(supabase, clientId, insights, score, metrics) {
  // Delete old insights for this client before inserting fresh ones
  await supabase.from("optimization_insights").delete().eq("client_id", clientId);

  if (insights.length > 0) {
    const rows = insights.map(i => ({ ...i, client_id: clientId }));
    await supabase.from("optimization_insights").insert(rows);
  }

  // Upsert score
  await supabase.from("optimization_scores").upsert({
    client_id:                clientId,
    score,
    conversations_analyzed:   metrics.total,
    leads_captured:           metrics.leads.length,
    lead_capture_rate:        metrics.total > 0 ? metrics.leads.length / metrics.total : null,
    dropoff_rate:             metrics.analysis?.dropOffs?.rate ?? null,
    booking_intent_rate:      metrics.analysis?.bookingGaps?.bookingIntentConvos > 0
                                ? metrics.analysis.bookingGaps.bookedConvos / metrics.analysis.bookingGaps.bookingIntentConvos
                                : null,
    frustrated_rate:          metrics.analysis?.frustration?.frustratedRate ?? null,
    analyzed_at:              new Date().toISOString(),
  }, { onConflict: "client_id" });
}

export async function getOptimizationInsights(supabase, clientId) {
  const [insightsRes, scoreRes] = await Promise.all([
    supabase.from("optimization_insights")
      .select("*")
      .eq("client_id", clientId)
      .eq("dismissed", false)
      .order("generated_at", { ascending: false })
      .limit(20),
    supabase.from("optimization_scores")
      .select("*")
      .eq("client_id", clientId)
      .single(),
  ]);

  return {
    insights:  insightsRes.data ?? [],
    score:     scoreRes.data   ?? null,
  };
}

export async function dismissInsight(supabase, id, clientId) {
  const { error } = await supabase.from("optimization_insights")
    .update({ dismissed: true })
    .eq("id", id)
    .eq("client_id", clientId);
  return { error: error?.message ?? null };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runOptimizationAnalysis(supabase, client) {
  if (!supabase || !client?.id) return { ok: false, error: "Missing supabase or client" };

  try {
    const metrics = await collectConversationMetrics(supabase, client.id);

    if (metrics.total < MIN_CONVERSATIONS) {
      // Not enough data — write an empty score so portal can show "not enough data"
      await supabase.from("optimization_scores").upsert({
        client_id: client.id, score: null,
        conversations_analyzed: metrics.total,
        leads_captured: metrics.leads.length,
        analyzed_at: new Date().toISOString(),
      }, { onConflict: "client_id" });
      return { ok: true, skipped: true, reason: "not_enough_data", total: metrics.total };
    }

    const features = metrics.convos.map(extractConvoFeatures);

    const analysis = {
      dropOffs:     analyzeDropOffs(features),
      missedLeads:  analyzeMissedLeads(features, metrics.leads, metrics.total),
      bookingGaps:  analyzeBookingGaps(features),
      frustration:  analyzeFrustration(features),
      earlyDropOffs:analyzeEarlyDropOffs(features),
      firstMessage: analyzeFirstMessageLength(features),
      configGaps:   analyzeConfigGaps(client),
    };

    const insights = generateOptimizationInsights(analysis, metrics.total);
    const score    = scoreClientPerformance(analysis, metrics.total);

    metrics.analysis = analysis;
    await saveOptimizationResults(supabase, client.id, insights, score, metrics);

    console.log(`[OPT] ${client.id}: score=${score}, ${insights.length} insights, ${metrics.total} convos analyzed`);
    return { ok: true, score, insightCount: insights.length, total: metrics.total };
  } catch (err) {
    console.error(`[OPT] Analysis failed for ${client.id}:`, err.message);
    return { ok: false, error: err.message };
  }
}
