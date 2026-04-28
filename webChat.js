// ─────────────────────────────────────────────────────────────────────────────
// WEB CHAT — Phase 11: Embed widget message handler
//
// Reuses the same bot logic as SMS (detectIntent, buildSystemPrompt, Claude)
// but replaces the transport layer (Twilio) with a JSON API.
//
// Session model: conversations table, keyed by
//   from_number = "web:<sessionId>"   (the visitor)
//   to_number   = "web:<clientId>"    (the client's widget)
//
// No schema migrations needed for conversations — the existing table works.
// web_sessions table tracks session → lead linkage (db1_web_sessions.sql).
//
// API surface consumed by index.js:
//   sendMessageWeb(supabase, anthropic, client, sessionId, message) → { reply }
//   createWebSession(supabase, clientId, sessionId)                → session row | null
//   touchWebSession(supabase, sessionId)                           → void
//   linkSessionToLead(supabase, sessionId, leadId)                 → void
//   getWebClientConfig(client)                                     → public config
// ─────────────────────────────────────────────────────────────────────────────

import {
  detectIntent,
  detectSentiment,
  getSeasonalOpener,
  getCurrentSeason,
  enforceLength,
  detectBuyingSignals,
  updateConversationStage,
  buildResponsePlan,
  containsPhoneAsk,
  ensureUrlInResponse,
} from "./index.js";
import { callClaudeForChannel, buildChannelInstruction, detectPageType } from "./messageEngine.js";
import { getKnowledgeContext } from "./knowledgeBase.js";
import { saveLead, notifyBusinessOfLead } from "./leads.js";
import { extractBookingContext, resolveBookingLink } from "./bookingLinks.js";
import { trackWebEvent } from "./webEvents.js";
import { linkPhoneToSession, extractPhoneFromMessage, buildSmsBridgeMessage } from "./crossChannel.js";
import {
  isSmsIntent, detectConsentReply, detectPhoneInMessage, extractNameFromMessage,
  buildConsentPrompt, buildConsentConfirmReply, buildPhoneCapturedReply, buildDeclineReply,
} from "./smsOptIn.js";
import { upsertContact } from "./crm.js";

// True if the text contains any http/https URL
function containsUrl(text) {
  return /https?:\/\/\S+/.test(text ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION KEYS — prefixed to avoid collision with real phone numbers
// ─────────────────────────────────────────────────────────────────────────────
export function webFromNumber(sessionId) { return `web:${sessionId}`; }
export function webToNumber(clientId)    { return `web:${clientId}`;  }

// ─────────────────────────────────────────────────────────────────────────────
// getWebConversation — load or init a conversation from the shared table
// ─────────────────────────────────────────────────────────────────────────────
export async function getWebConversation(supabase, sessionId, clientId) {
  const from = webFromNumber(sessionId);
  const to   = webToNumber(clientId);

  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("from_number", from)
    .eq("to_number", to)
    .single();

  if (data) {
    const bd = data.booking_data ?? {};
    return {
      isNew: false, from, to,
      botPaused: data.bot_paused ?? false,
      convo: {
        messages:              data.messages               ?? [],
        bookingStep:           data.booking_step           ?? null,
        bookingData:           bd,
        handoff:               data.handoff                ?? false,
        consecutiveFrustrated: data.consecutive_frustrated ?? 0,
        sessionType:           "web",
        leadStep:              data.lead_step              ?? null,
        leadData:              data.lead_data              ?? null,
        stage:                  bd._stage                  ?? "new",
        leadCaptureAttempted:   bd._leadCaptureAttempted   ?? false,
        leadCapturePendingName: bd._leadCapturePendingName ?? false,
        commercialState:        bd._commercialState        ?? { recommendationGiven: false, leadCaptureAttempts: 0 },
        conversionState:        bd._conversionState        ?? { last_intent: null, last_cta_type: null, urgency_used: false },
        smsOptedIn:             data.sms_opted_in            ?? false,
        smsOptedInAt:           data.sms_opted_in_at         ?? null,
        smsConsentRequested:    data.sms_consent_requested   ?? false,
      },
    };
  }

  return {
    isNew: true, from, to,
    convo: {
      messages:              [],
      bookingStep:           null,
      bookingData:           { activity: null, date: null, groupSize: null, company: null },
      handoff:               false,
      consecutiveFrustrated: 0,
      sessionType:           "web",
      leadStep:              null,
      leadData:              null,
      stage:                 "new",
      leadCaptureAttempted:  false,
      leadCapturePendingName: false,
      commercialState:       { recommendationGiven: false, leadCaptureAttempts: 0 },
      conversionState:       { last_intent: null, last_cta_type: null, urgency_used: false },
      smsOptedIn:            false,
      smsOptedInAt:          null,
      smsConsentRequested:   false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveWebConversation — persist to the shared conversations table
// ─────────────────────────────────────────────────────────────────────────────
export async function saveWebConversation(supabase, from, to, convo, clientId) {
  const bookingData = {
    ...(convo.bookingData ?? {}),
    _stage:                 convo.stage                 ?? "new",
    _leadCaptureAttempted:  convo.leadCaptureAttempted  ?? false,
    _leadCapturePendingName: convo.leadCapturePendingName ?? false,
    _commercialState:       convo.commercialState       ?? { recommendationGiven: false, leadCaptureAttempts: 0 },
    _conversionState:       convo.conversionState       ?? { last_intent: null, last_cta_type: null, urgency_used: false },
  };
  await supabase.from("conversations").upsert(
    {
      from_number:            from,
      to_number:              to,
      messages:               convo.messages,
      booking_step:           convo.bookingStep,
      booking_data:           bookingData,
      handoff:                convo.handoff,
      consecutive_frustrated: convo.consecutiveFrustrated,
      session_type:           "web",
      lead_step:              convo.leadStep,
      lead_data:              convo.leadData,
      client_id:              clientId,
      channel:                "web",
      sms_opted_in:           convo.smsOptedIn          ?? false,
      sms_opted_in_at:        convo.smsOptedInAt        ?? null,
      sms_consent_requested:  convo.smsConsentRequested ?? false,
      updated_at:             new Date().toISOString(),
    },
    { onConflict: "from_number,to_number" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// createWebSession — ensure a web_sessions row exists; graceful if table missing
// ─────────────────────────────────────────────────────────────────────────────
export async function createWebSession(supabase, clientId, sessionId) {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("web_sessions")
      .upsert(
        { client_id: clientId, session_id: sessionId, last_active_at: new Date().toISOString() },
        { onConflict: "session_id" }
      )
      .select()
      .single();
    return data;
  } catch {
    return null; // table may not exist yet — non-fatal
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// touchWebSession — update last_active_at; fire-and-forget safe
// ─────────────────────────────────────────────────────────────────────────────
export async function touchWebSession(supabase, sessionId) {
  if (!supabase) return;
  try {
    await supabase
      .from("web_sessions")
      .update({ last_active_at: new Date().toISOString() })
      .eq("session_id", sessionId);
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// linkSessionToLead — attach a captured lead to the session row
// ─────────────────────────────────────────────────────────────────────────────
export async function linkSessionToLead(supabase, sessionId, leadId) {
  if (!supabase || !leadId) return;
  try {
    await supabase
      .from("web_sessions")
      .update({ lead_id: leadId })
      .eq("session_id", sessionId);
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// getWebClientConfig — public-safe config blob for the widget frontend.
// Accepts optional embedConfig row from the embed_config table; falls back to
// static client fields and sensible defaults when no row exists yet.
// ─────────────────────────────────────────────────────────────────────────────
export function getWebClientConfig(client, embedConfig = null) {
  const ec     = embedConfig ?? {};
  const rawPos = ec.position ?? client.widgetPosition ?? "bottom_right";
  // Handle both formats: embed_config uses "bottom_left"/"bottom_right",
  // static client may use "left"/"right" directly.
  const pos = (rawPos === "bottom_left" || rawPos === "left") ? "left" : "right";
  return {
    clientId:       client.id,
    name:           client.name,
    botName:        client.botName ?? "Summit",
    greeting:       ec.welcome_message ?? client.openerText
                      ?? `Hi! I'm ${client.botName ?? "Summit"} — how can I help today?`,
    primaryColor:   ec.primary_color  ?? client.widgetColor ?? "#2563eb",
    buttonColor:    ec.button_color   ?? ec.primary_color ?? client.widgetColor ?? "#2563eb",
    textColor:      ec.text_color     ?? "#ffffff",
    buttonText:     ec.button_text    ?? "Chat with us",
    showIcon:       ec.show_icon      ?? true,
    size:           ec.size           ?? "medium",
    borderRadius:   ec.border_radius  ?? "16",
    logoUrl:        ec.logo_url       ?? null,
    delaySeconds:   ec.delay_seconds   ?? 0,
    autoOpen:       ec.auto_open       ?? false,
    position:       pos,
    bottomOffset:   ec.bottom_offset   ?? 20,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessageWeb — core message handler; reuses SMS bot logic
//
// Returns { reply: string, isNew?: boolean }
// ─────────────────────────────────────────────────────────────────────────────
export async function sendMessageWeb(supabase, anthropic, client, sessionId, message, { pageHint = null, pageUrl = null, crmSupabase = null } = {}) {
  // ── RESETNOW — clear conversation, return opener ──────────────────────────
  if (message.toUpperCase().trim() === "RESETNOW") {
    const from = webFromNumber(sessionId);
    const to   = webToNumber(client.id);
    await supabase.from("conversations").delete()
      .eq("from_number", from).eq("to_number", to);
    const opener = enforceLength(getSeasonalOpener(client, getCurrentSeason()), 480);
    // Save fresh conversation so the next real message doesn't retrigger the opener
    const freshConvo = {
      messages:              [{ role: "assistant", content: opener, timestamp: new Date().toISOString() }],
      bookingStep:           null,
      bookingData:           { activity: null, date: null, groupSize: null, company: null },
      handoff:               false,
      consecutiveFrustrated: 0,
      sessionType:           "web",
      leadStep:              null,
      leadData:              null,
      stage:                 "new",
      leadCaptureAttempted:  false,
      leadCapturePendingName: false,
      commercialState:       { recommendationGiven: false, leadCaptureAttempts: 0 },
    };
    await saveWebConversation(supabase, from, to, freshConvo, client.id);
    console.log(`[WEB_CHAT] RESETNOW — conversation reset for session=${sessionId} client=${client.id}`);
    return { reply: opener, reset: true };
  }

  const { isNew, from, to, convo, botPaused } = await getWebConversation(supabase, sessionId, client.id);

  // ── Bot-paused gate — agent has taken over, save message but return empty reply ──
  if (botPaused === true) {
    convo.messages.push({
      role:        "user",
      content:     message,
      timestamp:   new Date().toISOString(),
      intent:      "guest_paused",
      sender_type: "guest",
    });
    await saveWebConversation(supabase, from, to, convo, client.id);
    console.log(`[BOT_PAUSED_WEB] Session ${sessionId} paused — message saved, no reply`);
    return { reply: "", paused: true };
  }

  // ── First message: return the opener immediately ────────────────────────────
  if (isNew || convo.messages.length === 0) {
    const season = getCurrentSeason();
    const opener = enforceLength(getSeasonalOpener(client, season), 480);
    convo.messages.push({ role: "user",      content: message, timestamp: new Date().toISOString(), intent: "smalltalk", sentiment: "positive" });
    convo.messages.push({ role: "assistant", content: opener,  timestamp: new Date().toISOString() });
    await saveWebConversation(supabase, from, to, convo, client.id);
    touchWebSession(supabase, sessionId).catch(() => {});
    // Attribution: first message in session
    trackWebEvent(supabase, { clientId: client.id, sessionId, eventType: "chat_started", pageUrl }).catch(() => {});
    return { reply: opener, isNew: true };
  }

  // Attribution: every user message after the first
  trackWebEvent(supabase, { clientId: client.id, sessionId, eventType: "message_sent", pageUrl }).catch(() => {});

  // ── Subsequent messages: classify + route through bot logic ─────────────────
  const season    = getCurrentSeason();
  const intent    = detectIntent(message);
  const sentiment = detectSentiment(message);
  const buying    = detectBuyingSignals(message, convo);

  updateConversationStage(convo, buying, intent, sentiment);

  // Frustration tracking
  if (sentiment === "frustrated") {
    convo.consecutiveFrustrated = (convo.consecutiveFrustrated ?? 0) + 1;
  } else {
    convo.consecutiveFrustrated = 0;
  }

  // Push user message
  convo.messages.push({ role: "user", content: message, timestamp: new Date().toISOString(), intent, sentiment });

  // ── Progressive SMS opt-in state machine (Sprint Prompt 7B) ────────────────
  // Runs BEFORE handoff/Claude so consent + phone capture short-circuit normal flow.
  // Compliance: phone is never collected before explicit opt-in; STOP keyword is
  // still handled by smsOrchestrator on the SMS channel.
  {
    const optInReply = await runSmsOptInFlow(supabase, crmSupabase, client, convo, sessionId, message, pageUrl);
    if (optInReply) {
      convo.messages.push({ role: "assistant", content: optInReply, timestamp: new Date().toISOString() });
      await saveWebConversation(supabase, from, to, convo, client.id);
      touchWebSession(supabase, sessionId).catch(() => {});
      return { reply: optInReply };
    }
  }

  let replyText;
  let resolvedLink = null; // hoisted so conversionState update can reference it

  // ── Handoff ────────────────────────────────────────────────────────────────
  if (
    (intent === "handoff" || (convo.consecutiveFrustrated >= 2)) &&
    (client.humanHandoffEnabled !== false)
  ) {
    const phone = client.handoffPhone ?? client.supportPhone ?? client.leadNotificationPhone;
    replyText = typeof client.handoffReply === "function"
      ? client.handoffReply(phone)
      : `To speak directly with our team, ${phone ? `call or text ${phone}` : "visit our website"}. We're happy to help!`;
    convo.handoff = true;
  }

  // ── Claude ────────────────────────────────────────────────────────────────
  if (!replyText) {
    const knowledgeCtx = await getKnowledgeContext(supabase, client).catch(() => "");
    const plan         = buildResponsePlan(intent, sentiment, buying, convo, client);

    // Pre-resolve booking link when booking intent detected or message is booking-related.
    // Injecting the real URL into the instruction prevents Claude from hallucinating links.
    // (resolvedLink is declared above so conversionState update can reference it)
    const isBookingRelated = intent === "booking" ||
      /book|reserve|booking link|how do i book|where.*book|send.*link/i.test(message);
    if (isBookingRelated) {
      // Include recent conversation context so entity signals from prior turns carry forward
      // (e.g. user said "tell me about RZR" then "booking page" → should resolve to RZR link)
      const recentContext = convo.messages
        .slice(-6)
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => m.content)
        .join(" ");
      const ctx = extractBookingContext(message + " " + recentContext);
      resolvedLink = await resolveBookingLink({
        message,
        entity:   ctx.entity,
        company:  ctx.company,
        location: ctx.location,
        season,
        client,
        supabase,
      }).catch(() => null);
    }

    // Attribution: booking link was surfaced in this reply
    if (resolvedLink?.url) {
      trackWebEvent(supabase, {
        clientId: client.id, sessionId, eventType: "booking_clicked", pageUrl,
        metadata: { url: resolvedLink.url },
      }).catch(() => {});
    }

    // Auto-detect page type from URL when data-page isn't explicitly set
    const pageType = detectPageType(pageUrl);

    // Message count used for urgency gating (Phase 11.7)
    const messageCount = convo.messages.filter(m => m.role === "user").length;

    // Channel-aware instruction for Claude — built by the shared messageEngine utility
    const webInstruction = buildChannelInstruction("web", {
      resolvedLink, plan, pageHint, pageType,
      intent, conversionState: convo.conversionState, messageCount,
    });

    replyText = await callClaudeForChannel(anthropic, convo, client, season, knowledgeCtx, webInstruction, "web");

    // Regenerate once if Claude asked for phone anyway
    if (containsPhoneAsk(replyText)) {
      replyText = await callClaudeForChannel(
        anthropic, convo, client, season, knowledgeCtx,
        "IMPORTANT: Do NOT ask for a phone number — this is web chat. If you need contact info, ask for email.",
        "web"
      );
    }

    // Safety net: if we pre-resolved a link but it's not in the response, append it.
    if (resolvedLink && !containsUrl(replyText)) {
      replyText = ensureUrlInResponse(replyText, resolvedLink.url);
      console.log(`[WEB_CHAT] Safety-net link appended: ${resolvedLink.url}`);
    }
    // Length enforcement already applied inside callClaudeForChannel (480 chars for web).
    // URL-containing replies are never truncated.
  }

  // ── Update conversion state (Phase 11.7) ───────────────────────────────────
  {
    const prev = convo.conversionState ?? {};
    const ctaType = (intent === "booking" && resolvedLink?.url) ? "strong"
      : intent === "booking" ? "soft"
      : intent === "question" || intent === "smalltalk" ? "soft_early"
      : prev.last_cta_type ?? null;
    const messageCount = convo.messages.filter(m => m.role === "user").length;
    convo.conversionState = {
      last_intent:   intent,
      last_cta_type: ctaType,
      urgency_used:  prev.urgency_used || (intent === "booking" && messageCount >= 3),
    };
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  convo.messages.push({ role: "assistant", content: replyText, timestamp: new Date().toISOString() });
  await saveWebConversation(supabase, from, to, convo, client.id);
  touchWebSession(supabase, sessionId).catch(() => {});

  // ── Passive lead capture: parse name/email mentioned naturally ─────────────
  passiveLeadCapture(supabase, client, convo, sessionId, message, pageUrl).catch(() => {});

  // ── Phase 11.8: Cross-channel phone detection — web→SMS identity linking ───
  // When a visitor mentions their phone number, link their session to that phone
  // so the conversation can continue via SMS. Returns bridgePhone so the caller
  // (index.js) can send the SMS bridge without needing Twilio here.
  //
  // Compliance gate: only fire the SMS bridge when the visitor has explicitly
  // opted in via the consent flow. Phones mentioned in passing without opt-in
  // are ignored on the SMS side.
  let bridgePhone = null;
  const detectedPhone = extractPhoneFromMessage(message);
  if (detectedPhone && convo.smsOptedIn && !convo.bookingData?._phoneBridgeSent) {
    const identity = await linkPhoneToSession(supabase, client.id, detectedPhone, sessionId).catch(() => null);
    if (identity) {
      // Build bridge context from recent conversation
      const lastBotMsg   = convo.messages.filter(m => m.role === "assistant").slice(-1)[0]?.content ?? null;
      const allContent   = convo.messages.map(m => m.content).join(" ");
      const urlMatch     = allContent.match(/https?:\/\/\S+/);
      const bookingUrl   = urlMatch ? urlMatch[0] : null;
      bridgePhone = { phone: detectedPhone, message: buildSmsBridgeMessage(lastBotMsg, bookingUrl) };
      // Mark so we don't send a second bridge text in the same conversation
      convo.bookingData = { ...(convo.bookingData ?? {}), _phoneBridgeSent: true };
      await saveWebConversation(supabase, from, to, convo, client.id);
      console.log(`[CROSS_CHANNEL] Web→SMS bridge queued: session=${sessionId} phone=${detectedPhone}`);
    }
  }

  return { reply: replyText, bridgePhone };
}

// ─────────────────────────────────────────────────────────────────────────────
// passiveLeadCapture — fire-and-forget: look for name/email in visitor messages
// Only saves once per session (checks leadCaptureAttempted flag).
// ─────────────────────────────────────────────────────────────────────────────
async function passiveLeadCapture(supabase, client, convo, sessionId, message, pageUrl = null) {
  if (convo.leadCaptureAttempted) return;

  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : null;

  // Extract a plausible name from the visitor's recent messages (heuristic)
  const nameMatch = message.match(/(?:(?:i'?m|i am|my name(?:'s| is)?|call me)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const name = nameMatch ? nameMatch[1] : null;

  if (!email && !name) return; // nothing to capture

  convo.leadCaptureAttempted = true;

  try {
    const lead = await saveLead(supabase, {
      clientId:     client.id,
      contactName:  name ?? null,
      contactPhone: null,
      contactEmail: email ?? null,
      leadType:     "web_chat",
      source:       "web_chat",
      metadata:     { session_id: sessionId },
    });
    if (lead) {
      linkSessionToLead(supabase, sessionId, lead.id).catch(() => {});
      notifyBusinessOfLead(client, lead).catch(() => {});
      trackWebEvent(supabase, { clientId: client.id, sessionId, eventType: "lead_captured", pageUrl }).catch(() => {});
      console.log(`[WEB_CHAT] Passive lead captured: session=${sessionId} name=${name} email=${email}`);
    }
  } catch (err) {
    console.error("[WEB_CHAT] passiveLeadCapture failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runSmsOptInFlow — progressive consent state machine for web chat (Prompt 7B)
//
// Returns a string reply when this turn should short-circuit normal bot flow,
// or null when the message should fall through to Claude / handoff / etc.
//
// Order of checks:
//   1. Consent already pending → classify yes/no/unknown
//   2. Already opted in + phone present → save lead, tag CRM, confirm
//   3. Not opted in + SMS intent → ask for consent (compliance copy embedded)
//   4. Otherwise → null (normal flow continues)
// ─────────────────────────────────────────────────────────────────────────────
async function runSmsOptInFlow(supabase, crmSupabase, client, convo, sessionId, message, pageUrl) {
  // 1. Pending consent → look for yes/no
  if (convo.smsConsentRequested === true) {
    const verdict = detectConsentReply(message);
    if (verdict === "yes") {
      convo.smsOptedIn          = true;
      convo.smsOptedInAt        = new Date().toISOString();
      convo.smsConsentRequested = false;
      logOptIn(`consent granted — session=${sessionId} client=${client.id}`);
      return buildConsentConfirmReply();
    }
    if (verdict === "no") {
      convo.smsOptedIn          = false;
      convo.smsConsentRequested = false;
      logOptIn(`consent declined — session=${sessionId} client=${client.id}`);
      return buildDeclineReply();
    }
    // Unknown reply — clear the pending flag so the user isn't trapped in a
    // consent loop, and let normal bot flow handle the message.
    convo.smsConsentRequested = false;
    return null;
  }

  // 2. Already opted in + phone in this message → capture
  if (convo.smsOptedIn === true) {
    const phone = detectPhoneInMessage(message);
    if (phone && !convo.bookingData?._smsLeadCaptured) {
      // Try this turn first; fall back to the prior user turn (where they
      // may have written "Sean Bartosewcz" before sending the number on its own).
      const priorUserMsg = [...convo.messages]
        .reverse()
        .find((m) => m.role === "user" && m.content !== message)?.content ?? "";
      const name = extractNameFromMessage(message) ?? extractNameFromMessage(priorUserMsg);
      try {
        const lead = await saveLead(supabase, {
          clientId:     client.id,
          // leads.from_number is NOT NULL — use the web session pseudo-phone so
          // the row links back to the conversation in the portal.
          fromNumber:   webFromNumber(sessionId),
          contactPhone: phone,
          name,
          leadType:     "sms_opt_in",
          source:       "web_chat",
        });
        if (lead) {
          linkSessionToLead(supabase, sessionId, lead.id).catch(() => {});
          trackWebEvent(supabase, {
            clientId: client.id, sessionId, eventType: "sms_opt_in_captured", pageUrl,
            metadata: { phone },
          }).catch(() => {});
        }
        // Tag the CRM contact (DB2). Best-effort; only when CRM is enabled.
        if (crmSupabase && client.crmEnabled) {
          const [firstName = null, ...rest] = (name ?? "").split(/\s+/).filter(Boolean);
          const lastName = rest.length ? rest.join(" ") : null;
          await upsertContact(phone, {
            tags:      ["sms_lead"],
            source:    "web_chat_opt_in",
            firstName, lastName,
          }, crmSupabase)
            .catch((err) => console.error("[OPT-IN] CRM tag failed:", err.message));
        }
      } catch (err) {
        console.error("[OPT-IN] saveLead failed:", err.message);
      }
      convo.bookingData = { ...(convo.bookingData ?? {}), _smsLeadCaptured: true };
      logOptIn(`phone captured — session=${sessionId} phone=${phone}`);
      return buildPhoneCapturedReply();
    }
    // Already opted in but no phone yet — fall through (Claude can prompt naturally)
    return null;
  }

  // 3. Not yet opted in → only ask if user expressed intent.
  //    Edge case: a phone in this message without prior consent is IGNORED
  //    here; treating it as intent would skip the consent step.
  if (isSmsIntent(message)) {
    convo.smsConsentRequested = true;
    logOptIn(`consent requested — session=${sessionId} client=${client.id}`);
    return buildConsentPrompt(client);
  }

  return null;
}

function logOptIn(detail) {
  if (process.env.TEST_MODE === "true") {
    console.log(`[OPT-IN] ${detail}`);
  } else {
    console.log(`[OPT-IN] ${detail}`);
  }
}

// callClaude() removed in Phase 11.4 — replaced by callClaudeForChannel() from messageEngine.js
