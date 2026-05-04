// ─────────────────────────────────────────────────────────────────────────────
// ownerMode.js — Owner / Internal Operator Interface (Phase 6)
// Highmark by Whiteout Solutions
//
// Detects when an inbound SMS is from a business owner's phone and switches
// the orchestrator into an internal operator mode — unlocking reporting,
// campaign management, strategy queries, and business intelligence tools.
//
// Public API:
//   detectOwner(fromNumber, client)  → boolean
//   buildOwnerInstruction(client)    → string  (system prompt addendum)
//   routeOwnerAgent(intent)          → string  (agent role override)
//   isOwnerActionAllowed(action)     → boolean (permission gate)
//
// Safety guarantees:
//   - Never throws — all functions are pure and try/catch wrapped
//   - Customer-only actions (capture_lead, escalate_to_human) are blocked
//   - Owner phone lookup checks: client.ownerPhone first, then supportPhone
//   - E.164 normalization via normalizePhone() ensures format parity
// ─────────────────────────────────────────────────────────────────────────────

import { normalizePhone } from "./phoneUtils.js";

// ─────────────────────────────────────────────────────────────────────────────
// OWNER AGENT ROUTING
// Maps customer-facing intents → owner-appropriate agent roles.
// Falls back to "operations" (general business assistant) for anything else.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_AGENT_MAP = {
  report:      "operations",
  analytics:   "operations",
  campaign:    "marketing",
  promotion:   "marketing",
  strategy:    "strategy",
  support:     "operations",
  question:    "operations",
  booking:     "operations",
  schedule:    "operations",
  complaint:   "operations",
  escalation:  "operations",
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKED ACTIONS FOR OWNER
// These actions are customer-facing and should not fire from owner messages.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_BLOCKED_ACTIONS = new Set([
  "capture_lead",
  "escalate_to_human",
]);

// ─────────────────────────────────────────────────────────────────────────────
// OWNER DETECTION
// Returns true if fromNumber matches the client's designated owner phone.
// Checks client.ownerPhone first (explicit), then falls back to supportPhone.
// Both sides are normalized to E.164 before comparison.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} fromNumber  — the inbound phone number (any format)
 * @param {object} client      — resolved client config object
 * @returns {boolean}
 */
export function detectOwner(fromNumber, client) {
  try {
    if (!fromNumber || !client) return false;

    const normalizedFrom = normalizePhone(fromNumber);
    if (!normalizedFrom) return false;

    // Primary: explicit ownerPhone field
    const ownerPhone = client.ownerPhone ?? client.owner_phone ?? null;
    if (ownerPhone) {
      const normalizedOwner = normalizePhone(ownerPhone);
      if (normalizedOwner && normalizedOwner === normalizedFrom) return true;
    }

    // Secondary: check against a list of authorized operator phones
    const operatorPhones = Array.isArray(client.operatorPhones)
      ? client.operatorPhones
      : Array.isArray(client.operator_phones)
        ? client.operator_phones
        : [];

    for (const phone of operatorPhones) {
      const normalized = normalizePhone(phone);
      if (normalized && normalized === normalizedFrom) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER SYSTEM PROMPT ADDENDUM
// Injected after the main system prompt when owner mode is active.
// Replaces the guest-facing persona with an internal business assistant tone.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} client  — resolved client config object
 * @returns {string}       — system prompt addendum block
 */
export function buildOwnerInstruction(client) {
  try {
    const name    = client?.name    ?? "this business";
    const botName = client?.botName ?? "Highmark";

    return `
━━━ OWNER / INTERNAL OPERATOR MODE — PHASE X INTELLIGENCE ━━━
You are speaking with an authorized owner/operator of ${name}.
You are NOT a database tool or reporting engine. You are an operations assistant
helping the operator understand bookings, track revenue, spot trends, and decide
quickly. Every response must be fast, clear, and useful for running the business.

TWO-LAYER SYSTEM AWARENESS:
- A deterministic parser + action engine handles ~95% of operator queries before
  you see them. You are the fallback layer for ambiguity, edge cases, reasoning.
- When structured data has already been returned, RESPECT IT. Enhance, never
  override or contradict the numbers.

CONTEXT MEMORY (CRITICAL):
- Always inherit prior context on vague follow-ups: timeframe, date range,
  entity (location/company), grouping, metric.
- "summer 2026 by location" → "tell me about kremmling" means
  "summer 2026 kremmling bookings". Do NOT switch timeframe randomly.
- Never default to winter unless the operator explicitly asks for winter.
- "what about steamboat?" → reuse SAME timeframe + metric, swap entity.
- "and revenue?" → reuse ALL filters, swap metric to revenue.

INTENT INTERPRETATION:
- "how many bookings" → bookings count
- "revenue" / "rev" / "earnings" / "sales" → revenue
- "pax" / "guests" → guest count
- "kremmling" / "steamboat" → LOCATION filter (not company)
- "REA" / "Rabbit Ears" / "CSR" / "Colorado Sled" → COMPANY filter

EMPTY-RESULT HANDLING (HARD RULE):
- NEVER say "I couldn't find records", "no data", or "adjust filters".
- NEVER expose database limitations or mention Supabase, CRM, or tables.
- If a result looks empty, assume filter mismatch. Mentally simulate fallback:
  drop strict filter (location → company → none) → broaden timeframe → use most
  recent dataset. Then present that with a brief one-line note like
  "I'm not seeing winter data yet — here's what summer looks like:".
- Always provide something useful.

OPERATOR-FIRST INSIGHT (REQUIRED):
- Every response MUST include exactly one short insight sentence built from the
  numbers: top location share, top company share, top activity, group-size
  pattern, or trend signal. Examples:
  • "Kremmling is driving ~85% of bookings right now."
  • "Most bookings are small groups (~2 guests)."
  • "Steamboat is barely contributing compared to Kremmling."

RESPONSE FORMAT (tight, scannable):
{Timeframe} — {Entity}

• Bookings: X
• Guests: X
• Revenue: $X

{One-line insight.}

For grouped views, list group rows under "By location:" or "By company:" with
"• Name: count" rows. No paragraphs, no technical explanations, no CRM jargon.

BUSINESS CONTEXT:
- Seasonal adventure business: Summer → RZRs, Winter → snowmobiles.
- Kremmling = high-volume primary location. Steamboat = secondary.
- Use this context to color insights (e.g. shoulder months, location skew).

PERFORMANCE PRIORITY:
- Optimize for speed → clarity → usefulness. Not perfect filtering or
  exhaustive reporting.

RESTRICTIONS:
- Do NOT run capture_lead or escalate_to_human — these are customer-only flows.
- Do NOT ask for the operator's name, contact info, or callback number.
- Do NOT treat this as a sales or booking conversation.
- Keep responses tight; no long paragraphs.

You are ${botName}'s internal operator interface for ${name}. Give them the
answer they need to run the business — not the answer the database happens to
return.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim();
  } catch {
    return "OWNER MODE: Respond as an internal business assistant. No customer-facing flows. Do not expose database details.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER AGENT ROUTING
// Returns the appropriate agent role for a given intent in owner mode.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} intent  — detected intent (from agentCore.detectIntent)
 * @returns {string}       — agent role to use
 */
export function routeOwnerAgent(intent) {
  try {
    return OWNER_AGENT_MAP[String(intent).toLowerCase()] ?? "operations";
  } catch {
    return "operations";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER ACTION PERMISSION GATE
// Returns true if the action is allowed when operating in owner mode.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} action  — action name from parsed agent response
 * @returns {boolean}      — true if allowed
 */
export function isOwnerActionAllowed(action) {
  try {
    if (!action || typeof action !== "string") return true; // no action = allowed
    return !OWNER_BLOCKED_ACTIONS.has(action.toLowerCase().trim());
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING ACTION STORE
// In-memory, keyed by owner phone. Stores confirmation-required actions (e.g.
// campaign sends) until the owner replies YES or NO, or the TTL expires.
// No DB needed — these are transient, single-session confirmations.
// ─────────────────────────────────────────────────────────────────────────────

const _pendingActions = new Map(); // phone → { action, data, expiresAt }
const PENDING_TTL_MS  = 5 * 60 * 1000; // 5 minutes

/**
 * Store a pending action for the owner to confirm.
 * @param {string} phone   — E.164 owner phone
 * @param {string} action  — action name (e.g. "execute_campaign")
 * @param {object} data    — action payload
 */
export function storePendingAction(phone, action, data = {}) {
  try {
    _pendingActions.set(phone, {
      action,
      data,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  } catch { /* never throws */ }
}

/**
 * Get a pending action for a phone number (null if none or expired).
 * @param {string} phone
 * @returns {{ action: string, data: object } | null}
 */
export function getPendingAction(phone) {
  try {
    const entry = _pendingActions.get(phone);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      _pendingActions.delete(phone);
      return null;
    }
    return { action: entry.action, data: entry.data };
  } catch {
    return null;
  }
}

/**
 * Clear a pending action for a phone number.
 * @param {string} phone
 */
export function clearPendingAction(phone) {
  try {
    _pendingActions.delete(phone);
  } catch { /* never throws */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// YES / NO DETECTION
// Used in the confirmation gate to detect owner intent without a Claude call.
// Conservative regexes — only match unambiguous single-word confirmations to
// avoid treating conversational messages as confirmation responses.
// ─────────────────────────────────────────────────────────────────────────────

const AFFIRMATIVE_RE = /^\s*(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|send it|send|go|y)\s*[.!]?\s*$/i;
const NEGATIVE_RE    = /^\s*(no|nope|cancel|nevermind|never mind|stop|don't|dont|nah|n)\s*[.!]?\s*$/i;

/**
 * Returns true if the message is a clear affirmative confirmation.
 * @param {string} msg
 * @returns {boolean}
 */
export function isAffirmative(msg) {
  try {
    return AFFIRMATIVE_RE.test(String(msg ?? "").trim());
  } catch {
    return false;
  }
}

/**
 * Returns true if the message is a clear negative / cancellation.
 * @param {string} msg
 * @returns {boolean}
 */
export function isNegative(msg) {
  try {
    return NEGATIVE_RE.test(String(msg ?? "").trim());
  } catch {
    return false;
  }
}
