// ─────────────────────────────────────────────────────────────────────────────
// operatorRoles.js — Operator Intelligence 2.0: role model + altitude tiers
//
// Roles drive WHAT each employee sees and in WHAT ORDER. A guide and an owner
// texting the same number get completely different briefings. Pure, no I/O.
//
// Exports:
//   CANONICAL_ROLES, normalizeRole(role)
//   DETAIL_TIERS, normalizeDetail(detail), detailRank(tier)
//   ROLE_PROFILES, getRoleProfile(role)
//   resolveFocusAreas(role, explicitDigestTypes)
//   CARD_FOCUS  (card category → focus area, for gating)
// ─────────────────────────────────────────────────────────────────────────────

// ── Roles ───────────────────────────────────────────────────────────────────
export const CANONICAL_ROLES = [
  "owner", "general_manager", "operations_manager",
  "reservations", "fleet", "mechanic", "guide", "marketing",
];

// Legacy (4-role) → canonical (8-role). Unknown → owner (sees the most; safest).
const LEGACY_ROLE_MAP = {
  owner:   "owner",
  manager: "operations_manager",
  sales:   "reservations",
  staff:   "guide",
};

export function normalizeRole(role) {
  const r = String(role ?? "").toLowerCase().trim();
  if (CANONICAL_ROLES.includes(r)) return r;
  if (LEGACY_ROLE_MAP[r]) return LEGACY_ROLE_MAP[r];
  return "owner";
}

// ── Detail tiers (altitude) ───────────────────────────────────────────────────
// executive < standard < operational < diagnostic (increasing verbosity).
export const DETAIL_TIERS = ["executive", "standard", "operational", "diagnostic"];
const LEGACY_DETAIL_MAP = { summary: "executive", detailed: "operational" };

// Normalize a stored briefing_detail to a canonical tier, or null for "auto".
export function normalizeDetail(detail) {
  const d = String(detail ?? "").toLowerCase().trim();
  if (DETAIL_TIERS.includes(d)) return d;
  if (LEGACY_DETAIL_MAP[d]) return LEGACY_DETAIL_MAP[d];
  return null; // 'auto' / unknown → resolve from role + scope
}

export function detailRank(tier) {
  const i = DETAIL_TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
}

// ── Card focus map ────────────────────────────────────────────────────────────
// Each action-card category belongs to a focus area (a digest_types value), so
// focus-area toggles gate which cards appear.
export const CARD_FOCUS = {
  bookings:     "bookings",
  late_returns: "bookings",
  missing_phone:"bookings",
  vip:          "bookings",
  waivers:      "staffing",
  staffing:     "staffing",
  fleet:        "fleet",
  maintenance:  "maintenance",
  safety:       "safety",
  unpaid:       "revenue",
  revenue:      "revenue",
  pacing:       "revenue",
  underbooked:  "revenue",
  leads:        "leads",
  handoff:      "leads",
  weather:      "weather",
};

// ── Role profiles ─────────────────────────────────────────────────────────────
// defaultDetail — used when briefing_detail = 'auto'.
// focusAreas    — default focus-area set when the phone doesn't override.
// cardOrder     — ordered card categories this role sees (also the menu order).
// priorityWeights — multipliers re-ranking the shared priority score per audience.
export const ROLE_PROFILES = {
  owner: {
    label: "Owner",
    defaultDetail: "executive",
    focusAreas: ["bookings", "revenue", "fleet", "leads", "weather", "safety"],
    cardOrder: ["revenue", "bookings", "fleet", "leads", "weather"],
    priorityWeights: { revenue: 1.2, pacing: 1.2, underbooked: 1.1, safety: 1.0, fleet: 0.8, waivers: 0.7, missing_phone: 0.5 },
  },
  general_manager: {
    label: "General Manager",
    defaultDetail: "standard",
    focusAreas: ["bookings", "fleet", "staffing", "revenue", "leads", "safety"],
    cardOrder: ["bookings", "fleet", "staffing", "revenue", "waivers", "leads"],
    priorityWeights: { safety: 1.1, fleet: 1.0, waivers: 1.0, revenue: 0.9, bookings: 1.0 },
  },
  operations_manager: {
    label: "Operations Manager",
    defaultDetail: "standard",
    focusAreas: ["bookings", "staffing", "fleet", "weather", "safety", "maintenance"],
    cardOrder: ["bookings", "waivers", "fleet", "staffing", "late_returns", "unpaid"],
    priorityWeights: { waivers: 1.2, safety: 1.2, fleet: 1.1, late_returns: 1.1, staffing: 1.1, missing_phone: 1.0, revenue: 0.6 },
  },
  reservations: {
    label: "Reservations",
    defaultDetail: "operational",
    focusAreas: ["bookings", "revenue", "leads", "staffing"],
    cardOrder: ["bookings", "waivers", "unpaid", "missing_phone", "leads", "vip"],
    priorityWeights: { waivers: 1.2, unpaid: 1.2, missing_phone: 1.1, vip: 1.1, leads: 1.1, fleet: 0.3, safety: 0.6, revenue: 0.7 },
  },
  fleet: {
    label: "Fleet Manager",
    defaultDetail: "operational",
    focusAreas: ["fleet", "maintenance", "safety", "bookings"],
    cardOrder: ["fleet", "maintenance", "safety", "late_returns"],
    priorityWeights: { fleet: 1.5, maintenance: 1.4, safety: 1.3, late_returns: 1.0, bookings: 0.5, revenue: 0.2, waivers: 0.2, leads: 0.1 },
  },
  mechanic: {
    label: "Mechanic",
    defaultDetail: "operational",
    focusAreas: ["fleet", "maintenance", "safety"],
    cardOrder: ["fleet", "maintenance", "safety"],
    priorityWeights: { fleet: 1.5, maintenance: 1.5, safety: 1.4, bookings: 0.2, revenue: 0.1, waivers: 0.1, leads: 0.1 },
  },
  guide: {
    label: "Guide",
    defaultDetail: "operational",
    focusAreas: ["bookings", "weather", "safety"],
    cardOrder: ["bookings", "weather", "vip", "late_returns"],
    priorityWeights: { bookings: 1.3, weather: 1.1, vip: 1.1, safety: 1.1, fleet: 0.3, revenue: 0.1, unpaid: 0.1, leads: 0.1 },
  },
  marketing: {
    label: "Marketing",
    defaultDetail: "standard",
    focusAreas: ["leads", "revenue", "bookings"],
    cardOrder: ["leads", "underbooked", "pacing", "revenue"],
    priorityWeights: { leads: 1.4, underbooked: 1.3, pacing: 1.3, revenue: 1.0, fleet: 0.1, waivers: 0.1, safety: 0.4 },
  },
};

export function getRoleProfile(role) {
  return ROLE_PROFILES[normalizeRole(role)] ?? ROLE_PROFILES.owner;
}

// ── Mission Control dashboard (Phase 2) ───────────────────────────────────────
// Widget registry — id → display metadata. Order/visibility is per-user.
export const DASHBOARD_WIDGETS = {
  priorities: { title: "Action Items",     icon: "📋" },
  today:      { title: "Today's Bookings",  icon: "🏁" },
  upcoming:   { title: "Upcoming Week",     icon: "📅" },
  fleet:      { title: "Fleet & Work Orders", icon: "🔧" },
  revenue:    { title: "Revenue",           icon: "💰" },
  leads:      { title: "Leads",             icon: "🔥" },
  weather:    { title: "Weather",           icon: "🌤" },
};
export const DASHBOARD_WIDGET_IDS = Object.keys(DASHBOARD_WIDGETS);

// Default widget set + order per role (the "role preset").
export const DASHBOARD_PRESETS = {
  owner:              ["priorities", "revenue", "today", "upcoming", "fleet", "leads", "weather"],
  general_manager:    ["priorities", "today", "fleet", "revenue", "leads", "upcoming"],
  operations_manager: ["priorities", "today", "fleet", "upcoming", "weather"],
  reservations:       ["priorities", "today", "leads", "revenue", "upcoming"],
  fleet:              ["priorities", "fleet", "today"],
  mechanic:           ["priorities", "fleet"],
  guide:              ["priorities", "today", "weather"],
  marketing:          ["priorities", "leads", "revenue", "upcoming"],
};

export function dashboardPresetFor(role) {
  return DASHBOARD_PRESETS[normalizeRole(role)] ?? DASHBOARD_PRESETS.owner;
}

// Resolve the widget list for a user: a saved layout (filtered to known ids)
// wins; otherwise the role-preset default. Pure.
export function resolveDashboardWidgets(role, savedLayout) {
  const saved = Array.isArray(savedLayout?.widgets) ? savedLayout.widgets : null;
  if (saved) {
    const valid = saved.filter((id) => DASHBOARD_WIDGET_IDS.includes(id));
    if (valid.length) return [...new Set(valid)];
  }
  return dashboardPresetFor(role);
}

// Focus areas for a phone: explicit digest_types win (unless ['all']/empty),
// otherwise the role default. Returns a lowercase array.
export function resolveFocusAreas(role, explicitDigestTypes) {
  const explicit = Array.isArray(explicitDigestTypes)
    ? explicitDigestTypes.map((t) => String(t ?? "").toLowerCase().trim()).filter(Boolean)
    : [];
  if (explicit.length && !explicit.includes("all")) return explicit;
  return getRoleProfile(role).focusAreas;
}
