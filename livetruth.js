// ─────────────────────────────────────────────────────────────────────────────
// LIVE TRUTH RESOLVER — Phase 3
//
// Thin routing layer — delegates to the pluggable adapter registry in adapters.js.
// Each adapter handles its own sensitivity detection and live status resolution.
//
// Returns null when no lookup is needed (non-sensitive request or no adapter matched).
// Never throws — always returns null on unrecoverable error.
//
// Truth object shape (defined and built in adapters.js):
// {
//   domain:               'booking' | 'hours' | 'inventory' | 'unknown'
//   status:               'available' | 'unavailable' | 'limited' | 'out_of_season' | 'unknown'
//   reason:               'no_future_slots' | 'sold_out' | 'out_of_season' | 'closed' | 'integration_error' | null
//   confidence:           'high' | 'medium' | 'low'
//   checkedRange:         { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
//   matchingEntities:     [{ name, openDays, nextOpen }]
//   summary:              string — grounding note for system prompt
//   recommendedNextAction:'book' | 'view_options' | 'handoff' | 'check_back_later' | 'unknown'
// }
//
// Phase 3: adapter-driven (FareHarbor, Static, Hours)
// Future: appointment systems, inventory APIs, custom integrations via adapter registry
// ─────────────────────────────────────────────────────────────────────────────

import { getAdapter, AVAILABILITY_TRIGGERS } from "./adapters.js";

/**
 * Returns true if the message contains availability-sensitive language.
 * Exported for backward compatibility with tests and calling code.
 * Uses the shared AVAILABILITY_TRIGGERS from adapters.js.
 */
export function isAvailabilitySensitive(message) {
  if (!message) return false;
  return AVAILABILITY_TRIGGERS.some((p) => p.test(message));
}

/**
 * Primary export. Resolves live truth for the current message using the
 * adapter selected for this client. Returns null when no lookup is needed.
 *
 * @param {string}  message  — raw guest message
 * @param {object}  client   — runtime client config
 * @param {object}  supabase — DB1 client
 * @returns {object|null}    — truth object or null
 */
export async function resolveLiveTruth(message, client, supabase) {
  if (!client || !supabase) return null;
  const adapter = getAdapter(client);
  if (!adapter.isAvailabilitySensitive(message)) return null;
  return adapter.resolveLiveStatus({ client, message, supabase });
}

/**
 * Build a system-prompt instruction string from a truth object.
 * Injected into the DEFAULT Claude block as a high-priority constraint.
 * Returns empty string when truth is null or status is available (KB context sufficient).
 */
export function buildTruthInstruction(truth) {
  if (!truth) return "";
  if (truth.status === "available") return ""; // KB summary is sufficient
  if (truth.status === "limited") {
    const openNames = truth.matchingEntities.map((e) => e.name).join(", ");
    return `\n\nLIVE AVAILABILITY CHECK: Only ${truth.matchingEntities.length} offering(s) currently have open slots (${openNames || "see KB for details"}). Only recommend options that show as available. Do not pitch offerings with no open slots.`;
  }
  if (truth.status === "unavailable") {
    return `\n\nLIVE AVAILABILITY CHECK (HIGH CONFIDENCE): There are NO open booking slots in the next 15 days. Do NOT suggest the guest can book — that would be false. Acknowledge current unavailability honestly. ${truth.reason === "no_future_slots" ? "Offer the waitlist or to have the team follow up." : "Suggest they check back or contact the team."}`;
  }
  if (truth.status === "unknown") {
    return `\n\nLIVE AVAILABILITY CHECK: Real-time availability data could not be confirmed. Do NOT state or imply specific slots are open. If availability comes up, say you cannot confirm current openings and offer to have someone follow up.`;
  }
  return "";
}
