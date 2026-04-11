// ─────────────────────────────────────────────────────────────────────────────
// agentCore.js — Multi-Agent Foundation
// Highmark by Whiteout Solutions
//
// Provides: detectIntent, detectContext, selectAgent, buildSystemPrompt,
//           parseAgentResponse
//
// All functions are pure, safe (try/catch), and never throw.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION
// Maps an incoming message to one of 9 high-level intents used for agent routing.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  {
    intent: "booking",
    patterns: [
      /\b(book|booking|reserve|reservation|sign.?up|get a spot|check availability|how do (i|we) book|want to (ride|go|do|try|book)|can i (book|reserve|get))\b/i,
      /\b(for \d+ (people|person|guests|adults))\b/i,
      /\b(this (weekend|saturday|sunday|friday|thursday|monday|tuesday|wednesday))\b/i,
    ],
  },
  {
    intent: "lead",
    patterns: [
      /\b(interested in|tell me more about|learn more|get (more )?info|send (me )?info|more (information|details))\b/i,
      /\b(contact (me|us)|reach out|get in touch|follow up|follow-up)\b/i,
      /\b(sign me up|add me|put me on|sign up for|notify me|let me know when)\b/i,
    ],
  },
  {
    intent: "complaint",
    patterns: [
      /\b(complaint|complain|refund|cancel|terrible|worst|awful|horrible|disgusting|unacceptable)\b/i,
      /\b(not working|isn.?t working|broken|wrong|incorrect|problem|issue|error|mistake|disappointed|let down)\b/i,
      /\b(upset|angry|frustrated|annoyed|ridiculous|wtf|this (is|was) (bad|awful|terrible))\b/i,
      /\b(never again|waste of (time|money)|rip.?off|too expensive for|poor (service|quality))\b/i,
    ],
  },
  {
    intent: "schedule",
    patterns: [
      /\b(what.?s (on )?(tomorrow|today|this week|next week|the schedule|the lineup|happening))\b/i,
      /\b(next (available|slot|opening|appointment|date))\b/i,
      /\b(on the schedule|schedule|agenda|calendar|when (do|does|is|are|can)|what time|what days|hours|open)\b/i,
      /\b(upcoming)\b/i,
    ],
  },
  {
    intent: "report",
    patterns: [
      /\b(stats|statistics|report|reports|analytics|data|numbers|metrics|performance)\b/i,
      /\b(how (many|much|often)|total|count|breakdown|summary|overview)\b/i,
      /\b(give me (a |the )?(stats|numbers|data|report|summary|overview))\b/i,
      /\b(who (didn.?t|hasn.?t|have.?n.?t) (book|booked|responded|replied))\b/i,
      /\b(missed leads?|leads? (summary|overview|status|pipeline)|follow.?up queue)\b/i,
      /\b(new leads?|recent leads?|lead count|how many leads?|any (new|recent) leads?)\b/i,
    ],
  },
  {
    intent: "promotion",
    patterns: [
      /\b(deal|deals|discount|discounts|promo|promotion|coupon|offer|sale|special)\b/i,
      /\b(any deals|any (discounts?|promos?|specials?|offers?)|running (any|a) (deal|promo|special))\b/i,
      /\b(save|savings|lower (price|rate|cost)|cheaper|best price|price (drop|cut))\b/i,
      /\b(send (a |an )?(campaign|promo|message|text|blast|outreach) (to|out))\b/i,
      /\b(campaign (to|for)|text (all|my) (leads?|contacts?|customers?))\b/i,
      /\b(blast|outreach|reach out to (all|my) leads?)\b/i,
    ],
  },
  {
    intent: "strategy",
    patterns: [
      /\b(how (can|do|should|could) (i|we) (grow|improve|scale|increase|boost|get more))\b/i,
      /\b(strategy|strategies|plan|planning|grow|growth|scale|expand|optimize|improve)\b/i,
      /\b(what should (i|we) (do|focus|work on)|advice|recommend|suggestion|ideas for)\b/i,
      /\b(business (advice|tips|help|question)|marketing (advice|help|ideas|tips))\b/i,
    ],
  },
  {
    intent: "support",
    patterns: [
      /\b(help|support|assist|question|problem|trouble|stuck|confused|don.?t understand|not sure)\b/i,
      /\b(how (do|does|can|do i)|what (is|are|does)|explain|tell me (about|how|what))\b/i,
    ],
  },
];

/**
 * Classify an incoming message into one of 9 high-level agent intents.
 * @param {string} message
 * @returns {"booking"|"lead"|"question"|"support"|"complaint"|"schedule"|"report"|"promotion"|"strategy"}
 */
export function detectIntent(message) {
  try {
    if (!message || typeof message !== "string") return "question";
    const normalized = message.toLowerCase().trim();

    for (const { intent, patterns } of INTENT_PATTERNS) {
      if (patterns.some((re) => re.test(normalized))) return intent;
    }

    return "question";
  } catch (e) {
    console.error("[agentCore] detectIntent error:", e.message);
    return "question";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT EXTRACTION
// Pulls structured fields from natural language.
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAY_MAP = {
  sunday:    0, monday: 1, tuesday: 2, wednesday: 3,
  thursday:  4, friday: 5, saturday: 6,
};

function resolveWeekday(name) {
  const today  = new Date();
  const target = WEEKDAY_MAP[name.toLowerCase()];
  if (target === undefined) return null;
  const diff   = (target - today.getDay() + 7) % 7 || 7; // always next occurrence (0 = same weekday next week)
  const d      = new Date(today);
  d.setDate(today.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function extractDate(t) {
  try {
    const today    = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    if (/\btoday\b/.test(t))    return today.toISOString().slice(0, 10);
    if (/\btomorrow\b/.test(t)) return tomorrow.toISOString().slice(0, 10);

    // Explicit month/day: "June 5", "July 4th", "March 15"
    const months = "january|february|march|april|may|june|july|august|september|october|november|december";
    const mdMatch = t.match(new RegExp(`(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?`, "i"));
    if (mdMatch) {
      const monthIndex = "january february march april may june july august september october november december"
        .split(" ")
        .indexOf(mdMatch[1].toLowerCase());
      if (monthIndex >= 0) {
        const year = today.getFullYear();
        const d    = new Date(year, monthIndex, parseInt(mdMatch[2]));
        if (d < today) d.setFullYear(year + 1);
        return d.toISOString().slice(0, 10);
      }
    }

    // Weekday name
    const weekdays = "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
    const wdMatch  = t.match(new RegExp(`\\b(${weekdays})\\b`, "i"));
    if (wdMatch) return resolveWeekday(wdMatch[1]);

    return null;
  } catch (e) {
    console.error("[agentCore] extractDate error:", e.message);
    return null;
  }
}

function extractGroupSize(t) {
  try {
    const patterns = [
      /(\d+)\s*(?:people|persons?|guests?|adults?|riders?|of\s+us)/i,
      /(?:for|party\s+of|group\s+of)\s+(\d+)/i,
      /(\d+)\s*(?:tickets?|spots?|slots?)/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n <= 100) return n;
      }
    }
    return null;
  } catch (e) {
    console.error("[agentCore] extractGroupSize error:", e.message);
    return null;
  }
}

function extractServiceType(t) {
  try {
    const serviceMap = [
      { keywords: ["snowmobile", "snowmobiling", "sled", "sledding"],         type: "snowmobile" },
      { keywords: ["rzr", "utv"],                                              type: "rzr" },
      { keywords: ["atv", "quad", "four.?wheeler"],                            type: "atv" },
      { keywords: ["tour", "guided tour", "group tour"],                       type: "tour" },
      { keywords: ["rental", "rent"],                                          type: "rental" },
    ];
    for (const { keywords, type } of serviceMap) {
      if (keywords.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(t))) return type;
    }
    return null;
  } catch (e) {
    console.error("[agentCore] extractServiceType error:", e.message);
    return null;
  }
}

function detectUrgency(t) {
  try {
    if (/\b(now|asap|immediately|today|urgent|right away|as soon as possible|right now)\b/i.test(t)) return "high";
    if (/\b(this (weekend|week)|soon|shortly|in the next (day|couple|few))\b/i.test(t))             return "medium";
    return "low";
  } catch (e) {
    console.error("[agentCore] detectUrgency error:", e.message);
    return "low";
  }
}

/**
 * Extract structured context from a message.
 * @param {string} message
 * @returns {{ date: string|null, groupSize: number|null, serviceType: string|null, urgency: "low"|"medium"|"high", returningUser: boolean }}
 */
export function detectContext(message) {
  try {
    if (!message || typeof message !== "string") {
      return { date: null, groupSize: null, serviceType: null, urgency: "low", returningUser: false };
    }
    const t = message.toLowerCase().trim();
    return {
      date:          extractDate(t),
      groupSize:     extractGroupSize(t),
      serviceType:   extractServiceType(t),
      urgency:       detectUrgency(t),
      returningUser: false, // future: DB lookup
    };
  } catch (e) {
    console.error("[agentCore] detectContext error:", e.message);
    return { date: null, groupSize: null, serviceType: null, urgency: "low", returningUser: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT SELECTION
// Maps high-level intents to the agent best suited to handle them.
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_TO_AGENT = {
  booking:   "sales",
  lead:      "crm",
  question:  "support",
  support:   "support",
  complaint: "support",
  schedule:  "operations",
  report:    "operations",
  promotion: "marketing",
  strategy:  "strategy",
};

/**
 * Select the appropriate agent for a given intent.
 * @param {string} intent
 * @returns {"sales"|"support"|"crm"|"operations"|"marketing"|"strategy"}
 */
export function selectAgent(intent) {
  try {
    return INTENT_TO_AGENT[intent] ?? "support";
  } catch (e) {
    console.error("[agentCore] selectAgent error:", e.message);
    return "support";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC PROMPT BUILDER
// Composes a layered system prompt from global config, client profile,
// agent role instructions, and live knowledge context.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a composite system prompt from multiple layers.
 * @param {{ globalPrompt?: string, clientProfile?: object|string, agentPrompt?: string, knowledgeContext?: string }} params
 * @returns {string}
 */
export function buildSystemPrompt({ globalPrompt, clientProfile, agentPrompt, knowledgeContext } = {}) {
  try {
    const sections = [];

    if (globalPrompt && typeof globalPrompt === "string" && globalPrompt.trim()) {
      sections.push(`━━━ GLOBAL PROMPT ━━━\n${globalPrompt.trim()}`);
    }

    if (clientProfile) {
      let profileText;
      if (typeof clientProfile === "string") {
        profileText = clientProfile.trim();
      } else {
        try {
          profileText = JSON.stringify(clientProfile, null, 2);
        } catch {
          profileText = String(clientProfile);
        }
      }
      if (profileText) sections.push(`━━━ CLIENT PROFILE ━━━\n${profileText}`);
    }

    if (agentPrompt && typeof agentPrompt === "string" && agentPrompt.trim()) {
      sections.push(`━━━ AGENT ROLE ━━━\n${agentPrompt.trim()}`);
    }

    if (knowledgeContext && typeof knowledgeContext === "string" && knowledgeContext.trim()) {
      sections.push(`━━━ KNOWLEDGE CONTEXT ━━━\n${knowledgeContext.trim()}`);
    }

    return sections.join("\n\n");
  } catch (e) {
    console.error("[agentCore] buildSystemPrompt error:", e.message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURED RESPONSE PARSING
// Safely parses Claude's structured JSON output. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_PARSED = { agent: null, intent: null, action: null, data: {}, reply: "" };

/**
 * Parse a structured agent response from Claude.
 * @param {string|object} response
 * @returns {{ agent: string|null, intent: string|null, action: string|null, data: object, reply: string }}
 */
export function parseAgentResponse(response) {
  try {
    if (response === null || response === undefined) return { ...EMPTY_PARSED };

    // Already an object — return with safe defaults
    if (typeof response === "object") {
      return {
        agent:  response.agent  ?? null,
        intent: response.intent ?? null,
        action: response.action ?? null,
        data:   (response.data && typeof response.data === "object") ? response.data : {},
        reply:  typeof response.reply === "string" ? response.reply : String(response.reply ?? ""),
      };
    }

    // String — attempt JSON parse
    if (typeof response === "string") {
      const trimmed = response.trim();

      // Strip markdown fences if present
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      const jsonStr = fenced ? fenced[1].trim() : trimmed;

      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === "object") {
          return {
            agent:  parsed.agent  ?? null,
            intent: parsed.intent ?? null,
            action: parsed.action ?? null,
            data:   (parsed.data && typeof parsed.data === "object") ? parsed.data : {},
            reply:  typeof parsed.reply === "string" ? parsed.reply : String(parsed.reply ?? ""),
          };
        }
      } catch {
        // JSON parse failed — treat entire string as plain-text reply
      }

      // Plain-text fallback
      return { ...EMPTY_PARSED, reply: trimmed };
    }

    // Unknown type
    return { ...EMPTY_PARSED };
  } catch (e) {
    console.error("[agentCore] parseAgentResponse error:", e.message);
    return { ...EMPTY_PARSED };
  }
}
