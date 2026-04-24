// ─────────────────────────────────────────────────────────────────────────────
// SMS ORCHESTRATOR — Twilio /sms webhook handler
//
// Pure cut-and-paste extraction of the /sms handler body. index.js registers
// the route (with ipLimiter + phoneRateLimit middleware) and delegates here.
//
// Circular-import note: this file imports helpers and runtime instances from
// index.js. Node ESM resolves these lazily — safe because handleSmsRequest
// is only invoked at request time, long after both modules finish init.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveClient } from "./clients.js";
import {
  checkOptOut, handleOptOutKeyword, handleOptInKeyword,
  upsertContact, trackCampaignReply, deriveTagsFromMessage,
  OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS,
} from "./crm.js";
import { saveLead, notifyBusinessOfLead } from "./leads.js";
import { handleDemoFlowWithMeta } from "./demoFlow.js";
import { getRuntimeClientConfig } from "./clientConfig.js";
import { scheduleFollowUps, checkAndMarkLeadEngaged } from "./followUpEngine.js";
import { getKnowledgeContext } from "./knowledgeBase.js";
import {
  getConversationConfig, buildMainMenu, routeMenuSelection, buildConversationInstruction,
} from "./conversationEngine.js";
import { selectResponseMode, buildResponseModeInstruction } from "./responseMode.js";
import { resolveLiveTruth, buildTruthInstruction } from "./livetruth.js";
import {
  detectCancellationIntent, detectRescheduleIntent,
  handleCancellationMessage, handleRescheduleMessage,
} from "./messagingEngine.js";
import {
  getIdentityByPhone, loadCrossChannelContext, buildCrossChannelSummary,
} from "./crossChannel.js";
import { extractBookingContext, resolveBookingLink } from "./bookingLinks.js";
import { runOrchestrator } from "./agentOrchestrator.js";
import { detectOwner } from "./ownerMode.js";
import { getCustomApiContext } from "./apiIntegrations.js";
import { getAcceptedRewriteInstruction } from "./rewriteEngine.js";
import { extractDateFromMessage } from "./dateExtract.js";

import {
  supabase, crmSupabase, twilioClient, anthropic,
  isUiReq, enforceLength, getSeasonalOpener, getCurrentSeason,
  getConversation, saveConversation,
  detectIntent, detectSentiment, isReturningGuest, detectBuyingSignals,
  updateConversationStage, shouldAttemptLeadCapture, needsExpertiseFirst,
  buildLeadCapturePrompt, buildResponsePlan, formatResponsePlanInstruction,
  containsPhoneAsk, isDirectLinkRequest, ensureUrlInResponse,
  buildTourMenu, formatMenuInstruction, isAllUnavailable,
  checkAvailabilityIfNeeded, getClaudeReply,
} from "./index.js";

export async function handleSmsRequest(req, res) {
  const rawBody    = req.body.Body?.trim() ?? "";
  const fromNumber = req.body.From;
  const toNumber   = req.body.To;

  // Resolve which client this inbound number belongs to
  let client = resolveClient(toNumber);

  // 1. Parse + validate
  if (!rawBody || !fromNumber) {
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 2. Normalize for keyword checks
  const msgUpper = rawBody.toUpperCase().trim();

  // 3. OPT-OUT check — MUST be first (TCPA legal requirement)
  //    Uses DB1 (supabase) — works for all clients regardless of CRM config
  if (OPT_OUT_KEYWORDS.includes(msgUpper)) {
    await handleOptOutKeyword(fromNumber, toNumber, twilioClient, supabase, crmSupabase, client?.name);
    if (isUiReq(req)) return res.json({ reply: `You've been unsubscribed${client?.name ? ` from ${client.name}` : ""}. Reply START to resubscribe.` });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4. OPT-IN check
  if (OPT_IN_KEYWORDS.includes(msgUpper)) {
    await handleOptInKeyword(fromNumber, toNumber, twilioClient, supabase, crmSupabase, client?.name);
    if (isUiReq(req)) return res.json({ reply: `You're resubscribed${client?.name ? ` to ${client.name} messages` : ""}. Text us anytime.` });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4.5. HELP keyword — required by TCPA/CTIA. Works even if opted out.
  if (msgUpper === "HELP") {
    const helpText = `${client.name} SMS: info & booking assistance. Msg freq varies. Msg & data rates may apply. Reply STOP to unsubscribe. Support: ${client.supportPhone}`;
    if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply: helpText });
    await twilioClient.messages.create({ body: helpText, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[HELP] Twilio send error:", err.message));
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4.6. RESETNOW — universal reset keyword (owner / demo use).
  //      Clears the conversation and sends the appropriate opener for this client.
  //      For demo clients: fall through to handleDemoFlow (isNew=true) so they get
  //      the full demo opener with the numbered menu — same as the test console.
  if (msgUpper === "RESETNOW") {
    await supabase.from("conversations").delete()
      .eq("from_number", fromNumber).eq("to_number", toNumber);
    console.log(`[RESET] RESETNOW from ${fromNumber} on ${toNumber} — conversation cleared`);

    if (client.isDemo) {
      // Fall through to demo flow — handleDemoFlow with isNew=true sends the proper demo opener
    } else {
      const opener = enforceLength(client.openerText ?? getSeasonalOpener(client));
      if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply: opener });
      await twilioClient.messages.create({ body: opener, from: toNumber, to: fromNumber })
        .catch((err) => console.error("[RESET] Twilio send error:", err.message));
      res.set("Content-Type", "text/xml");
      return res.send("<Response></Response>");
    }
  }

  // 5. Kick off three independent Supabase reads in parallel — shaves ~300ms
  //    off the critical path. Opt-out is awaited first (cheapest check, highest
  //    short-circuit value); runtime config and conversation load are awaited
  //    downstream as needed.
  const optOutP     = checkOptOut(fromNumber, supabase);
  const runtimeCfgP = getRuntimeClientConfig(client, supabase);
  const convoP      = getConversation(fromNumber, toNumber);

  // 5a. Opted-out gate — drop silently if this number has opted out (DB1, all clients)
  const isOptedOut = await optOutP;
  if (isOptedOut) {
    console.log(`[OPT-OUT] Dropping message from opted-out number ${fromNumber}`);
    // Swallow errors on the orphaned in-flight reads (we're dropping the reply)
    runtimeCfgP.catch(() => {});
    convoP.catch(() => {});
    if (isUiReq(req)) return res.json({ reply: "[opted out — message dropped]" });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 5.5. Mark lead ENGAGED if this is a reply from a lead we've been following up with.
  //      Fire-and-forget — never delays the SMS response.
  checkAndMarkLeadEngaged(supabase, fromNumber);

  // 5.6. Await enriched client config (merges DB-backed settings: feature toggles,
  //      booking links, scrape sources). Falls back safely if DB unavailable.
  client = await runtimeCfgP;

  // 5.7. Detect owner phone — must run after getRuntimeClientConfig so ownerPhone is populated.
  //      Owner messages skip guest-routing branches (opener, returning, booking steps) and go
  //      directly to the orchestrator's internal operator mode.
  const isOwner = detectOwner(fromNumber, client);
  if (isOwner) console.log(`[OWNER] Inbound from owner phone ${fromNumber} — activating internal mode`);

  // 6. Demo mode — deterministic guided sales demo, no AI/API calls
  //    Triggered when bookingMode==="demo" OR isDemo flag (protects against DB overriding bookingMode).
  if (client.bookingMode === "demo" || client.isDemo) {
    const { isNew, convo } = await convoP;
    if (isNew && isUiReq(req)) convo.sessionType = "test";
    const { reply, meta } = await handleDemoFlowWithMeta({
      supabase, twilioClient, fromNumber, toNumber, rawBody,
      testMode: process.env.TEST_MODE === "true", isNew, convo, client,
      source: isUiReq(req) ? "ui" : "sms",
    });
    await saveConversation(fromNumber, toNumber, convo, client?.id);
    if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply, meta });
    await twilioClient.messages.create({ body: reply, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[DEMO] Twilio send error:", err.message));
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 7. DEMO triggers — reset conversation and send appropriate opener
  //    DEMO: public keyword (on website), introduces Highmark by name for prospects
  //    SUMMITDEMO: internal keyword for owner use, sends straight into Summit persona
  if (msgUpper === "DEMO" || msgUpper === "SUMMITDEMO") {
    await supabase.from("conversations").delete().eq("from_number", fromNumber);

    let opener;
    if (msgUpper === "DEMO") {
      const season = getCurrentSeason();
      if (season === "winter") {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about snowmobiling, conditions, or booking in Steamboat. Go ahead!";
      } else if (season === "summer") {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about RZR adventures, trails, or booking in Steamboat. Go ahead!";
      } else {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about adventures, conditions, or booking in Steamboat. Go ahead!";
      }
      opener = enforceLength(opener, 320);
    } else {
      opener = enforceLength(getSeasonalOpener(client));
    }

    console.log(`[DEMO] ${msgUpper} — reset + opener sent to ${fromNumber}`);

    if (process.env.TEST_MODE === "true") return res.json({ reply: opener });

    await twilioClient.messages.create({ body: opener, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[DEMO] Twilio send error:", err.message));

    // Notify owner when a prospect triggers DEMO (not SUMMITDEMO)
    if (msgUpper === "DEMO" && process.env.CONFIRMATIONS_TEST_PHONE) {
      await twilioClient.messages.create({
        body: `Highmark lead 🏔 ${fromNumber} just texted DEMO. Follow up when ready!`,
        from: toNumber,
        to:   process.env.CONFIRMATIONS_TEST_PHONE,
      }).catch((err) => console.error("[DEMO] Owner notify failed:", err.message));

      // Tag in CRM as demo lead (only for CRM-enabled clients)
      if (client.crmEnabled && crmSupabase) {
        await upsertContact(fromNumber, { source: "demo", tags: ["demo_lead"] }, crmSupabase)
          .catch(() => {});
      }
    }

    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 6. Load conversation from Supabase (reads kicked off in parallel at step 5)
  const { isNew, convo } = await convoP;
  // Mark UI console sessions as test so they're filterable in the DB
  if (isNew && isUiReq(req)) convo.sessionType = "test";

  // 6.5. Bot-paused gate — agent has taken over this conversation.
  //      Save the inbound message (so agent sees it) but send no reply.
  if (convo.botPaused === true && !isOwner) {
    convo.messages.push({
      role:      "user",
      content:   rawBody,
      timestamp: new Date().toISOString(),
      intent:    "guest_paused",
    });
    if (convo.messages.length > 10) convo.messages = convo.messages.slice(-10);
    await saveConversation(fromNumber, toNumber, convo, client?.id);
    console.log(`[BOT_PAUSED] Message from ${fromNumber} saved, no reply sent`);
    if (isUiReq(req)) return res.json({ reply: "[bot paused — message saved for agent]" });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // Phase 11.8: SMS→Web — for new or short conversations, check if this phone
  // has a linked web session and inject that context into the system prompt.
  // Graceful: failure never delays the SMS response.
  let xchContext = null;
  if (!isOwner && (isNew || convo.messages.length < 4)) {
    const identity = await getIdentityByPhone(supabase, client.id, fromNumber).catch(() => null);
    if (identity?.session_ids?.length) {
      const webMessages = await loadCrossChannelContext(supabase, client.id, identity.session_ids).catch(() => null);
      if (webMessages?.length) {
        xchContext = buildCrossChannelSummary(webMessages, 6);
        console.log(`[CROSS_CHANNEL] SMS→Web context loaded for ${fromNumber} (${webMessages.length} web msgs)`);
      }
    }
  }

  // 7-9. Classify
  const season       = getCurrentSeason();
  const intent       = detectIntent(rawBody);
  const sentiment    = detectSentiment(rawBody);
  const returning    = !isNew && isReturningGuest(convo);
  const buyingSignals    = detectBuyingSignals(rawBody, convo);
  const convConfig       = getConversationConfig(client);

  // 9.5. Menu selection routing — only when guided flow is enabled and not mid-flow.
  //      Maps "1" / "booking" / "pricing" → intent key, which the routing block below handles.
  //      Guards: skip if in active booking/lead step, or if flagged for name capture.
  const menuKey = (
    convConfig.enable_guided_flow &&
    !convo.bookingStep &&
    !convo.leadStep &&
    !convo.waitlistPending &&
    !convo.leadCapturePendingName
  ) ? routeMenuSelection(rawBody, client) : null;

  // Override intent if the message is a menu selection — existing routing handles it
  let effectiveIntent = intent;
  if (menuKey) {
    effectiveIntent = menuKey === "recommendations" ? "recommendation" : menuKey;
    console.log(`[MENU] "${rawBody.trim()}" → menu key: ${menuKey} (intent override: ${effectiveIntent})`);
  }

  // 10. Update consecutive frustrated counter
  if (sentiment === "frustrated") {
    convo.consecutiveFrustrated = (convo.consecutiveFrustrated ?? 0) + 1;
  } else {
    convo.consecutiveFrustrated = 0;
  }

  // Push user message to history
  convo.messages.push({
    role:      "user",
    content:   rawBody,
    timestamp: new Date().toISOString(),
    intent,
    sentiment,
  });

  // Keep last 10 messages to stay within token limits
  if (convo.messages.length > 10) convo.messages = convo.messages.slice(-10);

  // Update conversation stage based on this turn's signals
  updateConversationStage(convo, buyingSignals, intent, sentiment);

  let replyText;
  let orchestratorDebug = null; // Phase 7: populated when AGENT_ORCHESTRATOR_ENABLED=true

  try {
    // NAME CAPTURE pre-flight — guest said YES on a prior turn; we asked for their name.
    // This must run before the waitlist pre-flight so it doesn't fall through to normal routing.
    if (convo.leadCapturePendingName === true) {
      const isSkip = /^(skip|no|nope|nah|n\/a|none|pass)\b/i.test(rawBody.trim());
      const name   = isSkip ? null : rawBody.trim().slice(0, 60) || null;
      const service = convo.waitlistContext?.service ?? "general inquiry";
      const date    = convo.waitlistContext?.date    ?? null;

      const waitlistLead = await saveLead(supabase, {
        clientId:     client.id,
        fromNumber,
        contactPhone: fromNumber, // always use the SMS number
        contactEmail: null,
        name,
        service,
        timeframe:    date,
        leadType:     "waitlist",
        source:       isUiReq(req) ? "ui" : "sms",
      });
      if (waitlistLead) {
        scheduleFollowUps(supabase, waitlistLead, client.outboundPhone || toNumber); // fire-and-forget
      }
      notifyBusinessOfLead(
        twilioClient, client, fromNumber, toNumber,
        { name, service, callback: fromNumber, timeframe: date },
        process.env.TEST_MODE === "true",
        "waitlist"
      ).catch((err) => console.error("[NAME CAPTURE] notify error:", err.message));
      console.log(`[NAME CAPTURE] Lead saved — ${fromNumber}${name ? ` / ${name}` : ""}`);

      convo.leadCapturePendingName = false;
      convo.waitlistContext        = null;
      convo.stage                  = "lead_captured";
      replyText = enforceLength(
        name
          ? `Perfect, ${name} — we'll text you here when it's time! Questions anytime: ${client.handoffPhone} 🤙`
          : `You're on the list! We'll text you here when it's time. Questions anytime: ${client.handoffPhone} 🤙`
      );
    }

    // WAITLIST pre-flight — runs before main routing.
    // YES/NO: handled here. Any other message: clears pending and falls through to normal routing.
    else if (convo.waitlistPending === true && client.waitlistEnabled !== false) {
      const isYes = /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim());
      const isNo  = /^(no|nope|nah|not now|skip|n)\b/i.test(rawBody.trim());
      if (isYes) {
        // We already have their phone (it's the SMS number). Ask for a name, then save on next turn.
        convo.leadCapturePendingName = true;
        replyText = enforceLength(`Got it! What name should I put on it?`);
      } else if (isNo) {
        replyText = enforceLength(`No problem! Reach us anytime at ${client.handoffPhone} 🤙`);
      }
      // Clear waitlistPending — but keep waitlistContext if we still need it for the name step
      convo.waitlistPending = false;
      if (!convo.leadCapturePendingName) convo.waitlistContext = null;
    }

    // Main routing — only runs if not already handled by waitlist pre-flight above
    if (!replyText) {

    // 11. Sentiment escalation → auto-handoff after 2 consecutive frustrated messages
    //     Skipped when humanHandoffEnabled is false (bot stays in conversation)
    if (convo.consecutiveFrustrated >= 2 && !convo.handoff && client.humanHandoffEnabled !== false) {
      convo.handoff = true;
      console.log(`[HANDOFF] Auto-escalation (frustrated x${convo.consecutiveFrustrated}) — ${fromNumber}`);
      if (client.waitlistEnabled !== false) {
        convo.waitlistPending = true;
        convo.waitlistContext = { service: "general inquiry", date: null };
        replyText = enforceLength(
          `I want to make sure you get the best help. Want me to save your number so the team can call you back? Reply YES to confirm, or call now: ${client.handoffPhone} 🤙`
        );
      } else {
        replyText = enforceLength(
          `I want to make sure you get the best help — give us a call at ${client.handoffPhone} and we'll sort you out 🤙`
        );
      }
    }

    // 12. Explicit handoff intent — try lead capture first, phone as escape hatch
    //     Skipped when humanHandoffEnabled is false (falls through to Claude default)
    else if (effectiveIntent === "handoff" && client.humanHandoffEnabled !== false) {
      convo.handoff = true;
      console.log(`[HANDOFF] Explicit request — ${fromNumber}`);
      if (client.waitlistEnabled !== false) {
        convo.waitlistPending = true;
        convo.waitlistContext = { service: "general inquiry", date: null };
        replyText = enforceLength(
          `Of course! Want me to save your number so the team can reach out to you directly? Reply YES to confirm, or call us now: ${client.handoffPhone} 🤙`
        );
      } else {
        replyText = enforceLength(client.handoffReply(client.handoffPhone));
      }
    }

    // CONFIRMED GUEST: Cancellation / Reschedule intent
    // Intercepts lifecycle messages from guests who have a confirmed booking.
    // Returns a deterministic reply — no Claude call needed.
    else if (
      convo.sessionType === "confirmed_guest" &&
      convo.bookingData?.activity &&
      !isNew &&
      (detectCancellationIntent(rawBody) || detectRescheduleIntent(rawBody))
    ) {
      if (detectCancellationIntent(rawBody)) {
        console.log(`[MSG] Cancellation intent from confirmed guest — ${fromNumber}`);
        replyText = enforceLength(handleCancellationMessage(convo, client));
      } else {
        console.log(`[MSG] Reschedule intent from confirmed guest — ${fromNumber}`);
        replyText = enforceLength(handleRescheduleMessage(convo, client));
      }
    }

    // FIRST MESSAGE — skip for owner phones; they go to orchestrator directly
    else if (isNew && !isOwner) {
      // Check if confirmed guest (pre-seeded by booking confirmation)
      if (convo.sessionType === "confirmed_guest" && convo.bookingData?.activity) {
        replyText = enforceLength(
          `Hey! You're all set for ${convo.bookingData.activity} on ${convo.bookingData.date}. Any questions before your adventure? 🏔`
        );
      } else {
        let opener = getSeasonalOpener(client);
        // If guided flow + show_main_menu_on_start: append numbered menu to opener
        if (convConfig.enable_guided_flow && convConfig.show_main_menu_on_start) {
          const menu = buildMainMenu(client);
          if (menu) opener = `${opener}\n\n${menu}`;
        }
        replyText = enforceLength(opener);
      }
    }

    // RETURNING AFTER 24H — light re-intro (skip for owners)
    else if (returning && convo.bookingStep === null && !convo.handoff && !isOwner) {
      replyText = enforceLength(`Hey, ${client.botName} again — welcome back! What can I help with?`);
    }

    // WAITLIST TRIGGER — "notify me" / "let me know" proactive opt-in (any client, not owner)
    else if (
      !isOwner &&
      /let me know|notify me|heads.?up when|alert me when|when.+open.*book|when.+available/i.test(rawBody) &&
      !convo.waitlistPending &&
      client.waitlistEnabled !== false
    ) {
      convo.waitlistPending = true;
      convo.waitlistContext = { service: "availability updates", date: null };
      replyText = enforceLength(
        `Happy to! We'll text you at this number when spots open. Just reply YES to confirm, or call us anytime: ${client.handoffPhone}`
      );
    }

    // ORGANIC OUTREACH YES — guest says YES after Claude organically asked about reaching out.
    // Catches the gap where Claude improvises "want me to reach out?" and the guest confirms,
    // but waitlistPending was never set (no structured trigger fired).
    // Condition: guest sent a clear YES + not mid-booking + last bot message had reach-out language.
    else if (
      !isOwner &&
      /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim()) &&
      convo.bookingStep === null &&
      client.waitlistEnabled !== false &&
      /reach out|let you know|heads.?up|notify|first to know|snag a spot|save your number|add you to|call you back|get back to you|have someone|reach you|follow up|touch base|get in touch|connect with|talk through|in contact|pass your|pass along/i.test(
        convo.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? ""
      )
    ) {
      // Phone is already known (SMS). Ask for name, then save lead on next turn.
      convo.leadCapturePendingName = true;
      convo.waitlistContext        = convo.waitlistContext ?? { service: "availability interest", date: null };
      console.log(`[ORGANIC YES] Confirmed reach-out intent — ${fromNumber}, asking for name`);
      replyText = enforceLength(`Got it! What name should I put on it?`);
    }

    // PROACTIVE LEAD CAPTURE — fires when buying signals are strong and timing is right.
    // Sets waitlistPending so the pre-flight above handles the YES/NO on the next turn.
    // Does NOT fire for: booking intents, handoff, conditions, expertise-first, or owner.
    else if (
      !isOwner &&
      shouldAttemptLeadCapture(convo, buyingSignals, client) &&
      !needsExpertiseFirst(intent, buyingSignals, convo) &&
      intent !== "booking" && intent !== "handoff" && intent !== "conditions"
    ) {
      convo.waitlistPending      = true;
      convo.leadCaptureAttempted = true;
      convo.waitlistContext      = {
        service: buyingSignals.inferredGoal ?? "general inquiry",
        date:    null,
      };
      replyText = enforceLength(buildLeadCapturePrompt(client, buyingSignals.inferredGoal));
      console.log(`[LEAD] Proactive capture triggered — stage: ${convo.stage}, signal: ${buyingSignals.strength}, goal: ${buyingSignals.inferredGoal} — ${fromNumber}`);
    }

    // BOOKING INTENT — call_only: route directly to phone CTA (no booking links)
    else if (effectiveIntent === "booking" && client.bookingMode === "call_only") {
      const knowledgeCtx = await getKnowledgeContext(supabase, client);
      replyText = await getClaudeReply(
        convo, client, season, knowledgeCtx,
        `Guest wants to book. ${client.name} books by phone only — no online booking. Direct them to call ${client.handoffPhone}${client.supportEmail ? ` or email ${client.supportEmail}` : ""}. Keep it warm and brief.`
      );
    }

    // BOOKING INTENT — static_links or hybrid: show numbered booking link list
    else if (effectiveIntent === "booking" && (client.bookingMode === "static_links" || client.bookingMode === "hybrid")) {
      const links = (client.bookingLinks ?? []).filter((l) => l.url);
      if (links.length === 0) {
        // No links configured — fall back to phone CTA
        const knowledgeCtx = await getKnowledgeContext(supabase, client);
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest wants to book. No booking links are configured yet. Direct them to call ${client.handoffPhone}. Keep it warm and brief.`
        );
      } else {
        const numbered = links
          .map((l, i) => `${i + 1}. ${l.title}${l.description ? ` — ${l.description}` : ""}: ${l.url}`)
          .join("\n");
        const hybridCta = client.bookingMode === "hybrid" ? `\n\nOr call us: ${client.handoffPhone}` : "";
        replyText = enforceLength(`Here are your booking options:\n${numbered}${hybridCta}`, 640);
      }
    }

    // BOOKING FLOW — state machine (fareharbor clients only)
    // Step null → 1: Show tour menu, ask guest to pick.
    //   Fast path: if guest explicitly asks for "the booking link", skip the menu
    //   and send the most relevant link directly.
    else if (intent === "booking" && convo.bookingStep === null && client.bookingMode === "fareharbor") {

      // DIRECT LINK REQUEST: skip tour menu, resolve and send the best matching link immediately.
      // Uses resolveBookingLink (config → API → crawl → fallback) — no model-generated URLs.
      if (isDirectLinkRequest(rawBody)) {
        const bCtx = extractBookingContext(rawBody);
        const resolved = await resolveBookingLink({
          message: rawBody,
          entity:   bCtx.entity,
          company:  bCtx.company,
          location: bCtx.location,
          season,
          client,
          supabase,
          trackingBaseUrl: process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : (process.env.APP_URL ?? ""),
          channel:         "sms",
        });
        if (resolved?.url) {
          const knowledgeCtx = await getKnowledgeContext(supabase, client);
          convo.bookingStep          = 2;
          convo.bookingData.activity = resolved.url;
          replyText = await getClaudeReply(
            convo, client, season, knowledgeCtx,
            `Guest asked for a booking link directly. Send them this link: ${resolved.url}. Include the full URL. Keep it brief and warm.`
          );
          replyText = ensureUrlInResponse(replyText, resolved.url);

          // Sprint 5: log partner_link_sent when Source 5 wins
          if (resolved.source === "partner") {
            supabase.from("web_events").insert({
              client_id:  client.id,
              session_id: null,
              channel:    "sms",
              page_url:   resolved.url,
              event_type: "partner_link_sent",
              metadata:   {
                partner_id:    resolved.partner?.id ?? null,
                partner_name:  resolved.partner?.partner_name ?? null,
                activity_name: resolved.partner?.activity_name ?? null,
                confidence:    resolved.confidence,
              },
            }).then().catch(() => {});
          }
        }
      }

      // Normal menu flow — runs when not a direct link request, or no portal links resolved above
      if (!replyText) {
        convo.bookingStep = 1;

        // Extract date from message if present (for availability check).
        // Deterministic pure-JS parser — no LLM call, zero latency/tokens.
        const extractedDate = extractDateFromMessage(rawBody);

        const menuOptions  = await buildTourMenu(client, season, extractedDate);
        const knowledgeCtx = await getKnowledgeContext(supabase, client);

        if (menuOptions.length === 0) {
          // No items available for online booking — don't enter step 1
          convo.bookingStep = null;
          let noItemsInstruction = `Guest wants to book but there are currently no tours or rentals available for online booking. Respond warmly and honestly — snowmobile operations are paused due to warm temps and low snow base. Mention summer RZR adventures are coming soon. Do NOT suggest any booking links or dates. Offer to have the team follow up: ${client.handoffPhone}.`;
          if (client.waitlistEnabled !== false) {
            convo.waitlistPending = true;
            convo.waitlistContext = { service: "tours/rentals", date: null };
            noItemsInstruction += ` Also ask: "Want a heads-up when we reopen for bookings? Reply YES and we'll save your number."`;
          }
          replyText = await getClaudeReply(convo, client, season, knowledgeCtx, noItemsInstruction);
        } else {
          convo.bookingStep = 1;
          convo.bookingData.menuOptions = menuOptions;
          let menuInstruction = formatMenuInstruction(client, menuOptions, extractedDate);
          if (isAllUnavailable(menuOptions, extractedDate) && client.waitlistEnabled !== false) {
            convo.waitlistPending = true;
            convo.waitlistContext = {
              service: extractedDate ? `tour on ${extractedDate}` : "tour/rental",
              date:    extractedDate,
            };
            menuInstruction += ` Also invite them to join the waitlist: "Want a heads-up when spots open? Reply YES and we'll save your number."`;
          }
          replyText = await getClaudeReply(convo, client, season, knowledgeCtx, menuInstruction);
        }
      }
    }

    // Step 1 → 2: Guest picked a tour — route to its booking link (fareharbor only).
    // Previous behavior: groups ≥ 6 auto-handed off without sending a link.
    // New behavior: always send the booking link; note group logistics if size ≥ 6.
    // Handoff only fires if no booking URL is available.
    else if (convo.bookingStep === 1 && client.bookingMode === "fareharbor") {
      // Detect group size — only treat single-digit 1-5 as option picks; 6+ as group count
      const groupMatch = rawBody.match(/\b([6-9]|[1-9]\d+)\b/);
      const groupSize  = groupMatch ? parseInt(groupMatch[1]) : null;

      convo.bookingData.groupSize = groupSize;

      // Match the guest's reply to a menu option by number or keyword
      const options = convo.bookingData.menuOptions ?? [];
      let chosen    = null;

      // Only use 1-5 as option selectors to avoid confusing group count with option number
      const numMatch = rawBody.match(/\b([1-5])\b/);
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        if (idx >= 0 && idx < options.length) chosen = options[idx];
      }

      if (!chosen) {
        const t = rawBody.toLowerCase();
        chosen = options.find((o) => {
          const label = o.label.toLowerCase();
          return label.split(" ").some((word) => word.length > 4 && t.includes(word));
        }) ?? options[0];
      }

      convo.bookingData.activity = chosen?.label ?? "tour";
      convo.bookingData.company  = chosen?.company ?? "csr";
      convo.bookingStep = 2;

      const knowledgeCtx = await getKnowledgeContext(supabase, client);

      if (!chosen?.url) {
        // No booking URL — handoff is the right call
        convo.handoff = true;
        replyText = enforceLength(
          `Give us a call at ${client.handoffPhone} and we'll sort out all the details for you 🤙`
        );
      } else if (groupSize !== null && groupSize >= 6) {
        // Large group: send booking link + note about group logistics
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest has a group of ${groupSize}. Send them this booking link: ${chosen.url}. Include the full URL. Mention they can start the booking online and suggest calling ${client.handoffPhone} to discuss group pricing or special arrangements. Keep it warm.`
        );
        replyText = ensureUrlInResponse(replyText, chosen.url);
      } else {
        // Normal: send booking link
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest chose: "${chosen.label}". Send them this booking link: ${chosen.url}. Include the full URL. Keep it warm and brief.`
        );
        replyText = ensureUrlInResponse(replyText, chosen.url);
      }
    }

    // LEAD CAPTURE FLOW — informational clients with lead capture enabled
    // ── Step null → 1: booking intent starts the flow ──────────────────────
    else if (effectiveIntent === "booking" && client.bookingMode === "informational" && client.leadCaptureEnabled && convo.leadStep === null) {
      convo.leadStep = 1;
      convo.leadData = { service: null, callback: null, timeframe: null };
      replyText = enforceLength(
        `Happy to pass your request to the team! What service do you need? (e.g. revalve, rebuild, coatings) Or call us directly at ${client.handoffPhone} 🔧`
      );
    }

    // ── Step 1 → 2: capture service, ask for callback ───────────────────────
    else if (convo.leadStep === 1 && client.bookingMode === "informational") {
      if (/call|phone|never mind|cancel|skip/i.test(rawBody)) {
        convo.leadStep = null; convo.leadData = null;
        replyText = enforceLength(client.handoffReply(client.handoffPhone));
      } else {
        convo.leadData = { ...(convo.leadData ?? {}), service: rawBody.slice(0, 200) };
        convo.leadStep = 2;
        replyText = enforceLength(
          `Got it — ${rawBody.slice(0, 60)}. Best number to reach you? (or reply 'same' to use this number)`
        );
      }
    }

    // ── Step 2 → 3: capture callback, ask for timeframe ─────────────────────
    else if (convo.leadStep === 2 && client.bookingMode === "informational") {
      const isSame = /\bsame\b|this number|this one|mine/i.test(rawBody);
      convo.leadData = { ...(convo.leadData ?? {}), callback: isSame ? fromNumber : rawBody.slice(0, 30) };
      convo.leadStep = 3;
      replyText = enforceLength(`Perfect. Any idea on timeframe? (e.g. next week, ASAP, no rush)`);
    }

    // ── Step 3: capture timeframe, save lead, confirm ────────────────────────
    else if (convo.leadStep === 3 && client.bookingMode === "informational") {
      convo.leadData = { ...(convo.leadData ?? {}), timeframe: rawBody.slice(0, 100) };
      const contactPhone = /^\+?\d/.test(convo.leadData.callback ?? "")
        ? convo.leadData.callback
        : fromNumber;

      const savedLead = await saveLead(supabase, {
        clientId:  client.id,
        fromNumber,
        contactPhone,
        service:   convo.leadData.service,
        timeframe: convo.leadData.timeframe,
        source:    isUiReq(req) ? "ui" : "sms",
      });

      if (savedLead) {
        scheduleFollowUps(supabase, savedLead, client.outboundPhone || toNumber); // fire-and-forget
      }

      notifyBusinessOfLead(
        twilioClient, client, fromNumber, toNumber,
        convo.leadData, process.env.TEST_MODE === "true"
      ).catch((err) => console.error("[LEADS] notify error:", err.message));

      convo.leadStep = null; // back to normal Q&A after completion
      convo.leadData = null;

      replyText = enforceLength(
        `You're all set! I've passed your request along to the team — expect a call soon 🔧 Or reach out directly: ${client.handoffPhone}`
      );
    }

    // BOOKING INTENT — informational clients without lead capture: phone CTA via Claude
    else if (effectiveIntent === "booking" && client.bookingMode === "informational") {
      const knowledgeCtx = await getKnowledgeContext(supabase, client);
      replyText = await getClaudeReply(
        convo, client, season, knowledgeCtx,
        `Guest wants to schedule or book. ${client.name} does not use online booking — all scheduling is done by phone${client.supportEmail ? ` or email` : ""}. Direct them to call ${client.handoffPhone}${client.supportEmail ? ` or email ${client.supportEmail}` : ""}. Keep it warm and brief.`
      );
    }

    // DEFAULT: Claude handles everything else (all clients including informational)
    else {
      const availCtx     = await checkAvailabilityIfNeeded(rawBody, convo, client);
      const knowledgeCtx = await getKnowledgeContext(supabase, client);

      // Phase 6: custom API integrations — inject inject_always endpoint data
      const customApiCtx    = await getCustomApiContext(supabase, client.id, rawBody).catch(() => "");
      const rewriteCtx      = await getAcceptedRewriteInstruction(supabase, client.id).catch(() => "");
      const fullKnowledgeCtx = [knowledgeCtx, customApiCtx, rewriteCtx].filter(Boolean).join("\n\n") || knowledgeCtx;

      // Live truth — resolve before Claude to prevent pitching unavailable offerings.
      // Phase 3: delegates to adapter registry (FareHarbor, Static, Hours, etc.)
      // Returns null for non-availability messages or non-integrated clients.
      const liveTruth        = await resolveLiveTruth(rawBody, client, supabase);
      const truthInstruction = buildTruthInstruction(liveTruth);

      // Phase 3: response mode — deterministic strategy selection before generation
      const responseMode     = selectResponseMode({ intent, sentiment, truth: liveTruth, buyingSignals, convo, client });
      const modeInstruction  = buildResponseModeInstruction(responseMode, client, liveTruth);
      console.log(`[MODE] ${responseMode} — ${fromNumber}`);

      // Build deterministic response plan — tells Claude what to do and what is forbidden
      const responsePlan    = buildResponsePlan(intent, sentiment, buyingSignals, convo, client);
      const planInstruction = formatResponsePlanInstruction(responsePlan, client);

      // Combine availability context with plan, conversation guidance, and response mode
      const convInstruction = buildConversationInstruction(effectiveIntent, client);
      // Owner mode: skip all guest-facing response plan instructions — they conflict with operator behavior.
      // Owner gets a clean context so the agent prompts and action results are not polluted by
      // booking nudges, lead capture directives, or sentiment escalation logic.
      let extraInstruction = isOwner ? null : ([
        xchContext        ? `CROSS-CHANNEL CONTEXT: This guest previously chatted via the website. Recent web conversation:\n${xchContext}\nContinue naturally — do not mention channel switching unless they bring it up.` : null,
        availCtx          ? `Live availability data: ${availCtx}` : null,
        planInstruction   || null,
        convInstruction   || null,
        truthInstruction  || null,
        modeInstruction   || null,
      ].filter(Boolean).join("\n\n") || null);

      // 480 chars (3 texts) — never cut off mid-thought
      const replyMax = 480;

      // Phase 5: Agent Orchestrator — routes through multi-agent system when enabled.
      // Falls back to existing getClaudeReply() path when disabled (default).
      // Enable via: AGENT_ORCHESTRATOR_ENABLED=true in Railway env vars.
      if (process.env.AGENT_ORCHESTRATOR_ENABLED === "true") {
        const orchResult = await runOrchestrator({
          message:          rawBody,
          convo,
          client,
          anthropic,
          fromNumber,
          supabase,
          crmSupabase,
          twilioClient,
          knowledgeContext: fullKnowledgeCtx,
          extraInstruction,
        });
        replyText = orchResult.reply;
        orchestratorDebug = {
          agent:     orchResult.agent,
          action:    orchResult.parsed?.action ?? null,
          context:   orchResult.context,
          ownerMode: orchResult.ownerMode,
        };
      } else {
        replyText = await getClaudeReply(convo, client, season, fullKnowledgeCtx, extraInstruction, replyMax);
      }

      // Post-generation validator: catch phone ask and regenerate once with stricter instruction
      if (containsPhoneAsk(replyText) && responsePlan.forbiddenMoves.includes("ask_for_phone_when_sms")) {
        console.warn(`[VALIDATOR] Phone ask detected — regenerating for ${fromNumber}`);
        const correction = [
          availCtx ? `Live availability data: ${availCtx}` : null,
          planInstruction || null,
          "CORRECTION: Your previous draft asked for a phone number. The customer is already texting you — remove any phone-ask and replace with a soft offer like \"Want me to have the team reach out?\"",
        ].filter(Boolean).join("\n\n");
        // Regenerate through same path (orchestrator or classic)
        if (process.env.AGENT_ORCHESTRATOR_ENABLED === "true") {
          const regenResult = await runOrchestrator({
            message:          rawBody,
            convo,
            client,
            anthropic,
            fromNumber,
            supabase,
            crmSupabase,
            twilioClient,
            knowledgeContext: fullKnowledgeCtx,
            extraInstruction: correction,
          });
          replyText       = regenResult.reply;
          orchestratorDebug = {
            agent:     regenResult.agent,
            action:    regenResult.parsed?.action ?? null,
            context:   regenResult.context,
            ownerMode: regenResult.ownerMode,
          };
        } else {
          replyText = await getClaudeReply(convo, client, season, fullKnowledgeCtx, correction, replyMax);
        }
      }

      // Track that a recommendation was given — unlocks lead capture on the next turn
      if (intent === "recommendation") {
        if (!convo.commercialState) convo.commercialState = { recommendationGiven: false, leadCaptureAttempts: 0 };
        convo.commercialState.recommendationGiven = true;
      }

      // Detect if Claude's reply triggers a handoff
      if (/give (us|jake|him|them) a call at/i.test(replyText)) {
        convo.handoff = true;
        console.log(`[HANDOFF] Claude triggered handoff for ${fromNumber}`);
      }
    }

    } // end if (!replyText) — main routing block

    // Log and store reply
    console.log(JSON.stringify({
      ts: new Date().toISOString(), from: fromNumber,
      role: "assistant", intent, sentiment,
      chars: replyText.length, content: replyText,
    }));

    convo.messages.push({
      role:      "assistant",
      content:   replyText,
      timestamp: new Date().toISOString(),
      intent,
      sentiment: "neutral",
    });

    // 23. Save conversation to Supabase
    await saveConversation(fromNumber, toNumber, convo, client.id);

    // 24. Upsert contact to CRM + auto-tag (only for clients with CRM enabled)
    if (client.crmEnabled && crmSupabase) {
      const tags = deriveTagsFromMessage(rawBody, intent, season);
      if (returning) tags.push("repeat");
      await upsertContact(fromNumber, { source: "sms_conversation", tags }, crmSupabase);
    }

    // 25. Track campaign reply (only for clients with CRM enabled)
    if (client.crmEnabled && crmSupabase) await trackCampaignReply(fromNumber, crmSupabase);

    // 26. Send via Twilio (or return JSON in TEST_MODE / UI mode)
    if (process.env.TEST_MODE === "true" || isUiReq(req)) {
      return res.json({
        reply: replyText,
        meta: {
          intent, sentiment,
          bookingStep:           convo.bookingStep,
          handoff:               convo.handoff,
          stage:                 convo.stage,
          buyingSignalStrength:  buyingSignals.strength,
          buyingSignals:         buyingSignals.signals,
          recommendationGiven:   convo.commercialState?.recommendationGiven ?? false,
          // Phase 7: orchestrator debug fields (null when orchestrator disabled)
          agent:     orchestratorDebug?.agent     ?? null,
          action:    orchestratorDebug?.action    ?? null,
          context:   orchestratorDebug?.context   ?? null,
          ownerMode: orchestratorDebug?.ownerMode ?? false,
          channel:   "sms",
          botName:   client.botName ?? "Summit",
        },
      });
    }

    await twilioClient.messages.create({ body: replyText, from: toNumber, to: fromNumber });

  } catch (error) {
    console.error("[SMS] Error:", error.message);

    if (process.env.TEST_MODE === "true" || isUiReq(req)) {
      return res.json({ reply: "Error: " + error.message });
    }

    try {
      await twilioClient.messages.create({
        body: `Hey! Having a quick issue. Give us a call at ${client.handoffPhone} and we'll help right away. Sorry!`,
        from: toNumber,
        to:   fromNumber,
      });
    } catch (sendErr) {
      console.error("[SMS] Fallback send failed:", sendErr.message);
    }
  }

  // 27. Respond to Twilio
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
}
