// ─────────────────────────────────────────────────────────────────────────────
// DEMO FLOW — Guided, conversion-focused sales demo for Highmark prospects
//
// bookingMode === "demo" routes here from index.js. No AI calls, no real APIs.
// All state lives in convo.bookingData._demo (JSONB, no schema migration needed).
//
// ── State shape ──────────────────────────────────────────────────────────────
// {
//   step:            string    — current step name (see Steps below)
//   path:            number    — active feature path (1 / 2 / 3 / null)
//   exploredPaths:   number[]  — paths the user has seen (drives ✅ markers + CTA strength)
//   vertical:        string    — detected business type key (see VERTICALS)
//   businessTypeRaw: string    — raw text from business type question
//   leadName:        string    — collected during lead capture
//   leadBusiness:    string    — collected during lead capture
//   prevStep:        string    — previous step, used by BACK command
// }
//
// ── Steps ────────────────────────────────────────────────────────────────────
//   start                → first contact; shows opener (asks business type)
//   awaiting_business_type → waiting for business type; detects vertical
//   awaiting_menu        → menu shown; waiting for 1/2/3/4 or YES intent
//   path_intro           → feature demo intro shown; any reply → followup
//   path_followup        → value + revenue sim shown; YES/path/MENU handled
//   path_cta             → direct CTA; YES → lead capture, NO/MENU → menu
//   lead_name            → asking for name
//   lead_business        → asking for business name
//   lead_website         → asking for website (skippable)
//   complete             → lead saved; not a dead end — MENU/paths/YES still work
//
// ── Global commands (any state) ──────────────────────────────────────────────
//   MENU / OPTIONS → show main menu
//   BACK           → return to previous step
//   START OVER / DEMO / RESTART / RESET → full reset to opener
//
// ── Extending the demo ───────────────────────────────────────────────────────
// To add a new vertical (business type):
//   1. Add an entry to VERTICALS with label, menuContext, qa/lead/booking scenarios, and stats
//   2. Add keyword patterns to detectVertical()
//   All paths use the vertical automatically — no other changes needed.
//
// To add a new feature path:
//   1. Add an entry to PATHS with label, menuLine, getIntro(vertical), getFollowup(vertical)
//   2. Update MENU_ITEMS order if needed
//   The state machine handles routing, menus, ✅ markers, and CTA automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { saveLead } from "./leads.js";

// ── Vertical config ──────────────────────────────────────────────────────────
// Each vertical defines simulated customer interactions + illustrative stats.
// Add new verticals here — state machine uses them automatically.

const VERTICALS = {
  outdoor: {
    label: "tour or rental business",
    menuContext: "Built for tour operators and rental companies.",
    qa: {
      customerQ: `"What trails are open right now?"`,
      botA:      `"Rabbit Ears Pass — 8\" fresh snow, trails fully open. Guided tours from $249, rentals from $199. Want to check Saturday availability?"`,
    },
    lead: {
      scenario: `"Just looking at options for a group trip next month."`,
      outcome:  `"Perfect timing — how many in your group? I'll check what's available and can hold a spot for you."`,
    },
    booking: {
      scenario: `"I want to book the guided snowmobile tour for Saturday."`,
      outcome:  `Highmark shows open slots, answers questions, sends a direct booking link — confirmed in 3 texts.`,
    },
    inquiries: 14, bookings: 6, leads: 5,
  },
  appointments: {
    label: "appointments-based business",
    menuContext: "Perfect for salons, spas, and service businesses.",
    qa: {
      customerQ: `"Do you have any openings this Saturday?"`,
      botA:      `"Yes — 11am and 2:30pm are both open. Which works better for you?"`,
    },
    lead: {
      scenario: `"Not ready to book, just getting prices first."`,
      outcome:  `"Totally fine — what service are you thinking? I can send details and hold a slot while you decide."`,
    },
    booking: {
      scenario: `"I want to schedule a cut and color next week."`,
      outcome:  `Highmark checks the calendar, confirms the time, sends a reminder 24 hrs before. No double-bookings.`,
    },
    inquiries: 22, bookings: 11, leads: 7,
  },
  home_services: {
    label: "home services business",
    menuContext: "Great for contractors, HVAC, landscaping, and home services.",
    qa: {
      customerQ: `"Are you available for a quote this week?"`,
      botA:      `"Yes — Thursday afternoon and Friday morning are open. What's the job? I'll make sure the right tech is there."`,
    },
    lead: {
      scenario: `"My AC is making a weird noise, not sure if it's urgent."`,
      outcome:  `"Could be a few things — let me get your address and I'll have someone call you today."`,
    },
    booking: {
      scenario: `"I need my gutters cleaned before the storm."`,
      outcome:  `Highmark qualifies the job, checks the schedule, confirms the appointment over text. Calendar filled.`,
    },
    inquiries: 18, bookings: 9, leads: 6,
  },
  restaurant: {
    label: "restaurant or cafe",
    menuContext: "Works great for restaurants, cafes, and food businesses.",
    qa: {
      customerQ: `"What are your hours on Sunday?"`,
      botA:      `"Open 9am–3pm Sunday. Kitchen closes at 2:30. Reservations recommended for 4+. Want a table?"`,
    },
    lead: {
      scenario: `"Thinking about booking a private dinner for 20 people."`,
      outcome:  `"We'd love that — what date? I'll check our private dining availability right now."`,
    },
    booking: {
      scenario: `"Can I get a reservation for 6 on Friday at 7pm?"`,
      outcome:  `Highmark checks availability, confirms the reservation, sends a reminder the day before. No missed calls.`,
    },
    inquiries: 31, bookings: 16, leads: 9,
  },
  fitness: {
    label: "fitness or wellness studio",
    menuContext: "Built for gyms, yoga studios, and wellness businesses.",
    qa: {
      customerQ: `"Do you offer drop-in classes?"`,
      botA:      `"Yes — drop-in is $20. 6pm yoga and 7pm HIIT both have spots tonight. Want me to hold one?"`,
    },
    lead: {
      scenario: `"Not sure which membership is right for me."`,
      outcome:  `"Happy to help — how often do you work out? I'll match you to the right plan and set up a trial class."`,
    },
    booking: {
      scenario: `"I want to start personal training next week."`,
      outcome:  `Highmark collects goals, checks trainer availability, books an intro session — all over text. New client onboarded.`,
    },
    inquiries: 19, bookings: 8, leads: 7,
  },
  default: {
    label: "business",
    menuContext: "Highmark works for any customer-facing business.",
    qa: {
      customerQ: `"What are your hours and do you take walk-ins?"`,
      botA:      `"Open Mon–Fri 9am–6pm, walk-ins welcome. Saturdays by appointment. Want to check availability?"`,
    },
    lead: {
      scenario: `"Just looking into options, not ready to commit yet."`,
      outcome:  `"No problem — what are you trying to get done? I'll send the right info and follow up."`,
    },
    booking: {
      scenario: `"I want to schedule something this week."`,
      outcome:  `Highmark handles availability, confirmation, and reminders — no staff required.`,
    },
    inquiries: 16, bookings: 7, leads: 5,
  },
};

// ── Feature path config ──────────────────────────────────────────────────────
// Config-driven — add new paths here without touching the state machine.
// getIntro / getFollowup receive the detected vertical and return tailored copy.

const PATHS = {
  1: {
    label:    "Q&A",
    menuLine: "Answer customer questions instantly",
    getIntro(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Here's Q&A in action:\n\n` +
        `Customer: ${v.qa.customerQ}\n\n` +
        `Highmark: ${v.qa.botA}\n\n` +
        `⚡ 4 seconds. No staff needed.\n\nReply anything to see the impact.`
      );
    },
    getFollowup(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Every FAQ and pricing question answered 24/7 — pulled directly from your website.\n\n` +
        `~${v.inquiries} after-hours inquiries a week that used to go unanswered. Highmark handles all of them.`
      );
    },
  },
  2: {
    label:    "Lead Capture",
    menuLine: "Capture leads automatically",
    getIntro(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Here's lead capture in action:\n\n` +
        `Customer: ${v.lead.scenario}\n\n` +
        `Highmark: ${v.lead.outcome}\n\n` +
        `✅ Lead saved. You're notified instantly.\n\nReply anything to see more.`
      );
    },
    getFollowup(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `You get a text the moment a lead comes in — name, number, what they need.\n\n` +
        `~${v.leads} leads/week that would have just bounced. Zero spreadsheets. Zero missed follow-ups.`
      );
    },
  },
  3: {
    label:    "Booking",
    menuLine: "Drive more bookings",
    getIntro(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Here's the booking flow in action:\n\n` +
        `Customer: ${v.booking.scenario}\n\n` +
        `${v.booking.outcome}\n\nReply anything to see more.`
      );
    },
    getFollowup(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Full booking flow, zero friction.\n\n` +
        `~${v.bookings} more bookings/week from people who would have texted a competitor and heard nothing back.`
      );
    },
  },
};

const OPENER =
`Welcome to Highmark 👋

I'm an AI SMS concierge — I answer questions, capture leads, and drive bookings for customer-facing businesses.

What kind of business are you in? (e.g. tours, salon, restaurant, gym, contractor)`;

const RESET_KEYWORDS = new Set(["START OVER", "DEMO", "RESTART", "RESET"]);

// ── Vertical detection ───────────────────────────────────────────────────────
// Keyword-based detection from free-form business description.
// Add patterns here when adding a new vertical to VERTICALS.

export function detectVertical(text) {
  const t = text.toLowerCase();
  if (/snow|sled|tour|raft|rental|outdoor|adventure|fishing|atv|rzr|kayak|zipline|excursion/i.test(t)) return "outdoor";
  if (/salon|spa|beauty|nail|massage|facial|barber|esthetic|lash|wax|blowout/i.test(t))              return "appointments";
  if (/plumb|hvac|contractor|landscape|lawn|clean|handyman|home.?service|repair|roof|electric/i.test(t)) return "home_services";
  if (/restaurant|cafe|diner|\bbar\b|bistro|food|catering|dining|brewery|coffee/i.test(t))           return "restaurant";
  if (/gym|fitness|yoga|crossfit|pilates|studio|wellness|personal.?train|boot.?camp/i.test(t))       return "fitness";
  return "default";
}

// ── Menu builder ─────────────────────────────────────────────────────────────
// Shows vertical context line + ✅ markers for explored paths.

function buildMenu(exploredPaths = [], vertical = "default") {
  const v = VERTICALS[vertical] || VERTICALS.default;
  const lines = [`${v.menuContext}\n\nWhat do you want to explore?\n`];
  for (const [k, p] of Object.entries(PATHS)) {
    const n    = Number(k);
    const mark = exploredPaths.includes(n) ? "✅" : `${k}️⃣`;
    lines.push(`${mark} ${p.menuLine}`);
  }
  lines.push("\n4️⃣ Get this for my business");
  return lines.join("\n");
}

// ── Revenue simulation ───────────────────────────────────────────────────────
// Shown after first path explored. Clearly framed as projection, not real data.

function buildRevenueSimulation(vertical) {
  const v = VERTICALS[vertical] || VERTICALS.default;
  return (
    `📊 Similar ${v.label}: ~${v.inquiries} inquiries/wk → ` +
    `${v.bookings} bookings + ${v.leads} leads\n` +
    `*(illustrative — results vary)*`
  );
}

// ── Post-path CTA builder ─────────────────────────────────────────────────────
// After seeing a path: offer unexplored paths + revenue sim on first explore.
// Strong "you've seen it all" CTA after all paths explored.

function buildFollowupCta(path, exploredPaths, vertical = "default") {
  const unexplored = [1, 2, 3].filter((n) => !exploredPaths.includes(n) && n !== path);
  const lines = [PATHS[path].getFollowup(vertical), ""];

  // Revenue simulation shown after the first path is explored
  if (exploredPaths.length === 1) {
    lines.push(buildRevenueSimulation(vertical), "");
  }

  if (unexplored.length > 0) {
    const opts = unexplored.map((n) => `${n}️⃣ ${PATHS[n].label}`).join("  ");
    lines.push(`Reply YES to get started, or explore more:\n${opts}`);
  } else {
    lines.push(`You've seen the full platform. Ready to get this live?\n\nReply YES — I'll set it up for your business.`);
  }
  return lines.join("\n");
}

// ── Intent detection ──────────────────────────────────────────────────────────

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

// ── State helpers ─────────────────────────────────────────────────────────────

function getState(convo) {
  return convo.bookingData?._demo ?? {
    step: "start", path: null, exploredPaths: [], vertical: "default", businessTypeRaw: null,
    leadName: null, leadBusiness: null, prevStep: null,
  };
}

// Merges patch into existing state (preserves unexplored fields)
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

  // ── Global: reset ──────────────────────────────────────────────────────────
  if (RESET_KEYWORDS.has(bodyUpper)) {
    transition(convo, "awaiting_business_type", {
      path: null, exploredPaths: [], vertical: "default", businessTypeRaw: null,
      leadName: null, leadBusiness: null,
    });
    console.log(`[DEMO] Reset — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── Global: MENU ───────────────────────────────────────────────────────────
  if (bodyUpper === "MENU" || bodyUpper === "OPTIONS") {
    const state = getState(convo);
    transition(convo, "awaiting_menu");
    return { reply: buildMenu(state.exploredPaths ?? [], state.vertical ?? "default") };
  }

  // ── Global: BACK ───────────────────────────────────────────────────────────
  if (bodyUpper === "BACK") {
    const state = getState(convo);
    const prev  = state.prevStep;
    if (prev && prev !== "start" && prev !== "awaiting_business_type") {
      setState(convo, { step: prev, prevStep: null });
      if (prev === "awaiting_menu")               return { reply: buildMenu(state.exploredPaths ?? [], state.vertical ?? "default") };
      if (prev === "path_intro" && state.path)    return { reply: PATHS[state.path].getIntro(state.vertical ?? "default") };
    }
    transition(convo, "awaiting_menu");
    return { reply: buildMenu(state.exploredPaths ?? [], state.vertical ?? "default") };
  }

  const state = getState(convo);

  // ── First contact ──────────────────────────────────────────────────────────
  if (isNew || !state.step || state.step === "start") {
    transition(convo, "awaiting_business_type", {
      path: null, exploredPaths: [], vertical: "default", businessTypeRaw: null,
      leadName: null, leadBusiness: null,
    });
    console.log(`[DEMO] New visitor — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── awaiting_business_type ─────────────────────────────────────────────────
  if (state.step === "awaiting_business_type") {
    // YES intent or "4" → skip straight to lead capture with default vertical
    if (isYesIntent(body)) {
      transition(convo, "lead_name", { vertical: "default" });
      return { reply: "Let's get started! What's your name?" };
    }
    // Path number typed directly → use default vertical and jump to that path
    const directPath = detectPath(body);
    if (directPath) {
      const vertical = "default";
      transition(convo, "path_intro", { path: directPath, exploredPaths: addExplored([], directPath), vertical });
      return { reply: PATHS[directPath].getIntro(vertical) };
    }
    // Free-form business description → detect vertical + show personalized menu
    const vertical = detectVertical(body);
    const v        = VERTICALS[vertical];
    transition(convo, "awaiting_menu", { vertical, businessTypeRaw: body.slice(0, 100) });
    console.log(`[DEMO] Vertical detected: ${vertical} (${v.label}) — ${fromNumber}`);
    return { reply: buildMenu([], vertical) };
  }

  // ── awaiting_menu ──────────────────────────────────────────────────────────
  if (state.step === "awaiting_menu") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    return { reply: `Choose a feature to explore:\n\n1️⃣ Q&A  2️⃣ Lead Capture  3️⃣ Booking\n\n4️⃣ Get this for my business` };
  }

  // ── path_intro → any reply shows followup + CTA ────────────────────────────
  if (state.step === "path_intro") {
    const vertical = state.vertical ?? "default";
    if (!state.path) { transition(convo, "awaiting_menu"); return { reply: buildMenu(state.exploredPaths ?? [], vertical) }; }
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Love it! What's your name?" };
    }
    transition(convo, "path_followup");
    return { reply: buildFollowupCta(state.path, state.exploredPaths ?? [], vertical) };
  }

  // ── path_followup → YES, explore another, or direct CTA ───────────────────
  if (state.step === "path_followup") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Awesome! What's your name?" };
    }
    const path = detectPath(body);
    if (path && path !== state.path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    if (isNoIntent(body)) {
      transition(convo, "awaiting_menu");
      return { reply: buildMenu(state.exploredPaths ?? [], vertical) };
    }
    // Any other reply → direct CTA
    transition(convo, "path_cta");
    return { reply: `This is exactly how Highmark works for your business.\n\nWant me to set this up for you?\n\nReply YES and I'll get you started. Or reply MENU to explore more.` };
  }

  // ── path_cta → clear YES / NO / explore ────────────────────────────────────
  if (state.step === "path_cta") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Perfect! What's your name?" };
    }
    if (isNoIntent(body)) {
      transition(convo, "awaiting_menu");
      return { reply: buildMenu(state.exploredPaths ?? [], vertical) };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    return { reply: `Want to get started?\n\nReply YES — I'll set it up for your business.\nOr reply MENU to keep exploring.` };
  }

  // ── Lead capture: name ─────────────────────────────────────────────────────
  if (state.step === "lead_name") {
    const name = body.slice(0, 60) || null;
    transition(convo, "lead_business", { leadName: name });
    return { reply: `Nice to meet you${name ? ", " + name : ""}! What's the name of your business?` };
  }

  // ── Lead capture: business ─────────────────────────────────────────────────
  if (state.step === "lead_business") {
    const business = body.slice(0, 100) || null;
    transition(convo, "lead_website", { leadBusiness: business });
    return { reply: "Got it! Do you have a website? (Reply SKIP to skip)" };
  }

  // ── Lead capture: website → save + notify ─────────────────────────────────
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
        `Vertical: ${s.vertical ?? "default"}`,
        `Phone: ${fromNumber}`,
        `Demo path: ${s.path ? (PATHS[s.path]?.label ?? "demo") : "demo"}`,
      ];
      if (website) lines.push(`Website: ${website}`);
      twilioClient.messages.create({ body: lines.join("\n"), from: toNumber, to: notifyPhone })
        .catch((err) => console.error("[DEMO] admin notify error:", err.message));
    }

    console.log(`[DEMO] Lead captured — ${fromNumber} | ${s.leadName} | ${s.leadBusiness} | vertical: ${s.vertical}`);
    const name = s.leadName ? `, ${s.leadName}` : "";
    return { reply: `You're all set${name}! 🏔\n\nI'll reach out shortly to get Highmark live for your business.\n\nQuestions? hello@whiteoutsolutions.co\nReply MENU to keep exploring.` };
  }

  // ── complete — not a dead end ──────────────────────────────────────────────
  if (state.step === "complete") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      return { reply: "We'll be in touch very soon! Reply MENU to keep exploring the platform." };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "path_intro", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    return { reply: "We'll reach out shortly! Reply MENU to keep exploring, or START OVER to restart the demo." };
  }

  // Fallback — shouldn't be reached
  transition(convo, "awaiting_business_type", { path: null, exploredPaths: [], vertical: "default" });
  return { reply: OPENER };
}
