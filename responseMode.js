// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE MODE SELECTOR — Phase 3
//
// Determines the appropriate response strategy before calling the LLM.
// The mode is selected deterministically from: intent, sentiment, live truth,
// buying signals, conversation state, and client config.
//
// The resulting mode instruction is injected into the Claude system prompt
// as a RESPONSE STRATEGY block — a high-priority directive that shapes
// what the model should focus on, not just what to say.
//
// Adding a new mode:
//   1. Add a key to RESPONSE_MODES
//   2. Add selection logic in selectResponseMode()
//   3. Add instruction text in buildResponseModeInstruction()
// ─────────────────────────────────────────────────────────────────────────────

export const RESPONSE_MODES = {
  OPENER:               "opener",
  ANSWER:               "answer",
  RECOMMEND:            "recommend",
  EXPLAIN_UNAVAILABLE:  "explain_unavailable",
  OFFER_ALTERNATIVE:    "offer_alternative",
  ROUTE_TO_BOOKING:     "route_to_booking",
  ROUTE_TO_APPOINTMENT: "route_to_appointment",
  ROUTE_TO_HANDOFF:     "route_to_handoff",
  LEAD_CAPTURE:         "lead_capture",
  CLARIFICATION:        "clarification",
};

/**
 * Select the appropriate response mode based on current conversation context.
 * Runs deterministically before Claude is called.
 *
 * @param {object} params
 * @param {string}  params.intent        — detected intent (booking, handoff, recommendation, info, etc.)
 * @param {string}  params.sentiment     — detected sentiment (positive, frustrated, neutral)
 * @param {object}  params.truth         — live truth object from adapter (or null)
 * @param {object}  params.buyingSignals — { strength, signals, inferredGoal }
 * @param {object}  params.convo         — current conversation state
 * @param {object}  params.client        — runtime client config
 * @returns {string} One of RESPONSE_MODES
 */
export function selectResponseMode({ intent, sentiment, truth, buyingSignals, convo, client }) {
  const mode = client?.bookingMode ?? "informational";

  // ── Handoff (highest priority) ───────────────────────────────────────────
  if (intent === "handoff") return RESPONSE_MODES.ROUTE_TO_HANDOFF;
  if ((convo?.consecutiveFrustrated ?? 0) >= 2) return RESPONSE_MODES.ROUTE_TO_HANDOFF;

  // ── Live truth routing ───────────────────────────────────────────────────
  if (truth) {
    if (truth.status === "unavailable") {
      // Route to alternative offering if configured; otherwise explain unavailability
      if (client?.alternativeOfferings?.length) return RESPONSE_MODES.OFFER_ALTERNATIVE;
      return RESPONSE_MODES.EXPLAIN_UNAVAILABLE;
    }
    if (truth.status === "unknown") {
      // Cannot confirm — ask for more info rather than fabricating
      return RESPONSE_MODES.CLARIFICATION;
    }
    if ((truth.status === "available" || truth.status === "limited") && intent === "booking") {
      if (mode === "informational" || mode === "lead_capture") return RESPONSE_MODES.LEAD_CAPTURE;
      if (mode === "call_only")   return RESPONSE_MODES.ROUTE_TO_HANDOFF;
      return RESPONSE_MODES.ROUTE_TO_BOOKING;
    }
  }

  // ── Intent-driven modes ──────────────────────────────────────────────────
  if (intent === "recommendation") return RESPONSE_MODES.RECOMMEND;

  if (intent === "booking") {
    if (mode === "informational" || mode === "lead_capture") return RESPONSE_MODES.LEAD_CAPTURE;
    if (mode === "call_only")  return RESPONSE_MODES.ROUTE_TO_HANDOFF;
    if (mode === "static_links" || mode === "hybrid") return RESPONSE_MODES.ROUTE_TO_BOOKING;
    return RESPONSE_MODES.ROUTE_TO_BOOKING;
  }

  // ── Buying signal escalation ─────────────────────────────────────────────
  if (buyingSignals?.strength === "high") return RESPONSE_MODES.RECOMMEND;

  // ── Default ──────────────────────────────────────────────────────────────
  return RESPONSE_MODES.ANSWER;
}

/**
 * Build a mode-specific instruction string for injection before Claude's generation.
 * Complements buildTruthInstruction and buildResponsePlan outputs.
 *
 * @param {string}  mode   — one of RESPONSE_MODES
 * @param {object}  client — runtime client config
 * @param {object}  truth  — live truth object (or null)
 * @returns {string} Instruction text or empty string
 */
export function buildResponseModeInstruction(mode, client, truth) {
  const alternatives = (client?.alternativeOfferings ?? []).slice(0, 3);
  const handoffPhone = client?.handoffPhone || client?.supportPhone || null;

  switch (mode) {
    case RESPONSE_MODES.OFFER_ALTERNATIVE: {
      if (!alternatives.length) return "";
      const altList = alternatives
        .map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}`)
        .join("; ");
      return `\n\nRESPONSE STRATEGY [offer_alternative]: The primary offering is currently unavailable. Pivot naturally to these alternatives: ${altList}. Be warm — frame them as great options, not a fallback. Do not dwell on what's unavailable.`;
    }

    case RESPONSE_MODES.EXPLAIN_UNAVAILABLE:
      return `\n\nRESPONSE STRATEGY [explain_unavailable]: This offering is not available right now. Be honest and clear — do NOT invent or imply availability. Acknowledge warmly, then offer the best next action: waitlist, callback, a future date, or direct contact. Do not leave the guest without a path forward.`;

    case RESPONSE_MODES.RECOMMEND:
      return `\n\nRESPONSE STRATEGY [recommend]: Guest wants a recommendation. Lead with a decisive pick based on what they've shared. One or two focused suggestions beat a full menu. End with a clear next step (book this, call us, etc.).`;

    case RESPONSE_MODES.ROUTE_TO_BOOKING:
      return `\n\nRESPONSE STRATEGY [route_to_booking]: Guest is ready to move forward. Prioritize getting them to the booking step. Surface the booking link or action clearly. Don't over-explain — they're sold, help them complete.`;

    case RESPONSE_MODES.ROUTE_TO_APPOINTMENT:
      return `\n\nRESPONSE STRATEGY [route_to_appointment]: Guest wants to book an appointment. Guide them to the scheduling step directly. Confirm what they need, then route to the booking method (link, call, form) — whichever is configured.`;

    case RESPONSE_MODES.ROUTE_TO_HANDOFF: {
      const ctaPhone = handoffPhone ? ` Call us: ${handoffPhone}` : "";
      return `\n\nRESPONSE STRATEGY [route_to_handoff]: This guest needs a human.${ctaPhone} Route them to the team warmly and directly — make it easy to reach a real person. Don't make them feel like a burden.`;
    }

    case RESPONSE_MODES.LEAD_CAPTURE:
      return `\n\nRESPONSE STRATEGY [lead_capture]: Guest is interested in booking. Gather the key details you need (what they want, when, group size) and let them know someone will follow up. Do not promise instant confirmation — this business uses a lead flow, not direct booking.`;

    case RESPONSE_MODES.CLARIFICATION:
      return `\n\nRESPONSE STRATEGY [clarification]: You cannot confirm availability. Ask one specific clarifying question to get the context you need (date, group size, service type). Do not invent or assume open slots.`;

    case RESPONSE_MODES.ANSWER:
    default:
      return ""; // No special instruction needed — Claude's default behavior is sufficient
  }
}
