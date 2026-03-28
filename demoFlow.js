// ─────────────────────────────────────────────────────────────────────────────
// DEMO FLOW — Guided, conversion-focused sales demo for Highmark prospects
//
// bookingMode === "demo" routes here from index.js. No AI calls, no real APIs.
// All state lives in convo.bookingData._demo (JSONB, no schema migration needed).
//
// ── State shape ──────────────────────────────────────────────────────────────
// {
//   step:          string    — current step name (see Steps below)
//   path:          number    — active feature path (1 / 2 / 3 / null)
//   exploredPaths: number[]  — paths the user has seen (drives ✅ markers + CTA strength)
//   leadName:      string    — collected during lead capture
//   leadBusiness:  string    — collected during lead capture
//   prevStep:      string    — previous step, used by BACK command
// }
//
// ── Steps ────────────────────────────────────────────────────────────────────
//   start         → first contact; shows opener
//   awaiting_menu → menu shown; waiting for 1/2/3/4 or YES intent
//   path_intro    → feature demo intro shown; any reply → followup
//   path_followup → value + next steps shown; YES/path/MENU handled
//   path_cta      → direct CTA; YES → lead capture, NO/MENU → menu
//   lead_name     → asking for name
//   lead_business → asking for business name
//   lead_website  → asking for website (skippable)
//   complete      → lead saved; not a dead end — MENU/paths/YES still work
//
// ── Global commands (any state) ──────────────────────────────────────────────
//   MENU / OPTIONS → show main menu
//   BACK           → return to previous step
//   START OVER / DEMO / RESTART / RESET → full reset to opener
//
// ── Extending the demo ───────────────────────────────────────────────────────
// To add a new feature path (campaigns, CRM, analytics, etc.):
//   1. Add an entry to PATHS with label, menuLine, intro, and followup
//   2. Update MENU_ITEMS order if needed
//   The state machine handles routing, menus, ✅ markers, and CTA automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { saveLead } from "./leads.js";

// ── Feature path config ────────────────────────────────────────────────────
// Config-driven — add new paths here without touching the state machine.

const PATHS = {
  1: {
    label:    "Q&A",
    menuLine: "Answer customer questions instantly",
    intro:
`Here's Q&A in action.

A customer texts "What are your hours?" at 11pm. I reply in seconds — pulled directly from your website. Accurate, 24/7, no staff needed.

Reply anything to see more.`,
    followup:
`Every FAQ, pricing question, and policy — handled automatically around the clock.

Staff only step in when it truly matters. Most businesses cut inquiry volume by 60%+.`,
  },
  2: {
    label:    "Lead Capture",
    menuLine: "Capture leads automatically",
    intro:
`Here's lead capture in action.

A customer shows interest but isn't ready to book. I collect their name, contact info, and what they need — then alert your team instantly. No lead falls through the cracks.

Reply anything to see more.`,
    followup:
`You get a text the moment a lead comes in. Your team follows up with context already in hand.

Zero spreadsheets. Zero missed opportunities.`,
  },
  3: {
    label:    "Booking",
    menuLine: "Drive more bookings",
    intro:
`Here's the booking flow in action.

A customer texts "I want to book." I show availability, answer questions, and send a direct booking link — all in one thread. No phone tag.

Reply anything to see more.`,
    followup:
`Full booking flow, zero friction. Most businesses see 20–30% more conversions vs. just a phone number.`,
  },
};

const OPENER =
`Welcome to Highmark 👋

I'm your AI SMS concierge — I handle customer questions, capture leads, and drive bookings automatically.

What do you want to see first?

1️⃣ Answer customer questions instantly
2️⃣ Capture leads automatically
3️⃣ Drive more bookings
4️⃣ Get this for my business`;

const RESET_KEYWORDS = new Set(["START OVER", "DEMO", "RESTART", "RESET"]);

// ── Menu builder ───────────────────────────────────────────────────────────
// Marks explored paths with ✅. Highlights 4️⃣ Get started at the bottom.

function buildMenu(exploredPaths = []) {
  const lines = ["What do you want to explore?\n"];
  for (const [k, p] of Object.entries(PATHS)) {
    const n = Number(k);
    const mark = exploredPaths.includes(n) ? "✅" : `${k}️⃣`;
    lines.push(`${mark} ${p.menuLine}`);
  }
  lines.push("\n4️⃣ Get this for my business");
  return lines.join("\n");
}

// ── Post-path CTA builder ──────────────────────────────────────────────────
// After seeing a path: offer unexplored paths OR a strong CTA if all seen.

function buildFollowupCta(path, exploredPaths) {
  const unexplored = [1, 2, 3].filter((n) => !exploredPaths.includes(n) && n !== path);
  const lines = [PATHS[path].followup, ""];

  if (unexplored.length > 0) {
    const opts = unexplored.map((n) => `${n}️⃣ ${PATHS[n].label}`).join("  ");
    lines.push(`Reply YES to get started, or explore more:\n${opts}`);
  } else {
    lines.push(`You've seen the full platform. Ready to get this live?\n\nReply YES — I'll set it up for your business.`);
  }
  return lines.join("\n");
}

// ── Intent detection ───────────────────────────────────────────────────────

export function isYesIntent(body) {
  return /^(yes|yep|yeah|yup|sure|absolutely|interested|definitely|lets do it|let's do it|lets go|let's go|sign me up|i'm in|im in|pricing|how do i start|how much|get started|get this|start|i want|set it up|4)/i.test(body.trim());
}

export function isNoIntent(body) {
  return /^(no|nope|nah|not now|maybe later|not interested|stop|quit|cancel|never mind|nevermind)/i.test(body.trim());
}

export function detectPath(body) {
  const t = body.trim();
  if (/^1/.test(t)) return 1;
  if (/^2/.test(t)) return 2;
  if (/^3/.test(t)) return 3;
  return null;
}

// ── State helpers ──────────────────────────────────────────────────────────

function getState(convo) {
  return convo.bookingData?._demo ?? {
    step: "start", path: null, exploredPaths: [], leadName: null, leadBusiness: null, prevStep: null,
  };
}

// Merges patch into existing state (preserves unexplored fields like exploredPaths, leadName, etc.)
function setState(convo, patch) {
  if (!convo.bookingData) convo.bookingData = {};
  convo.bookingData._demo = { ...(convo.bookingData._demo ?? {}), ...patch };
}

// Records prevStep so BACK can navigate back, then applies patch
function transition(convo, newStep, extra = {}) {
  const current = convo.bookingData?._demo ?? {};
  setState(convo, { ...extra, prevStep: current.step ?? null, step: newStep });
}

function addExplored(existing, path) {
  return [...(existing ?? []), path].filter((v, i, a) => a.indexOf(v) === i);
}

function getDemoNotifyPhone() {
  return process.env.DEMO_NOTIFY_PHONE || process.env.CONFIRMATIONS_TEST_PHONE || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// handleDemoFlow — main entry point
// Called from index.js when client.bookingMode === "demo"
// Returns { reply: string }
// ─────────────────────────────────────────────────────────────────────────────
export async function handleDemoFlow({ supabase, twilioClient, fromNumber, toNumber, rawBody, testMode, isNew, convo }) {
  const body      = rawBody.trim();
  const bodyUpper = body.toUpperCase();

  console.log(`[DEMO] ${fromNumber} → "${body.slice(0, 40)}"`);

  // ── Global: reset ──────────────────────────────────────────────────────
  if (RESET_KEYWORDS.has(bodyUpper)) {
    transition(convo, "awaiting_menu", { path: null, exploredPaths: [], leadName: null, leadBusiness: null });
    console.log(`[DEMO] Reset — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── Global: MENU ───────────────────────────────────────────────────────
  if (bodyUpper === "MENU" || bodyUpper === "OPTIONS") {
    const state = getState(convo);
    transition(convo, "awaiting_menu");
    return { reply: buildMenu(state.exploredPaths ?? []) };
  }

  // ── Global: BACK ───────────────────────────────────────────────────────
  if (bodyUpper === "BACK") {
    const state = getState(convo);
    const prev  = state.prevStep;
    if (prev && prev !== "start") {
      setState(convo, { step: prev, prevStep: null });
      if (prev === "awaiting_menu")  return { reply: buildMenu(state.exploredPaths ?? []) };
      if (prev === "path_intro" && state.path) return { reply: PATHS[state.path].intro };
    }
    transition(convo, "awaiting_menu");
    return { reply: buildMenu(state.exploredPaths ?? []) };
  }

  const state = getState(convo);

  // ── First contact ──────────────────────────────────────────────────────
  if (isNew || !state.step || state.step === "start") {
    transition(convo, "awaiting_menu", { path: null, exploredPaths: [], leadName: null, leadBusiness: null });
    console.log(`[DEMO] New visitor — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── awaiting_menu ──────────────────────────────────────────────────────
  if (state.step === "awaiting_menu") {
    // "4" or YES intent → jump straight to lead capture
    if (body.trim() === "4" || isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].intro };
    }
    return { reply: `Choose a feature to explore:\n\n1️⃣ Q&A  2️⃣ Lead Capture  3️⃣ Booking\n\n4️⃣ Get this for my business` };
  }

  // ── path_intro → any reply shows followup + CTA ────────────────────────
  if (state.step === "path_intro") {
    if (!state.path) { transition(convo, "awaiting_menu"); return { reply: buildMenu(state.exploredPaths ?? []) }; }
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Love it! What's your name?" };
    }
    transition(convo, "path_followup");
    return { reply: buildFollowupCta(state.path, state.exploredPaths ?? []) };
  }

  // ── path_followup → YES, explore another, or direct CTA ───────────────
  if (state.step === "path_followup") {
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Awesome! What's your name?" };
    }
    // Jump to a different path
    const path = detectPath(body);
    if (path && path !== state.path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].intro };
    }
    if (isNoIntent(body) || bodyUpper === "MENU") {
      transition(convo, "awaiting_menu");
      return { reply: buildMenu(state.exploredPaths ?? []) };
    }
    // Any other reply → direct CTA
    transition(convo, "path_cta");
    return { reply: `This is exactly how Highmark works for your business.\n\nWant me to set this up for you?\n\nReply YES and I'll get you started. Or reply MENU to explore more.` };
  }

  // ── path_cta → clear YES / NO / explore ───────────────────────────────
  if (state.step === "path_cta") {
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Perfect! What's your name?" };
    }
    if (isNoIntent(body)) {
      transition(convo, "awaiting_menu");
      return { reply: buildMenu(state.exploredPaths ?? []) };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].intro };
    }
    return { reply: `Want to get started?\n\nReply YES — I'll set it up for your business.\nOr reply MENU to keep exploring.` };
  }

  // ── Lead capture: name ─────────────────────────────────────────────────
  if (state.step === "lead_name") {
    const name = body.slice(0, 60) || null;
    transition(convo, "lead_business", { leadName: name });
    return { reply: `Nice to meet you${name ? ", " + name : ""}! What's the name of your business?` };
  }

  // ── Lead capture: business ─────────────────────────────────────────────
  if (state.step === "lead_business") {
    const business = body.slice(0, 100) || null;
    transition(convo, "lead_website", { leadBusiness: business });
    return { reply: "Got it! Do you have a website? (Reply SKIP to skip)" };
  }

  // ── Lead capture: website → save + notify ─────────────────────────────
  if (state.step === "lead_website") {
    const website = /^(skip|none|no|nope|n\/a)$/i.test(body.trim()) ? null : body.trim().slice(0, 200);
    transition(convo, "complete", { leadWebsite: website });

    // Read merged state after transition
    const s = getState(convo);

    if (supabase) {
      await saveLead(supabase, {
        clientId:     "highmark_demo",
        fromNumber,
        contactPhone: fromNumber,
        contactEmail: null,
        name:         s.leadName,
        service:      s.path ? (PATHS[s.path]?.label ?? "demo") : "demo",
        timeframe:    website ? `website: ${website}` : null,
        leadType:     "demo",
      }).catch((err) => console.error("[DEMO] saveLead error:", err.message));
    }

    const notifyPhone = getDemoNotifyPhone();
    if (notifyPhone && twilioClient && !testMode) {
      const lines = [
        "🏔 New Highmark demo lead!",
        `Name: ${s.leadName ?? "unknown"}`,
        `Business: ${s.leadBusiness ?? "unknown"}`,
        `Phone: ${fromNumber}`,
        `Demo path: ${s.path ? (PATHS[s.path]?.label ?? "demo") : "demo"}`,
      ];
      if (website) lines.push(`Website: ${website}`);
      twilioClient.messages.create({ body: lines.join("\n"), from: toNumber, to: notifyPhone })
        .catch((err) => console.error("[DEMO] admin notify error:", err.message));
    }

    console.log(`[DEMO] Lead captured — ${fromNumber} | ${s.leadName} | ${s.leadBusiness}`);
    const name = s.leadName ? `, ${s.leadName}` : "";
    return { reply: `You're all set${name}! 🏔\n\nI'll reach out shortly to get Highmark live for your business.\n\nQuestions? hello@whiteoutsolutions.co\nReply MENU to keep exploring.` };
  }

  // ── complete — not a dead end ──────────────────────────────────────────
  if (state.step === "complete") {
    if (isYesIntent(body)) {
      return { reply: "We'll be in touch very soon! Reply MENU to keep exploring the platform." };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].intro };
    }
    return { reply: "We'll reach out shortly! Reply MENU to keep exploring, or START OVER to restart the demo." };
  }

  // Fallback — shouldn't be reached
  transition(convo, "awaiting_menu", { path: null, exploredPaths: [] });
  return { reply: OPENER };
}
