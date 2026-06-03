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
  enabled:            true,
};

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
export async function claimCall(supabase, { callSid, clientId, from, to, direction = "inbound" }) {
  if (!supabase || !callSid) return null;
  const row = {
    call_sid:      callSid,
    client_id:     clientId ?? "unknown",
    caller_number: from ?? null,
    to_number:     to ?? null,
    direction,
    status:        "in_progress",
  };
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
// deps: { resolveClient, resolveClientById, supabase, baseUrl }
//   baseUrl — absolute origin for Twilio callbacks (PUBLIC_BASE_URL or reconstructed)
// ─────────────────────────────────────────────────────────────────────────────

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

// POST /voice/status — Twilio status / Dial-action / voicemail-action callback.
export async function handleVoiceStatus(req, res, deps = {}) {
  const { supabase } = deps;
  const callSid = req.body?.CallSid;
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
