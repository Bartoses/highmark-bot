// ─────────────────────────────────────────────────────────────────────────────
// LIVE TRUTH RESOLVER — Phase 1
//
// Detects availability-sensitive requests and resolves a normalized truth object
// from live or recently-cached data. The bot uses this to ground its response —
// unavailable offerings are not pitched, unknown availability is not fabricated.
//
// Returns null when no lookup is needed (non-sensitive request or non-FH client).
// Never throws — always returns null on unrecoverable error.
//
// Truth object shape:
// {
//   domain:               'booking' | 'unknown'
//   status:               'available' | 'unavailable' | 'limited' | 'out_of_season' | 'unknown'
//   reason:               'no_future_slots' | 'sold_out' | 'out_of_season' | 'integration_error' | null
//   confidence:           'high' | 'medium' | 'low'
//   checkedRange:         { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
//   matchingEntities:     [{ name, openDays, nextOpen }]  — items with slots
//   summary:              string — human-readable grounding note for system prompt
//   recommendedNextAction:'book' | 'view_options' | 'handoff' | 'check_back_later' | 'unknown'
// }
//
// Phase 1 supports: FareHarbor (cached availability data from knowledge_base table)
// Phase 2+: appointment systems, inventory APIs, custom integrations
// ─────────────────────────────────────────────────────────────────────────────

// Broad set of phrases that indicate the guest is asking about current availability,
// bookability, or operational status — not just general questions.
const AVAILABILITY_TRIGGERS = [
  /\bavailab\w*/i,                                                   // available, availability
  /\b(book|reserve|reservations?|booking|appoint\w*|schedule)\b/i,  // booking intent
  /\b(slot|opening|spot|seat|capacity|space)\b/i,                    // slot language
  /\b(can i|are you|do you|is there|are there).{0,40}(come|visit|open|ride|tour|sign up|get in)\b/i,
  /\b(running|operating|offering|taking (reservations?|bookings?))\b/i,
  /\b(open (for|now|today|this)|still open|still running)\b/i,
  /\b(when can|how soon|any (open|available|slots|openings|times?))\b/i,
  /\b(do you have|got (any|room|space|openings?))\b/i,
  /\binventor\w*/i,                                                  // inventory
];

/**
 * Returns true if the message contains availability-sensitive language.
 * Exported for testing.
 */
export function isAvailabilitySensitive(message) {
  if (!message) return false;
  return AVAILABILITY_TRIGGERS.some((p) => p.test(message));
}

/**
 * Primary export. Resolves live truth for availability-sensitive messages.
 *
 * @param {string}  message  — raw guest message
 * @param {object}  client   — runtime client config
 * @param {object}  supabase — DB1 client
 * @returns {object|null}    — truth object or null (no lookup needed)
 */
export async function resolveLiveTruth(message, client, supabase) {
  if (!client || !supabase) return null;
  if (!isAvailabilitySensitive(message)) return null;

  // Phase 1: FareHarbor clients with live KB data
  if (client.fareharborEnabled && client.fareharborCompanies?.length) {
    return resolveFhTruth(client, supabase);
  }

  // Other clients: no live truth available in Phase 1
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR TRUTH RESOLVER
// Reads cached availability data from the knowledge_base table.
// Availability data is refreshed every 3 hours — no additional API calls here.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveFhTruth(client, supabase) {
  try {
    const keys = client.fareharborCompanies.map((c) => `${c.id}_fareharbor`);
    const { data: rows, error } = await supabase
      .from("knowledge_base")
      .select("key, data, fetched_at")
      .in("key", keys);

    if (error || !rows?.length) {
      return buildTruth("unknown", "integration_error", "low", [], null);
    }

    // Aggregate availability counts across all companies and items
    let totalChecked = 0;
    let openCount    = 0;
    const entities   = [];

    for (const row of rows) {
      const avail = row.data?.availabilityData ?? {};
      for (const [name, info] of Object.entries(avail)) {
        totalChecked++;
        if ((info.open_days ?? 0) > 0) {
          openCount++;
          entities.push({ name, openDays: info.open_days, nextOpen: info.next_open ?? null });
        }
      }
    }

    if (totalChecked === 0) {
      // KB row exists but availabilityData is empty — cron hasn't run or items missing
      return buildTruth("unknown", "integration_error", "low", [], rows[0]?.fetched_at);
    }

    const status = openCount === 0 ? "unavailable"
      : openCount < totalChecked ? "limited"
      : "available";
    const reason     = status === "unavailable" ? "no_future_slots" : null;
    const confidence = isDataFresh(rows) ? "high" : "medium";

    return buildTruth(status, reason, confidence, entities, rows[0]?.fetched_at);

  } catch (err) {
    console.error("[TRUTH] FH resolve error:", err.message);
    return buildTruth("unknown", "integration_error", "low", [], null);
  }
}

// Data is considered fresh if refreshed within the last 4 hours
function isDataFresh(rows) {
  const now = Date.now();
  return rows.every((r) => {
    if (!r.fetched_at) return false;
    return (now - new Date(r.fetched_at).getTime()) < 4 * 60 * 60 * 1000;
  });
}

function buildTruth(status, reason, confidence, entities, fetchedAt) {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endDate  = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

  // Build grounding summary for system prompt injection
  const summaryParts = [];
  if (status === "available") {
    const count = entities.length;
    const next  = entities[0]?.nextOpen
      ? new Date(entities[0].nextOpen).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    summaryParts.push(`${count} offering(s) have open slots in the next 15 days`);
    if (next) summaryParts.push(`earliest availability ${next}`);
  } else if (status === "limited") {
    const openNames  = entities.map((e) => e.name).slice(0, 2).join(", ");
    summaryParts.push(`some offerings have availability (${openNames})`);
    summaryParts.push(`not all options are open — show specific available items only`);
  } else if (status === "unavailable") {
    summaryParts.push("LIVE DATA: no open booking slots found in the next 15 days");
    summaryParts.push("do NOT suggest booking is possible — offer waitlist or handoff instead");
  } else {
    // unknown
    summaryParts.push("live availability data could not be confirmed");
    summaryParts.push("do NOT invent or assume specific slot availability");
  }

  return {
    domain:    "booking",
    status,
    reason,
    confidence: fetchedAt ? confidence : "low",
    checkedRange: {
      start: tomorrow.toISOString().slice(0, 10),
      end:   endDate.toISOString().slice(0, 10),
    },
    matchingEntities:     entities,
    summary:              summaryParts.join("; "),
    recommendedNextAction: status === "available"   ? "book"
      : status === "limited"    ? "view_options"
      : status === "unavailable" ? "handoff"
      : "unknown",
  };
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
