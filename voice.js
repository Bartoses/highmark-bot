// ─────────────────────────────────────────────────────────────────────────────
// HIGHMARK VOICE AI — Phase 1: infrastructure + call logging
//
// First-class voice module that plugs into the existing Highmark platform (CRM,
// clients, knowledge). Phase 1 scope:
//   • Answer inbound Twilio Voice calls per client (multi-tenant)
//   • Speak a per-client greeting, then either forward to a human (in hours) or
//     take a voicemail (after hours / no transfer target) — never drop a call
//   • Log every call to voice_calls (transcript/summary/spam/lead land in later
//     phases) keyed by Twilio CallSid, with status + recording callbacks
//
// Design mirrors twilioSignature.js: the decisions are pure, side-effect-free
// functions (TwiML builders, config merge, hours check, stat rollups) so every
// branch is unit-testable without a live server, a database, or Twilio. The
// Express handlers are thin wrappers that wire deps (supabase + resolvers) in.
//
// DB tables: db1_voice.sql (voice_numbers, voice_agents, voice_calls). If the
// tables are absent the routes still answer + take voicemail (graceful degrade).
// ─────────────────────────────────────────────────────────────────────────────

// Canonical call outcomes (mirrors the Voice AI dashboard buckets).
export const VOICE_OUTCOMES = [
  "spam",
  "lead",
  "customer",
  "booking",
  "support",
  "voicemail",
  "transferred",
  "completed",
  "no_answer",
];

// Default voice agent config — used when a client has no voice_agents row yet.
export const DEFAULT_VOICE_AGENT = {
  name:               "Receptionist",
  industry:           null,
  welcomePrompt:      null,
  systemPrompt:       null,
  transferThreshold:  0.70,
  forwardingNumber:   null,
  businessHours:      null, // null = always open (always offer transfer if number set)
  spamAggressiveness: "medium",
  aiEnabled:          false, // Phase 2: conversational AI receptionist (false = Phase 1 forward/voicemail)
  enabled:            true,
};

// Fast model for low-latency voice turns — the caller hears silence while Claude
// thinks, so responsiveness beats raw capability for a phone receptionist.
export const VOICE_AI_MODEL = "claude-haiku-4-5-20251001";

// Twilio TTS voice (Amazon Polly neural). Centralized so every <Say> matches.
export const VOICE_TTS = "Polly.Joanna";

// ── escapeXml ─────────────────────────────────────────────────────────────────
// TwiML is XML; any business name / greeting that contains & < > " ' must be
// escaped or Twilio rejects the document.
export function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── isE164 ────────────────────────────────────────────────────────────────────
// Twilio <Dial> needs an E.164 number (+15551234567). Display numbers like
// "(970) 439-1707" are NOT dialable — we only forward to E.164 targets.
export function isE164(num) {
  return typeof num === "string" && /^\+[1-9]\d{6,14}$/.test(num.trim());
}

// ── buildVoiceAgentConfig ─────────────────────────────────────────────────────
// Merge: DEFAULT_VOICE_AGENT  <-  client defaults  <-  voice_agents DB row
//                                                   <-  voice_numbers row (forwarding)
// Returns the resolved agent config used at call time.
export function buildVoiceAgentConfig(client = {}, agentRow = null, numberRow = null) {
  const cfg = { ...DEFAULT_VOICE_AGENT };

  // Sensible client-derived defaults.
  if (client.botName) cfg.name = client.botName;
  if (client.industry) cfg.industry = client.industry;

  // DB agent row overrides (only when present).
  if (agentRow) {
    if (agentRow.name)               cfg.name               = agentRow.name;
    if (agentRow.industry)           cfg.industry           = agentRow.industry;
    if (agentRow.welcome_prompt)     cfg.welcomePrompt      = agentRow.welcome_prompt;
    if (agentRow.system_prompt)      cfg.systemPrompt       = agentRow.system_prompt;
    if (agentRow.transfer_threshold != null) cfg.transferThreshold = Number(agentRow.transfer_threshold);
    if (agentRow.forwarding_number)  cfg.forwardingNumber   = agentRow.forwarding_number;
    if (agentRow.business_hours && Object.keys(agentRow.business_hours).length)
      cfg.businessHours = agentRow.business_hours;
    if (agentRow.spam_aggressiveness) cfg.spamAggressiveness = agentRow.spam_aggressiveness;
    if (typeof agentRow.ai_enabled === "boolean") cfg.aiEnabled = agentRow.ai_enabled;
    if (typeof agentRow.enabled === "boolean") cfg.enabled = agentRow.enabled;
  }

  // A voice number's forwarding target wins (most specific routing).
  if (numberRow?.forwarding_number) cfg.forwardingNumber = numberRow.forwarding_number;

  // Last-resort transfer target: a client handoff/support line, only if E.164.
  if (!cfg.forwardingNumber && isE164(client.handoffPhone)) cfg.forwardingNumber = client.handoffPhone;

  return cfg;
}

// ── buildGreeting ─────────────────────────────────────────────────────────────
export function buildGreeting(cfg = {}, client = {}) {
  if (cfg.welcomePrompt) return cfg.welcomePrompt;
  const biz = client.name || client.botName || "our team";
  return `Thanks for calling ${biz}. How can I help you today?`;
}

// ── isWithinBusinessHours ─────────────────────────────────────────────────────
// businessHours shape: { timezone, hours: { "0".."6": { open: "09:00", close: "17:00" } } }
//   day index: 0 = Sunday … 6 = Saturday (JS getDay convention)
// Returns true when no hours are configured (always open) or `now` falls inside
// the configured open/close window for that weekday in the agent's timezone.
export function isWithinBusinessHours(businessHours, now = new Date()) {
  if (!businessHours || !businessHours.hours || !Object.keys(businessHours.hours).length) {
    return true; // unconfigured = always available
  }
  const tz = businessHours.timezone || "America/Denver";

  let dayIdx, hh, mm;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const wk = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    dayIdx = map[wk] ?? now.getDay();
    hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
    mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  } catch {
    dayIdx = now.getDay(); hh = now.getHours(); mm = now.getMinutes();
  }

  const window = businessHours.hours[String(dayIdx)];
  if (!window || !window.open || !window.close) return false; // closed that day

  const cur = hh * 60 + mm;
  const toMin = (s) => {
    const [h, m] = String(s).split(":").map((n) => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  };
  return cur >= toMin(window.open) && cur < toMin(window.close);
}

// ─────────────────────────────────────────────────────────────────────────────
// TwiML BUILDERS (pure) — return XML strings Twilio executes.
// ─────────────────────────────────────────────────────────────────────────────

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
}

// Greeting → live transfer (record both legs) OR voicemail fallback.
// recordingCallback / statusCallback / voicemailAction are absolute URLs.
export function buildIncomingTwiml({
  greeting,
  forwardingNumber = null,
  withinHours = true,
  voiceName = "Polly.Joanna",
  recordingCallback = "",
  statusCallback = "",
  voicemailAction = "",
  voicemailPrompt = "Please leave a message after the tone, and we'll get right back to you.",
} = {}) {
  const say = `<Say voice="${escapeXml(voiceName)}">${escapeXml(greeting)}</Say>`;

  // Live transfer only when we have a dialable target AND we're open.
  if (withinHours && isE164(forwardingNumber)) {
    const dialAttrs = [
      `record="record-from-answer-dual"`,
      recordingCallback ? `recordingStatusCallback="${escapeXml(recordingCallback)}"` : "",
      recordingCallback ? `recordingStatusCallbackEvent="completed"` : "",
      statusCallback ? `action="${escapeXml(statusCallback)}"` : "",
      `timeout="20"`,
    ].filter(Boolean).join(" ");
    // If the dial fails/no-answer, Twilio continues to the voicemail block.
    return twiml(
      `${say}<Dial ${dialAttrs}>${escapeXml(forwardingNumber)}</Dial>` +
      buildVoicemailInner({ recordingCallback, voicemailAction, prompt: voicemailPrompt, voiceName })
    );
  }

  // No transfer target or after hours → straight to voicemail.
  return twiml(say + buildVoicemailInner({ recordingCallback, voicemailAction, prompt: voicemailPrompt, voiceName }));
}

function buildVoicemailInner({ recordingCallback = "", voicemailAction = "", prompt = "", voiceName = "Polly.Joanna" }) {
  const recAttrs = [
    `maxLength="120"`,
    `playBeep="true"`,
    `trim="trim-silence"`,
    voicemailAction ? `action="${escapeXml(voicemailAction)}"` : "",
    recordingCallback ? `recordingStatusCallback="${escapeXml(recordingCallback)}"` : "",
  ].filter(Boolean).join(" ");
  return `<Say voice="${escapeXml(voiceName)}">${escapeXml(prompt)}</Say><Record ${recAttrs}/><Hangup/>`;
}

// Standalone voicemail document (used by the voicemail action route if needed).
export function buildVoicemailTwiml({ message = "Thanks — goodbye.", voiceName = "Polly.Joanna" } = {}) {
  return twiml(`<Say voice="${escapeXml(voiceName)}">${escapeXml(message)}</Say><Hangup/>`);
}

// Polite hangup (e.g. high-confidence spam in Phase 4).
export function buildHangupTwiml({ message = "Thanks for calling. Goodbye.", voiceName = "Polly.Joanna" } = {}) {
  return twiml(`<Say voice="${escapeXml(voiceName)}">${escapeXml(message)}</Say><Hangup/>`);
}

// ── normalizeCallStatus ───────────────────────────────────────────────────────
// Map Twilio CallStatus / DialCallStatus → our voice_calls.status vocabulary.
export function normalizeCallStatus(twilioStatus) {
  switch (String(twilioStatus || "").toLowerCase()) {
    case "completed": return "completed";
    case "answered":  return "completed";
    case "busy":      return "no_answer";
    case "no-answer": return "no_answer";
    case "failed":    return "failed";
    case "canceled":  return "failed";
    case "ringing":   return "ringing";
    case "in-progress": return "in_progress";
    default:          return "in_progress";
  }
}

// ── summarizeVoiceCallStats ───────────────────────────────────────────────────
// Roll a list of voice_calls rows into the dashboard counters.
export function summarizeVoiceCallStats(calls = []) {
  const out = {
    total: 0, spam: 0, lead: 0, customer: 0, booking: 0,
    voicemail: 0, transferred: 0, support: 0, completed: 0, missed: 0,
    totalDurationSec: 0,
  };
  for (const c of calls) {
    out.total += 1;
    if (Number.isFinite(c?.duration)) out.totalDurationSec += c.duration;
    const o = c?.outcome;
    if (o && o in out) out[o] += 1;
    if (c?.status === "no_answer" || c?.status === "failed") out.missed += 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — CONVERSATIONAL AI RECEPTIONIST (turn-based via Twilio <Gather speech>)
//
// Flow: greeting → <Gather input="speech"> → /voice/respond gets the transcribed
// SpeechResult → Claude answers (using the client's knowledge base) → <Say> the
// answer → <Gather> again. Claude emits a control token when it decides to hand
// off ([TRANSFER]) or end the call ([END]); we strip it and act on it.
// ─────────────────────────────────────────────────────────────────────────────

// ── cleanForSpeech ──────────────────────────────────────────────────────────────
// TTS reads text literally, so strip markdown / emoji / raw URLs and collapse
// whitespace. URLs are replaced with "our website" rather than spelled out.
export function cleanForSpeech(text) {
  return String(text ?? "")
    .replace(/\[(TRANSFER|END|SPAM)\]/gi, " ")
    .replace(/https?:\/\/\S+/gi, "our website")
    .replace(/[*_`#>]/g, "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}←-⇿⌀-⏿]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── parseAgentDecision ──────────────────────────────────────────────────────────
// Detect Claude's control token, strip it, return the spoken text + next action.
export function parseAgentDecision(rawText) {
  const text = String(rawText ?? "");
  let action = "continue";
  if (/\[SPAM\]/i.test(text)) action = "spam";
  else if (/\[TRANSFER\]/i.test(text)) action = "transfer";
  else if (/\[END\]/i.test(text)) action = "end";
  return { action, speech: cleanForSpeech(text) };
}

// ── detectCallerEndIntent ───────────────────────────────────────────────────────
// Belt-and-suspenders: catch obvious caller sign-offs even if Claude omits [END].
export function detectCallerEndIntent(speech) {
  const s = String(speech ?? "").toLowerCase().trim();
  if (!s) return false;
  return /\b(goodbye|good bye|bye now|that'?s all|that is all|nothing else|no that'?s it|hang up|i'?m good|all set|have a good)\b/.test(s) ||
         s === "bye" || s === "no thanks" || s === "no thank you";
}

// ── Spam / solicitation detection ───────────────────────────────────────────────
// Robocallers and B2B solicitors must never reach the human transfer line. We
// catch them two ways: a deterministic phrase match (instant, no Claude call) and
// a [SPAM] control token Claude can emit for subtler sales pitches.
export const SPAM_PHRASES = [
  "google listing", "google business", "business listing", "yelp listing",
  "search engine optimization", "seo services", "first page of google", "rank your", "rank higher",
  "merchant services", "lower your rate", "credit card processing",
  "extended warranty", "vehicle warranty", "car's warranty", "auto warranty",
  "final notice", "social security", "medicare", "irs",
  "solar quote", "health insurance", "auto insurance quote",
  "marketing services", "digital marketing", "web design services",
  "business loan", "working capital", "grant for your business",
  "calling about your business listing", "calling regarding your listing",
];

export function detectSpamSignals(text) {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return false;
  return SPAM_PHRASES.some((p) => s.includes(p));
}

// ── buildReceptionistSystemPrompt ───────────────────────────────────────────────
// Persona + rules + the client's knowledge base. Tuned for SPOKEN replies.
export function buildReceptionistSystemPrompt({ client = {}, agentCfg = {}, knowledge = "" } = {}) {
  const biz = client.name || client.botName || "the business";
  const canTransfer = isE164(agentCfg.forwardingNumber);
  return [
    `You are a friendly, efficient phone receptionist for ${biz}. You are speaking out loud on a live phone call, so:`,
    `- Keep replies SHORT — 1 to 2 spoken sentences. No lists, no markdown, no emojis, never read out URLs.`,
    `- Sound warm and natural, like a helpful local on the phone. Use the caller's words back to them.`,
    `- Answer using the KNOWLEDGE below. If you don't know or it needs a human (booking changes, complex pricing, complaints, or the caller asks for a person), say you'll connect them and end your message with the token [TRANSFER]${canTransfer ? "" : " (note: no live agent is available right now, so instead offer to take a message)"}.`,
    `- When the caller is finished or says goodbye, give a brief friendly sign-off and end your message with the token [END].`,
    `- If the caller is a salesperson or solicitor (SEO, Google/Yelp listing, website or marketing services, merchant services, insurance, extended warranty, business loans, etc.), do NOT help them and do NOT transfer. Politely say we're not interested and end your message with the token [SPAM].`,
    `- Never invent prices, dates, availability, or policies that aren't in the KNOWLEDGE. If unsure, offer to transfer.`,
    `- Control tokens [TRANSFER], [END], and [SPAM] must be the LAST thing in your message and are never spoken.`,
    ``,
    `KNOWLEDGE:`,
    (knowledge && knowledge.trim()) ? knowledge.trim() : `(No extra knowledge available — keep answers general and transfer for specifics.)`,
  ].join("\n");
}

// ── buildGatherTwiml ────────────────────────────────────────────────────────────
// Speak `say`, then listen for the caller's speech and POST it to `action`.
// actionOnEmptyResult=true so a silent caller still hits the handler (reprompt).
export function buildGatherTwiml({
  say,
  action,
  voiceName = VOICE_TTS,
  speechHints = "",
  speechTimeout = "auto",
} = {}) {
  const gAttrs = [
    `input="speech"`,
    `action="${escapeXml(action)}"`,
    `method="POST"`,
    `speechTimeout="${escapeXml(speechTimeout)}"`,
    `speechModel="phone_call"`,
    `enhanced="true"`,
    `actionOnEmptyResult="true"`,
    speechHints ? `hints="${escapeXml(speechHints)}"` : "",
  ].filter(Boolean).join(" ");
  const sayTag = say ? `<Say voice="${escapeXml(voiceName)}">${escapeXml(say)}</Say>` : "";
  return twiml(`<Gather ${gAttrs}>${sayTag}</Gather>`);
}

// ── buildTranscript ─────────────────────────────────────────────────────────────
// Render turn objects [{role:'caller'|'agent', text}] to a readable transcript.
export function buildTranscript(turns = []) {
  return turns
    .map((t) => `${t.role === "agent" ? "Receptionist" : "Caller"}: ${t.text}`)
    .join("\n");
}

// ── generateVoiceReply (Claude call) ─────────────────────────────────────────────
// turns: [{role:'user'|'assistant', content}] conversation history.
// The system block (persona + KB) is identical across every turn of a call, so we
// mark it cache_control: ephemeral via a raw API call — a cache hit on turns 2+ cuts
// input-token cost ~90% and shaves latency. Falls back to the SDK on any failure.
export async function generateVoiceReply({ anthropic, system, turns, model = VOICE_AI_MODEL }) {
  const maxTokens = 160;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Preferred path: raw fetch with prompt caching on the system block.
  if (apiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: turns,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const text = (json?.content ?? []).map((b) => b.text || "").join(" ").trim();
        if (text) return text;
      }
    } catch (err) {
      console.error("[VOICE] cached reply error:", err?.message);
    }
  }

  // Fallback: SDK path (no caching) to preserve availability.
  if (!anthropic) return "I'm sorry, I'm having trouble right now. Let me connect you with someone. [TRANSFER]";
  try {
    const res = await anthropic.messages.create({ model, max_tokens: maxTokens, system, messages: turns });
    const text = (res?.content ?? []).map((b) => b.text || "").join(" ").trim();
    return text || "Sorry, could you say that again?";
  } catch (err) {
    console.error("[VOICE] Claude reply error:", err?.message);
    return "I'm having a little trouble — let me get someone to help you. [TRANSFER]";
  }
}

// ── summarizeVoiceCall (Claude call) ─────────────────────────────────────────────
// Post-call: condense the transcript into a one-line summary + an outcome bucket.
export async function summarizeVoiceCall({ anthropic, transcript, model = VOICE_AI_MODEL }) {
  const fallback = { summary: null, outcome: null };
  if (!anthropic || !transcript || !transcript.trim()) return fallback;
  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: 200,
      system:
        `Summarize this phone call transcript in ONE short sentence, then classify the outcome. ` +
        `Respond ONLY as compact JSON: {"summary": string, "outcome": one of ${VOICE_OUTCOMES.join("|")}}. ` +
        `Use "lead" if the caller is a potential customer asking about services, "booking" if they booked or tried to book, ` +
        `"customer" for an existing customer, "support" for a question/issue, "spam" for solicitation, "transferred" if handed to a human.`,
      messages: [{ role: "user", content: transcript.slice(0, 6000) }],
    });
    const text = (res?.content ?? []).map((b) => b.text || "").join(" ").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { summary: text.slice(0, 240) || null, outcome: null };
    const parsed = JSON.parse(match[0]);
    const outcome = VOICE_OUTCOMES.includes(parsed.outcome) ? parsed.outcome : null;
    return { summary: parsed.summary ? String(parsed.summary).slice(0, 280) : null, outcome };
  } catch (err) {
    console.error("[VOICE] summary error:", err?.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB ACCESS (graceful — missing table / no supabase never throws to the caller)
// ─────────────────────────────────────────────────────────────────────────────

export async function getVoiceNumber(supabase, toNumber) {
  if (!supabase || !toNumber) return null;
  try {
    const { data, error } = await supabase
      .from("voice_numbers")
      .select("*")
      .eq("twilio_number", toNumber)
      .maybeSingle();
    if (error) return null;
    return data ?? null;
  } catch { return null; }
}

export async function getVoiceAgent(supabase, clientId) {
  if (!supabase || !clientId) return null;
  try {
    const { data, error } = await supabase
      .from("voice_agents")
      .select("*")
      .eq("client_id", clientId)
      .eq("enabled", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return data ?? null;
  } catch { return null; }
}

// Idempotent claim: insert the call row once per CallSid. Twilio retries + the
// status/recording callbacks all reference the same SID, so we upsert-on-conflict.
export async function claimCall(supabase, { callSid, clientId, from, to, direction = "inbound", metadata = null }) {
  if (!supabase || !callSid) return null;
  const row = {
    call_sid:      callSid,
    client_id:     clientId ?? "unknown",
    caller_number: from ?? null,
    to_number:     to ?? null,
    direction,
    status:        "in_progress",
  };
  if (metadata) row.metadata = metadata;
  try {
    const { data, error } = await supabase
      .from("voice_calls")
      .upsert(row, { onConflict: "call_sid", ignoreDuplicates: true })
      .select()
      .maybeSingle();
    if (error) return null;
    return data ?? null;
  } catch { return null; }
}

// Read a single call row by SID (used per AI turn to load conversation state).
export async function getCallBySid(supabase, callSid) {
  if (!supabase || !callSid) return null;
  try {
    const { data, error } = await supabase
      .from("voice_calls")
      .select("*")
      .eq("call_sid", callSid)
      .maybeSingle();
    if (error) return null;
    return data ?? null;
  } catch { return null; }
}

// Patch a call row by SID (status / duration / recording / outcome / ended_at).
export async function updateCallBySid(supabase, callSid, patch = {}) {
  if (!supabase || !callSid || !Object.keys(patch).length) return null;
  try {
    const { data, error } = await supabase
      .from("voice_calls")
      .update(patch)
      .eq("call_sid", callSid)
      .select()
      .maybeSingle();
    if (error) return null;
    return data ?? null;
  } catch { return null; }
}

export async function listVoiceCalls(supabase, clientId, { limit = 100 } = {}) {
  if (!supabase || !clientId) return [];
  try {
    const { data, error } = await supabase
      .from("voice_calls")
      .select("*")
      .eq("client_id", clientId)
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return data ?? [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS HANDLERS
// deps: { resolveClient, resolveClientById, supabase, baseUrl, anthropic, getKnowledgeContext }
//   baseUrl — absolute origin for Twilio callbacks (PUBLIC_BASE_URL or reconstructed)
//   anthropic + getKnowledgeContext — Phase 2 AI receptionist (optional; absent = Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

// Build Twilio speech `hints` from the client's services + common call phrases to
// improve recognition accuracy on a phone line.
function buildSpeechHints(client = {}) {
  const base = ["booking", "reservation", "tour", "rental", "hours", "price", "cancel", "availability", "directions"];
  const svc = Array.isArray(client.services) ? client.services : [];
  return [...svc, ...base].slice(0, 50).join(", ");
}

function absUrl(baseUrl, path) {
  if (!baseUrl) return path; // relative fallback (Twilio resolves against the webhook host)
  return `${String(baseUrl).replace(/\/$/, "")}${path}`;
}

function sendTwiml(res, xml) {
  res.set("Content-Type", "text/xml");
  return res.status(200).send(xml);
}

// POST /voice/incoming — Twilio answers an inbound call here.
export async function handleVoiceIncoming(req, res, deps = {}) {
  const { resolveClient, resolveClientById, supabase, baseUrl } = deps;
  const to      = req.body?.To;
  const from    = req.body?.From;
  const callSid = req.body?.CallSid;

  try {
    // Route the called number → client (DB voice_numbers first, then SMS routing).
    let numberRow = null;
    let client = null;
    if (supabase) numberRow = await getVoiceNumber(supabase, to);
    if (numberRow && typeof resolveClientById === "function") {
      client = resolveClientById(numberRow.client_id);
    }
    if (!client && typeof resolveClient === "function") client = resolveClient(to);
    client = client || {};

    const agentRow = supabase ? await getVoiceAgent(supabase, client.id) : null;
    const cfg = buildVoiceAgentConfig(client, agentRow, numberRow);

    // ── Phase 2: conversational AI receptionist ─────────────────────────────────
    // When the agent has AI enabled and we have a model wired, greet + listen for
    // speech, then hand each turn to /voice/respond. Falls back to Phase 1 below.
    if (cfg.aiEnabled && cfg.enabled && deps.anthropic) {
      if (callSid && supabase) {
        // Cache routing facts (client + transfer target) so each turn skips the
        // voice_agents / voice_numbers lookups → lower per-turn latency.
        claimCall(supabase, {
          callSid, clientId: client.id, from, to, direction: "inbound",
          metadata: { ai: true, turns: [], no_input: 0, client_id: client.id, fwd: cfg.forwardingNumber || null },
        }).catch(() => {});
      }
      return sendTwiml(res, buildGatherTwiml({
        say:         buildGreeting(cfg, client),
        action:      absUrl(baseUrl, "/voice/respond"),
        speechHints: buildSpeechHints(client),
      }));
    }

    // ── Phase 1: forward (in hours + E.164 target) or voicemail ─────────────────
    // Fire-and-forget call log (never block the answer on the DB).
    if (callSid && supabase) {
      claimCall(supabase, { callSid, clientId: client.id, from, to, direction: "inbound" }).catch(() => {});
    }

    const withinHours = isWithinBusinessHours(cfg.businessHours);
    const xml = buildIncomingTwiml({
      greeting:          buildGreeting(cfg, client),
      forwardingNumber:  cfg.forwardingNumber,
      withinHours,
      recordingCallback: absUrl(baseUrl, "/voice/recording"),
      statusCallback:    absUrl(baseUrl, "/voice/status"),
      voicemailAction:   absUrl(baseUrl, "/voice/status"),
    });
    return sendTwiml(res, xml);
  } catch (err) {
    console.error("[VOICE] incoming error:", err?.message);
    // Never drop a call — answer with a graceful voicemail.
    return sendTwiml(res, buildIncomingTwiml({
      greeting: "Thanks for calling. Please leave a message and we'll get back to you.",
      forwardingNumber: null,
      withinHours: false,
      recordingCallback: absUrl(baseUrl, "/voice/recording"),
      voicemailAction:   absUrl(baseUrl, "/voice/status"),
    }));
  }
}

// POST /voice/respond — Phase 2: one conversational turn of the AI receptionist.
// Twilio posts the caller's transcribed SpeechResult here; we answer with Claude
// and either keep listening, transfer to a human, or end the call.
export async function handleVoiceRespond(req, res, deps = {}) {
  const { resolveClient, resolveClientById, supabase, baseUrl, anthropic, getKnowledgeContext } = deps;
  const callSid = req.body?.CallSid;
  const to      = req.body?.To;
  const speech  = (req.body?.SpeechResult || "").trim();
  const hints   = (c) => buildSpeechHints(c);

  try {
    // Load call state (conversation turns + cached KB live in metadata).
    const row = supabase ? await getCallBySid(supabase, callSid) : null;
    const meta = (row?.metadata && typeof row.metadata === "object") ? row.metadata : { turns: [], no_input: 0 };
    meta.turns = Array.isArray(meta.turns) ? meta.turns : [];

    // Resolve client + transfer target from CACHED metadata (in-memory, no DB
    // round-trips per turn). Only fall back to a lookup if the cache is cold.
    const clientId = meta.client_id || row?.client_id;
    let client = null;
    if (clientId && typeof resolveClientById === "function") client = resolveClientById(clientId);
    if (!client && typeof resolveClient === "function") client = resolveClient(to);
    client = client || {};

    let fwd = meta.fwd;
    if (fwd === undefined) {
      const agentRow = supabase ? await getVoiceAgent(supabase, client.id) : null;
      fwd = buildVoiceAgentConfig(client, agentRow, supabase ? await getVoiceNumber(supabase, to) : null).forwardingNumber;
      meta.fwd = fwd || null;
    }
    const cfg = { forwardingNumber: fwd };
    const canTransfer = isE164(fwd);

    // ── No speech captured → reprompt once, then wrap up gracefully ──────────────
    if (!speech) {
      meta.no_input = (meta.no_input || 0) + 1;
      if (meta.no_input >= 2) {
        if (supabase) await updateCallBySid(supabase, callSid, { metadata: meta });
        if (canTransfer) {
          return sendTwiml(res, twiml(
            `<Say voice="${VOICE_TTS}">No problem — let me connect you with our team. One moment.</Say>` +
            `<Dial action="${escapeXml(absUrl(baseUrl, "/voice/status"))}" timeout="25">${escapeXml(cfg.forwardingNumber)}</Dial>`
          ));
        }
        return sendTwiml(res, buildVoicemailTwiml({ message: "I didn't catch that. Please call back anytime — goodbye!" }));
      }
      if (supabase) await updateCallBySid(supabase, callSid, { metadata: meta });
      return sendTwiml(res, buildGatherTwiml({
        say: "Sorry, I didn't catch that. What can I help you with?",
        action: absUrl(baseUrl, "/voice/respond"),
        speechHints: hints(client),
      }));
    }

    // ── Caller spoke → answer with Claude ────────────────────────────────────────
    meta.no_input = 0;
    meta.turns.push({ role: "caller", text: speech });

    // ── Spam guard (deterministic, instant) — solicitors never reach the human ───
    if (detectSpamSignals(speech)) {
      meta.turns.push({ role: "agent", text: "We're not interested, thank you. Goodbye." });
      if (supabase) await updateCallBySid(supabase, callSid, {
        transcript: buildTranscript(meta.turns), metadata: meta, outcome: "spam", spam_score: 0.95,
      });
      return sendTwiml(res, buildHangupTwiml({ message: "Thanks, we're not interested. Goodbye." }));
    }

    // Cache the knowledge base on the row after the first fetch (saves latency).
    // Cap length so the spoken-reply model stays fast and focused.
    let kb = meta.kb;
    if (kb == null && typeof getKnowledgeContext === "function" && supabase) {
      try { kb = await getKnowledgeContext(supabase, client); } catch { kb = ""; }
      meta.kb = (kb || "").slice(0, 2800);
      kb = meta.kb;
    }

    const system = buildReceptionistSystemPrompt({ client, agentCfg: cfg, knowledge: kb || "" });
    const history = meta.turns.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", content: t.text }));
    const reply = await generateVoiceReply({ anthropic, system, turns: history });
    let decision = parseAgentDecision(reply);
    // Belt-and-suspenders: honor an obvious caller sign-off even if Claude missed [END].
    if (decision.action === "continue" && detectCallerEndIntent(speech)) decision.action = "end";

    meta.turns.push({ role: "agent", text: decision.speech });
    const transcript = buildTranscript(meta.turns);
    if (supabase) await updateCallBySid(supabase, callSid, { transcript, metadata: meta });

    // ── Spam (Claude-classified) → decline + hang up, NEVER transfer ─────────────
    if (decision.action === "spam") {
      if (supabase) await updateCallBySid(supabase, callSid, { outcome: "spam", spam_score: 0.9 });
      return sendTwiml(res, buildHangupTwiml({ message: decision.speech || "Thanks, we're not interested. Goodbye." }));
    }

    // ── Transfer to a human ──────────────────────────────────────────────────────
    if (decision.action === "transfer") {
      if (canTransfer) {
        if (supabase) await updateCallBySid(supabase, callSid, { outcome: "transferred" });
        return sendTwiml(res, twiml(
          `<Say voice="${VOICE_TTS}">${escapeXml(decision.speech || "Let me connect you with our team. One moment.")}</Say>` +
          `<Dial action="${escapeXml(absUrl(baseUrl, "/voice/status"))}" timeout="25">${escapeXml(cfg.forwardingNumber)}</Dial>` +
          `<Say voice="${VOICE_TTS}">Sorry, no one is available right now. Please leave a message after the tone.</Say>` +
          `<Record maxLength="120" playBeep="true" trim="trim-silence" action="${escapeXml(absUrl(baseUrl, "/voice/status"))}" recordingStatusCallback="${escapeXml(absUrl(baseUrl, "/voice/recording"))}"/><Hangup/>`
        ));
      }
      // No live agent → take a voicemail instead.
      return sendTwiml(res, twiml(
        `<Say voice="${VOICE_TTS}">${escapeXml(decision.speech || "I'll have our team follow up.")} Please leave your name, number, and message after the tone.</Say>` +
        `<Record maxLength="120" playBeep="true" trim="trim-silence" action="${escapeXml(absUrl(baseUrl, "/voice/status"))}" recordingStatusCallback="${escapeXml(absUrl(baseUrl, "/voice/recording"))}"/><Hangup/>`
      ));
    }

    // ── Caller is done ───────────────────────────────────────────────────────────
    if (decision.action === "end") {
      return sendTwiml(res, buildHangupTwiml({ message: decision.speech || "Thanks for calling. Goodbye!" }));
    }

    // ── Keep the conversation going ──────────────────────────────────────────────
    return sendTwiml(res, buildGatherTwiml({
      say: decision.speech,
      action: absUrl(baseUrl, "/voice/respond"),
      speechHints: hints(client),
    }));
  } catch (err) {
    console.error("[VOICE] respond error:", err?.message);
    return sendTwiml(res, buildHangupTwiml({ message: "Sorry, I'm having trouble. Please call back in a moment. Goodbye." }));
  }
}

// POST /voice/status — Twilio status / Dial-action / voicemail-action callback.
export async function handleVoiceStatus(req, res, deps = {}) {
  const { supabase, anthropic } = deps;
  const callSid = req.body?.CallSid;
  const isDialAction = !!req.body?.DialCallStatus; // mid-call Dial-action vs. final call status
  const rawStatus = req.body?.DialCallStatus || req.body?.CallStatus;
  const durationStr = req.body?.DialCallDuration || req.body?.CallDuration || req.body?.RecordingDuration;
  const recordingUrl = req.body?.RecordingUrl;

  if (callSid && supabase) {
    const patch = {};
    if (rawStatus) {
      patch.status = normalizeCallStatus(rawStatus);
      if (["completed", "failed", "no_answer"].includes(patch.status)) {
        patch.ended_at = new Date().toISOString();
      }
    }
    const dur = parseInt(durationStr, 10);
    if (Number.isFinite(dur)) patch.duration = dur;
    if (recordingUrl) patch.recording_url = `${recordingUrl}.mp3`;
    await updateCallBySid(supabase, callSid, patch);

    // ── Phase 2: post-call summary + outcome from the AI transcript ──────────────
    // Only on the FINAL parent-call completion (not the mid-call Dial action), and
    // only once (skip if a summary already exists). Fire-and-forget; never blocks.
    const terminal = ["completed", "failed", "no_answer"].includes(normalizeCallStatus(req.body?.CallStatus));
    if (anthropic && !isDialAction && terminal) {
      const row = await getCallBySid(supabase, callSid);
      if (row?.transcript && !row.summary) {
        const { summary, outcome } = await summarizeVoiceCall({ anthropic, transcript: row.transcript });
        const sp = {};
        if (summary) sp.summary = summary;
        if (outcome && !row.outcome) sp.outcome = outcome;
        if (Object.keys(sp).length) await updateCallBySid(supabase, callSid, sp);
      }
    }
  }

  // Status callbacks expect a 200; an empty TwiML keeps any in-progress call valid.
  return sendTwiml(res, twiml(""));
}

// POST /voice/recording — Twilio recording-status callback (voicemail or dual).
export async function handleVoiceRecording(req, res, deps = {}) {
  const { supabase } = deps;
  const callSid = req.body?.CallSid;
  const recordingUrl = req.body?.RecordingUrl;
  const durationStr = req.body?.RecordingDuration;

  if (callSid && supabase && recordingUrl) {
    const patch = { recording_url: `${recordingUrl}.mp3` };
    const dur = parseInt(durationStr, 10);
    if (Number.isFinite(dur) && dur > 0) patch.outcome = "voicemail";
    await updateCallBySid(supabase, callSid, patch);
  }
  return sendTwiml(res, twiml(""));
}

// GET /portal/api/voice/calls — client-scoped call log + dashboard counters.
// `resolvePortalClientId` is injected to avoid a circular import on portalAuth.
export async function handlePortalVoiceCalls(req, res, supabase, resolvePortalClientId) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const limit = Math.min(parseInt(req.query?.limit, 10) || 100, 500);
  try {
    const { data, error } = await supabase
      .from("voice_calls")
      .select("*")
      .eq("client_id", clientId)
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (error.message?.includes("does not exist")) {
        return res.json({ calls: [], stats: summarizeVoiceCallStats([]) });
      }
      return res.status(500).json({ error: error.message });
    }
    const calls = data ?? [];
    return res.json({ calls, stats: summarizeVoiceCallStats(calls) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "voice calls fetch failed" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL — Voice AI configuration (read + edit forwarding number, greeting, on/off)
// ─────────────────────────────────────────────────────────────────────────────

// Shared validator for the editable voice config fields.
export function validateVoiceConfigInput(body = {}) {
  const errors = [];
  const values = {};
  if (body.forwarding_number !== undefined) {
    const n = String(body.forwarding_number || "").trim();
    if (n && !isE164(n)) errors.push("Forwarding number must be in E.164 format, e.g. +17202892483");
    values.forwarding_number = n || null;
  }
  if (body.ai_enabled !== undefined) values.ai_enabled = !!body.ai_enabled;
  if (body.welcome_prompt !== undefined) {
    values.welcome_prompt = String(body.welcome_prompt || "").trim().slice(0, 600) || null;
  }
  if (body.name !== undefined) values.name = String(body.name || "").trim().slice(0, 80) || "Receptionist";
  return { errors, values };
}

// GET /portal/api/voice/config — the client's voice number(s) + agent settings.
export async function handlePortalVoiceConfig(req, res, supabase, resolvePortalClientId) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });
  try {
    const [numbers, agent] = await Promise.all([
      supabase.from("voice_numbers").select("*").eq("client_id", clientId).order("created_at", { ascending: true }),
      getVoiceAgent(supabase, clientId),
    ]);
    if (numbers.error && numbers.error.message?.includes("does not exist")) {
      return res.json({ numbers: [], agent: null, configured: false });
    }
    return res.json({ numbers: numbers.data ?? [], agent: agent ?? null, configured: !!(numbers.data?.length) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "voice config fetch failed" });
  }
}

// PATCH /portal/api/voice/config — update forwarding number / greeting / on-off.
// Writes to the client's voice_agents row (creates it if missing) and mirrors the
// forwarding number onto every voice_numbers row for the client.
export async function handlePortalUpdateVoiceConfig(req, res, supabase, resolvePortalClientId) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (req.portalUser?.role === "client_user") return res.status(403).json({ error: "Read-only access" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const { errors, values } = validateVoiceConfigInput(req.body ?? {});
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  if (!Object.keys(values).length) return res.status(400).json({ error: "No changes provided" });

  try {
    // Upsert the agent row (one per client).
    const existing = await getVoiceAgent(supabase, clientId);
    let agent;
    if (existing) {
      const { data, error } = await supabase
        .from("voice_agents").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", existing.id).select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      agent = data;
    } else {
      const { data, error } = await supabase
        .from("voice_agents").insert({ client_id: clientId, ...values }).select().maybeSingle();
      if (error) {
        if (error.message?.includes("does not exist")) return res.status(503).json({ error: "Run db1_voice.sql migration first" });
        return res.status(500).json({ error: error.message });
      }
      agent = data;
    }

    // Mirror the forwarding number onto the client's voice number(s) too.
    if (values.forwarding_number !== undefined) {
      await supabase.from("voice_numbers")
        .update({ forwarding_number: values.forwarding_number, updated_at: new Date().toISOString() })
        .eq("client_id", clientId);
    }
    return res.json({ agent });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "voice config update failed" });
  }
}
