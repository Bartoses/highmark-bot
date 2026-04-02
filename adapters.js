// ─────────────────────────────────────────────────────────────────────────────
// PLUGGABLE LIVE-TRUTH ADAPTER MODEL — Phase 3
//
// Each adapter implements a consistent interface:
//   name                 {string}   — adapter identifier
//   isAvailabilitySensitive(msg)    — should this adapter run for this message?
//   resolveLiveStatus({ client, message, supabase })
//                        {Promise<truth|null>} — normalized truth object or null
//
// Truth object shape:
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
// Adding a new adapter:
//   1. Create a new object with name, isAvailabilitySensitive, resolveLiveStatus
//   2. Add it to ADAPTER_MAP below
//   3. Set client.adapterType or extend getAdapter() routing logic
// ─────────────────────────────────────────────────────────────────────────────

// Broad set of phrases that indicate the guest is asking about availability,
// bookability, or operational status. Shared across adapters.
export const AVAILABILITY_TRIGGERS = [
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

const HOURS_TRIGGERS = [
  /\b(open|closed|close|closing|hours|when.+open|are you open|closing time|close at|what time)\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Data is considered fresh if refreshed within the last 4 hours
function isDataFresh(rows) {
  const now = Date.now();
  return rows.every((r) => {
    if (!r.fetched_at) return false;
    return (now - new Date(r.fetched_at).getTime()) < 4 * 60 * 60 * 1000;
  });
}

export function buildTruth(status, reason, confidence, entities, fetchedAt, domain = "booking") {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endDate  = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

  const summaryParts = [];
  if (status === "available") {
    const count = entities.length;
    const next  = entities[0]?.nextOpen
      ? new Date(entities[0].nextOpen).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    summaryParts.push(`${count} offering(s) have open slots in the next 15 days`);
    if (next) summaryParts.push(`earliest availability ${next}`);
  } else if (status === "limited") {
    const openNames = entities.map((e) => e.name).slice(0, 2).join(", ");
    summaryParts.push(`some offerings have availability (${openNames})`);
    summaryParts.push(`not all options are open — show specific available items only`);
  } else if (status === "unavailable") {
    summaryParts.push("LIVE DATA: no open booking slots found in the next 15 days");
    summaryParts.push("do NOT suggest booking is possible — offer waitlist or handoff instead");
  } else {
    summaryParts.push("live availability data could not be confirmed");
    summaryParts.push("do NOT invent or assume specific slot availability");
  }

  return {
    domain,
    status,
    reason,
    confidence: fetchedAt ? confidence : "low",
    checkedRange: {
      start: tomorrow.toISOString().slice(0, 10),
      end:   endDate.toISOString().slice(0, 10),
    },
    matchingEntities:      entities,
    summary:               summaryParts.join("; "),
    recommendedNextAction: status === "available"    ? "book"
      : status === "limited"     ? "view_options"
      : status === "unavailable" ? "handoff"
      : "unknown",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR ADAPTER
// Reads cached availability data from the knowledge_base table.
// Refreshed every 3 hours by knowledgeBase.js — no additional API calls here.
// ─────────────────────────────────────────────────────────────────────────────
export const FareHarborAdapter = {
  name: "fareharbor",

  isAvailabilitySensitive(message) {
    if (!message) return false;
    return AVAILABILITY_TRIGGERS.some((p) => p.test(message));
  },

  async resolveLiveStatus({ client, supabase }) {
    try {
      const keys = client.fareharborCompanies.map((c) => `${c.id}_fareharbor`);
      const { data: rows, error } = await supabase
        .from("knowledge_base")
        .select("key, data, fetched_at")
        .in("key", keys);

      if (error || !rows?.length) {
        return buildTruth("unknown", "integration_error", "low", [], null);
      }

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
        return buildTruth("unknown", "integration_error", "low", [], rows[0]?.fetched_at);
      }

      const status     = openCount === 0   ? "unavailable"
                       : openCount < totalChecked ? "limited"
                       : "available";
      const reason     = status === "unavailable" ? "no_future_slots" : null;
      const confidence = isDataFresh(rows) ? "high" : "medium";

      return buildTruth(status, reason, confidence, entities, rows[0]?.fetched_at);

    } catch (err) {
      console.error("[ADAPTER:FH] Resolve error:", err.message);
      return buildTruth("unknown", "integration_error", "low", [], null);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC ADAPTER
// For clients with no live integration: call_only, static_links, hybrid,
// informational, lead_capture. Never availability-sensitive — KB context and
// client config are the only source of truth.
// ─────────────────────────────────────────────────────────────────────────────
export const StaticAdapter = {
  name: "static",
  isAvailabilitySensitive() { return false; },
  async resolveLiveStatus()  { return null;  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HOURS ADAPTER (stub)
// For hours-based businesses (restaurants, retail, service shops).
// Detects open/closed questions. Returns null for now (falls through to
// Claude with KB hours context). Full implementation when hours clients onboard.
// ─────────────────────────────────────────────────────────────────────────────
export const HoursAdapter = {
  name: "hours",

  isAvailabilitySensitive(message) {
    if (!message) return false;
    return HOURS_TRIGGERS.some((p) => p.test(message));
  },

  async resolveLiveStatus() {
    // Stub: let Claude answer from KB hours context
    // Future: compare client.hours against current timezone-aware time → return open/closed truth
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const ADAPTER_MAP = {
  fareharbor:       FareHarborAdapter,
  api_live_booking: FareHarborAdapter, // normalized alias
  hours:            HoursAdapter,
};

/**
 * Select the appropriate adapter for a given client.
 * Falls back to StaticAdapter safely — never throws.
 *
 * @param {object} client — runtime client config
 * @returns {object}      — adapter instance
 */
export function getAdapter(client) {
  // Explicit adapter type override
  if (client?.adapterType && ADAPTER_MAP[client.adapterType]) {
    return ADAPTER_MAP[client.adapterType];
  }
  // FareHarbor: fareharborEnabled + at least one company configured.
  // bookingMode check is additive — accepts "fareharbor", "api_live_booking",
  // or no bookingMode (backward compat with legacy config that predates bookingMode).
  if (
    client?.fareharborEnabled &&
    client.fareharborCompanies?.length &&
    (client.bookingMode === "fareharbor" || client.bookingMode === "api_live_booking" || !client.bookingMode)
  ) {
    return FareHarborAdapter;
  }
  // Hours-based businesses
  if (client?.bookingMode === "hours" && client.hours) {
    return HoursAdapter;
  }
  // All other modes: static (no live lookup needed)
  return StaticAdapter;
}
