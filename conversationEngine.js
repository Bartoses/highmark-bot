// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION ENGINE — Config-driven conversation structure (Chunk 16)
//
// Provides structured, guided conversation behavior driven entirely by
// per-client configuration. All features are OFF by default — no existing
// client is affected until enable_guided_flow is toggled on.
//
// Exports:
//   getConversationConfig(client)              — merged settings + defaults
//   buildMainMenu(client)                      — numbered SMS menu string
//   routeMenuSelection(body, client)           — "1" / "booking" → key or null
//   buildConversationInstruction(intent, client) — next-step block for Claude
//
// conversation_settings shape (stored as JSONB in clients.conversation_settings):
// {
//   enable_guided_flow:      boolean  — master switch for all guided features
//   show_main_menu_on_start: boolean  — append menu to first-message opener
//   main_menu_options:       [{ label, key }]  — menu items (max 8)
//   enable_recommendations:  boolean  — allow suggestion-style responses
//   enable_smart_followups:  boolean  — append next-step suggestion to responses
//   enable_lead_prompts:     boolean  — allow proactive lead capture from config triggers
//   lead_capture_triggers:   string[] — intent keys that trigger lead prompt
//   max_options_per_message: int      — max menu items shown (default 4)
// }
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MENU_OPTIONS = [
  { label: "Book / availability", key: "booking"         },
  { label: "Pricing",             key: "pricing"         },
  { label: "Conditions",          key: "conditions"      },
  { label: "Recommendations",     key: "recommendations" },
  { label: "Talk to someone",     key: "handoff"         },
];

export const DEFAULT_CONVERSATION_CONFIG = {
  enable_guided_flow:      false,
  show_main_menu_on_start: false,
  main_menu_options:       DEFAULT_MENU_OPTIONS,
  enable_recommendations:  true,
  enable_smart_followups:  true,
  enable_lead_prompts:     true,
  lead_capture_triggers:   ["pricing", "availability", "recommendation"],
  max_options_per_message: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// getConversationConfig
// Returns the client's conversation settings merged with safe defaults.
// Safe to call with any client object, even one without conversationSettings.
// ─────────────────────────────────────────────────────────────────────────────
export function getConversationConfig(client) {
  const stored = client?.conversationSettings ?? {};
  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...stored,
    // Deep-merge menu: use stored list if non-empty, else fall back to defaults
    main_menu_options: stored.main_menu_options?.length
      ? stored.main_menu_options
      : DEFAULT_MENU_OPTIONS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildMainMenu
// Returns a numbered, SMS-friendly menu string from the client's config.
// Returns empty string if guided flow is disabled.
//
// Example output:
//   "1. Book / availability
//    2. Pricing
//    3. Conditions
//    4. Talk to someone"
// ─────────────────────────────────────────────────────────────────────────────
export function buildMainMenu(client) {
  const config  = getConversationConfig(client);
  if (!config.enable_guided_flow) return "";

  const maxItems = Math.min(config.max_options_per_message ?? 4, 8);
  const options  = config.main_menu_options.slice(0, maxItems);
  return options.map((opt, i) => `${i + 1}. ${opt.label}`).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// routeMenuSelection
// Maps a guest reply to a menu option key.
//
// Checks (in order):
//   1. Numeric: "1", "2" → option at that 1-based index
//   2. Exact key: "booking", "pricing" → matched key
//   3. Partial label: "book" → first option whose label includes that word
//
// Returns the key string (e.g. "booking") or null if no match.
// Returns null immediately if enable_guided_flow is off.
// ─────────────────────────────────────────────────────────────────────────────
export function routeMenuSelection(body, client) {
  if (!body) return null;
  const config = getConversationConfig(client);
  if (!config.enable_guided_flow) return null;

  const options = config.main_menu_options;
  const trimmed = body.trim().toLowerCase();

  // Numeric selection
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1]?.key ?? null;
  }

  // Exact key match
  const exactKey = options.find((o) => o.key === trimmed);
  if (exactKey) return exactKey.key;

  // Partial label match (minimum 3 chars to avoid false positives)
  if (trimmed.length >= 3) {
    const labelMatch = options.find((o) => o.label.toLowerCase().includes(trimmed));
    if (labelMatch) return labelMatch.key;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildConversationInstruction
// Returns a system-prompt block instructing Claude to weave in next-step
// suggestions at the end of its response.
//
// Returns empty string when:
//   - enable_guided_flow is false
//   - enable_smart_followups is false
//   - no matching next steps found for the current intent
// ─────────────────────────────────────────────────────────────────────────────
const NEXT_STEP_MAP = {
  booking:         ["pricing", "recommendations"],
  pricing:         ["booking", "recommendations"],
  conditions:      ["booking", "pricing"],
  recommendations: ["booking", "pricing"],
  availability:    ["booking", "recommendations"],
  general:         ["booking", "conditions"],
  smalltalk:       ["booking", "pricing"],
  lookup:          ["booking", "handoff"],
};

export function buildConversationInstruction(intent, client) {
  const config = getConversationConfig(client);
  if (!config.enable_guided_flow || !config.enable_smart_followups) return "";

  const nextKeys  = NEXT_STEP_MAP[intent] ?? NEXT_STEP_MAP.general;
  const menuOpts  = config.main_menu_options;
  const nextSteps = nextKeys
    .map((k) => menuOpts.find((o) => o.key === k))
    .filter(Boolean)
    .slice(0, 2)
    .map((o) => `• ${o.label}`);

  if (!nextSteps.length) return "";

  return `\n\nAFTER YOUR ANSWER: naturally offer 1–2 next steps in a single conversational sentence. Draw from:\n${nextSteps.join("\n")}\nDon't list them robotically — weave them in. Keep it to one brief sentence.`;
}
