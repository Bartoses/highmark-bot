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
  buildSystemPrompt,
  getSeasonalOpener,
  getCurrentSeason,
  enforceLength,
  detectBuyingSignals,
  updateConversationStage,
  buildResponsePlan,
  containsPhoneAsk,
  findRelevantBookingLink,
} from "./index.js";
import { getKnowledgeContext } from "./knowledgeBase.js";
import { saveLead, notifyBusinessOfLead } from "./leads.js";

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE VALIDATORS
// ─────────────────────────────────────────────────────────────────────────────

// True if the reply promises a link but forgot to include a real https:// URL.
// Handles smart/curly apostrophes, "right here:" vs "right there:", bracket placeholders,
// and any phrase that ends with "here:" or "there:" implying a URL should follow.
function containsLinkPromise(text) {
  const t = text ?? "";
  return /here.{0,2}s the link/i.test(t)                                ||
         /right (there|here):/i.test(t)                                  ||
         /\b(date|spot|rental|booking|reservation|book|details).{0,20}here:/i.test(t) ||
         /\bhere:\s*(\(|$)/i.test(t)                                     ||  // "here: (Use code..." or "here:" at end
         /\[[\w_ ]+ link\]/i.test(t)                                     ||  // [rzr_kremmling link]
         /\b(book here|the link is|booking link below|link to book|here.{0,2}s your link|grab your (date|spot) (here|there|at|below))\b/i.test(t);
}

// True if text contains a bare-domain URL (no https://) — Claude hallucination
function containsBareDomainUrl(text) {
  return /\b[\w-]+\.(?:com|org|net|io|co)\/\S+/i.test(text ?? "");
}

// True if the text contains any http/https URL
function containsUrl(text) {
  return /https?:\/\/\S+/.test(text ?? "");
}

// Build a normalized booking links array from client config.
// Works for both static clients (bookingUrls object) and DB clients (bookingLinks array).
function resolveAllBookingLinks(client) {
  const portalLinks = (client.bookingLinks ?? []).filter((l) => l.url);
  if (portalLinks.length) return portalLinks;
  return Object.entries(client.bookingUrls ?? {}).map(([key, url]) => ({
    title:         key.replace(/_/g, " "),
    url,
    description:   "",
    metadata_json: { label: key, keywords: key.split("_") },
  }));
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
// getWebClientConfig — public-safe config blob for the widget frontend
// ─────────────────────────────────────────────────────────────────────────────
export function getWebClientConfig(client) {
  return {
    clientId:     client.id,
    name:         client.name,
    botName:      client.botName ?? "Summit",
    greeting:     client.openerText
                    ?? `Hi! I'm ${client.botName ?? "Summit"} — how can I help today?`,
    primaryColor: client.widgetColor ?? "#2563eb",
    position:     client.widgetPosition ?? "right",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessageWeb — core message handler; reuses SMS bot logic
//
// Returns { reply: string, isNew?: boolean }
// ─────────────────────────────────────────────────────────────────────────────
export async function sendMessageWeb(supabase, anthropic, client, sessionId, message) {
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

  const { isNew, from, to, convo } = await getWebConversation(supabase, sessionId, client.id);

  // ── First message: return the opener immediately ────────────────────────────
  if (isNew || convo.messages.length === 0) {
    const season = getCurrentSeason();
    const opener = enforceLength(getSeasonalOpener(client, season), 480);
    convo.messages.push({ role: "user",      content: message, timestamp: new Date().toISOString(), intent: "smalltalk", sentiment: "positive" });
    convo.messages.push({ role: "assistant", content: opener,  timestamp: new Date().toISOString() });
    await saveWebConversation(supabase, from, to, convo, client.id);
    touchWebSession(supabase, sessionId).catch(() => {});
    return { reply: opener, isNew: true };
  }

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

  let replyText;

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

    // Web-specific instructions injected into the system prompt context
    const webInstruction = [
      "CHANNEL: This is a web chat widget (not SMS). The visitor has NOT provided a phone number.",
      "Do NOT ask for a phone number. If you need contact info, ask for their name and email instead.",
      plan.mustRecommend ? "Answer their question FIRST before any lead capture." : "",
      plan.shouldSoftClose && plan.microClose ? `Soft close opportunity: ${plan.microClose}` : "",
    ].filter(Boolean).join("\n");

    replyText = await callClaude(anthropic, convo, client, season, knowledgeCtx, webInstruction);

    // Regenerate once if Claude asked for phone anyway
    if (containsPhoneAsk(replyText)) {
      replyText = await callClaude(
        anthropic, convo, client, season, knowledgeCtx,
        "IMPORTANT: Do NOT ask for a phone number — this is web chat. If you need contact info, ask for email."
      );
    }

    // If Claude promised a link OR hallucinated a bare-domain URL, replace with the real https:// link.
    // Triggers on: "right here:", "right there:", "here's the link", bare domain URLs, etc.
    if ((containsLinkPromise(replyText) || containsBareDomainUrl(replyText)) && !containsUrl(replyText)) {
      // Remove hallucinated bare-domain URLs and bracket placeholders like [rzr_kremmling link]
      const cleaned = replyText
        .replace(/\[[\w_ ]+ link\]/gi, "")
        .replace(/\b[\w-]+\.(?:com|org|net|io|co)\/\S*/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      const allLinks  = resolveAllBookingLinks(client);
      const recentCtx = convo.messages.slice(-6).map((m) => m.content).join(" ");
      const matched   = findRelevantBookingLink(recentCtx, allLinks, { season });
      const linkUrl   = matched?.link?.url ?? matched?.links?.[0]?.url ?? null;
      if (linkUrl) {
        replyText = `${cleaned.trimEnd()} ${linkUrl}`;
        console.log(`[WEB_CHAT] Link injected: ${linkUrl}`);
      } else {
        replyText = cleaned;
      }
    }

    replyText = enforceLength(replyText, 480);
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  convo.messages.push({ role: "assistant", content: replyText, timestamp: new Date().toISOString() });
  await saveWebConversation(supabase, from, to, convo, client.id);
  touchWebSession(supabase, sessionId).catch(() => {});

  // ── Passive lead capture: parse name/email mentioned naturally ─────────────
  passiveLeadCapture(supabase, client, convo, sessionId, message).catch(() => {});

  return { reply: replyText };
}

// ─────────────────────────────────────────────────────────────────────────────
// passiveLeadCapture — fire-and-forget: look for name/email in visitor messages
// Only saves once per session (checks leadCaptureAttempted flag).
// ─────────────────────────────────────────────────────────────────────────────
async function passiveLeadCapture(supabase, client, convo, sessionId, message) {
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
      console.log(`[WEB_CHAT] Passive lead captured: session=${sessionId} name=${name} email=${email}`);
    }
  } catch (err) {
    console.error("[WEB_CHAT] passiveLeadCapture failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// callClaude — shared Claude call (same model + token budget as SMS)
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(anthropic, convo, client, season, knowledgeCtx, extraInstruction) {
  const messages = convo.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(({ role, content }) => ({ role, content }));

  const system = extraInstruction
    ? `${buildSystemPrompt(client, season, knowledgeCtx)}\n\nCURRENT CONTEXT: ${extraInstruction}`
    : buildSystemPrompt(client, season, knowledgeCtx);

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 550,
    system,
    messages,
  });

  return response.content[0].text;
}
