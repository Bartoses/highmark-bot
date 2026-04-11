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
    const name = client?.name ?? "this business";
    const botName = client?.botName ?? "Highmark";

    return `
━━━ OWNER / INTERNAL OPERATOR MODE ━━━
You are now speaking with an authorized business owner or operator of ${name}.
Switch out of guest-facing mode entirely.

BEHAVIOR:
- Address the operator as a peer and business partner, not as a customer.
- Be direct, efficient, and data-focused. Skip pleasantries.
- Provide actionable business intelligence: bookings, leads, campaign stats, revenue insights.
- You may discuss upcoming campaigns, suggest outreach strategies, and summarize operations.
- When asked for a report, structure it clearly: metric, trend, recommendation.
- When asked about campaigns, confirm the audience and content before executing.

CAPABILITIES UNLOCKED:
- Booking summaries and availability snapshots
- Lead pipeline status and follow-up queue review
- Campaign creation and audience selection
- Revenue trend analysis and strategy recommendations
- Operational alerts and issue triage

RESTRICTIONS:
- Do NOT run capture_lead or escalate_to_human — these are customer-only flows.
- Do NOT ask for the operator's name, contact info, or callback number.
- Do NOT treat this as a sales or booking conversation.
- Keep responses under 320 characters unless a report format requires more.

You are ${botName}'s internal operator interface for ${name}. Help them run their business.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim();
  } catch {
    return "OWNER MODE: Respond as an internal business assistant. No customer-facing flows.";
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
