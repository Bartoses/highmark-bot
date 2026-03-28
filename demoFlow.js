// ─────────────────────────────────────────────────────────────────────────────
// DEMO FLOW — Highmark product assistant + guided sales demo
//
// bookingMode === "demo" routes here from index.js. No AI calls, no real APIs.
// All state lives in convo.bookingData._demo (JSONB, no schema migration needed).
//
// ── Behavior priority ────────────────────────────────────────────────────────
//   1. Answer direct questions about Highmark first
//   2. Educate — explain what Highmark does and how it works
//   3. Demonstrate — show tailored business examples
//   4. Convert — lead capture only after clear intent
//
// ── State shape ──────────────────────────────────────────────────────────────
// {
//   step:          string    — current step (see Steps below)
//   qaCount:       number    — substantive Q&A turns completed
//   vertical:      string    — detected business type (see VERTICALS)
//   path:          number    — active demo path (1/2/3)
//   exploredPaths: number[]  — demo paths seen (drives ✅ + CTA strength)
//   leadName:      string
//   leadBusiness:  string
//   prevStep:      string
// }
//
// ── Steps ────────────────────────────────────────────────────────────────────
//   browsing          → main interactive state: Q&A, menu, demos, CTA
//   awaiting_demo_type → asked for business type; waiting for reply
//   demo_menu         → showing demo feature menu for detected vertical
//   demo_path         → showing tailored path intro
//   demo_followup     → showing followup + revenue sim
//   demo_cta          → direct "want to get started?" CTA
//   lead_name         → asking for name
//   lead_business     → asking for business name
//   lead_website      → asking for website (skippable)
//   complete          → lead saved; not a dead end
//
// ── Global commands (any state) ──────────────────────────────────────────────
//   MENU / OPTIONS → main menu
//   BACK           → previous step
//   START OVER / DEMO / RESTART / RESET → full reset
// ─────────────────────────────────────────────────────────────────────────────

import { saveLead } from "./leads.js";

// ── Highmark product knowledge ───────────────────────────────────────────────
// Static KB for product Q&A. Swap for scraped usehighmark.com content once live.
// Keep each entry under ~240 chars so it fits in 2 SMS with follow-on text.

const HM = {
  overview:
`Highmark is an AI SMS concierge. It connects to your business — website, booking system, whatever you use — and handles customer texts automatically. Q&A, lead capture, booking links, confirmations. 24/7. No staff needed.`,

  pricing:
`Two tiers:\n\n• Starter ($200–300/mo) — 24/7 Q&A + lead capture\n• Growth ($400–500/mo) — Q&A + lead capture + live booking integration\n\nSetup included. No per-message fees. Most clients live in 1–3 days.`,

  setup:
`Setup takes 1–3 days:\n1. Twilio number assigned\n2. Your website scraped for Q&A knowledge\n3. Bot persona + tone configured to match your brand\n4. Test pass → go live\n\nNo code. We handle everything.`,

  features:
`What's live today:\n• 24/7 Q&A from your website\n• Lead capture + instant team notification\n• Live booking availability (FareHarbor, Growth tier)\n• CRM: contacts, tags, opt-in/out\n• Booking confirmations + follow-up texts`,

  roadmap:
`Coming next:\n• Campaign messaging (scheduled SMS to customer segments)\n• Analytics dashboard\n• Additional booking integrations (Checkfront, Peek, Rezdy)\n• Multi-channel (web chat, Instagram DM)`,

  scraping:
`Yes. Highmark scrapes your website weekly — pricing, FAQs, hours, policies — and keeps its knowledge current. You can also provide a custom FAQ or static facts during setup. No website required to get started.`,

  how_it_works:
`Customer texts your number → Highmark reads the message → checks your business knowledge → replies in ~4 seconds. Complex questions or "talk to a person" requests route to your team instantly.`,

  integrations:
`Live integrations: FareHarbor (booking), Twilio (SMS), any public website (knowledge scraping).\n\nRoadmap: Checkfront, Peek, Rezdy, Square, and calendar integrations.`,
};

// ── Q&A follow-on lines ───────────────────────────────────────────────────────
// Appended after each Q&A answer. Nudges toward demo or getting started.
// escalatedCta() used after qaCount >= 2.

const QA_FOLLOWON = {
  pricing:      "Any other questions? Reply 2️⃣ to see a demo or 4️⃣ to get started.",
  overview:     "Reply 2️⃣ to see it in action, or ask me anything else.",
  setup:        "Reply 2️⃣ for a demo, or 4️⃣ to get started whenever you're ready.",
  features:     "Reply 2️⃣ to see these features live, or 4️⃣ to get started.",
  roadmap:      "Want to see what's live today? Reply 2️⃣ for a demo.",
  scraping:     "Reply 2️⃣ for a demo, or 4️⃣ to get Highmark set up for your business.",
  how_it_works: "Reply 2️⃣ to see an example conversation, or 4️⃣ to get started.",
  integrations: "Reply 2️⃣ for a demo, or ask me anything else.",
};

function qaFollowon(intent, qaCount) {
  if (qaCount >= 2) return "Ready to get Highmark live? Reply YES or 4️⃣ to get started.";
  return QA_FOLLOWON[intent] ?? "Reply 2️⃣ to see a demo, or ask me anything else.";
}

// ── Vertical config ───────────────────────────────────────────────────────────
// Per-vertical simulated customer exchanges + illustrative stats.

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
      outcome:  `"Perfect timing — how many in your group? I'll check availability and hold a spot for you."`,
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
      outcome:  `"Totally fine — what service are you thinking? I can hold a slot while you decide."`,
    },
    booking: {
      scenario: `"I want to schedule a cut and color next week."`,
      outcome:  `Highmark checks the calendar, confirms the time, sends a reminder 24 hrs before.`,
    },
    inquiries: 22, bookings: 11, leads: 7,
  },
  home_services: {
    label: "home services business",
    menuContext: "Great for contractors, HVAC, landscaping, and home services.",
    qa: {
      customerQ: `"Are you available for a quote this week?"`,
      botA:      `"Yes — Thursday afternoon and Friday morning are open. What's the job?"`,
    },
    lead: {
      scenario: `"My AC is making a weird noise, not sure if it's urgent."`,
      outcome:  `"Could be a few things — let me get your address and I'll have someone call you today."`,
    },
    booking: {
      scenario: `"I need my gutters cleaned before the storm."`,
      outcome:  `Highmark qualifies the job, checks the schedule, confirms the appointment over text.`,
    },
    inquiries: 18, bookings: 9, leads: 6,
  },
  restaurant: {
    label: "restaurant or cafe",
    menuContext: "Works great for restaurants, cafes, and food businesses.",
    qa: {
      customerQ: `"What are your hours on Sunday?"`,
      botA:      `"Open 9am–3pm Sunday. Kitchen closes at 2:30. Want a table?"`,
    },
    lead: {
      scenario: `"Thinking about booking a private dinner for 20 people."`,
      outcome:  `"We'd love that — what date? I'll check our private dining availability."`,
    },
    booking: {
      scenario: `"Can I get a reservation for 6 on Friday at 7pm?"`,
      outcome:  `Highmark checks availability, confirms the reservation, sends a reminder the day before.`,
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
      outcome:  `"Happy to help — how often do you work out? I'll match you to the right plan."`,
    },
    booking: {
      scenario: `"I want to start personal training next week."`,
      outcome:  `Highmark collects goals, checks trainer availability, books an intro session — all over text.`,
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
      outcome:  `"No problem — what are you trying to get done? I'll send the right info."`,
    },
    booking: {
      scenario: `"I want to schedule something this week."`,
      outcome:  `Highmark handles availability, confirmation, and reminders — no staff required.`,
    },
    inquiries: 16, bookings: 7, leads: 5,
  },
};

// ── Demo feature paths ────────────────────────────────────────────────────────

const PATHS = {
  1: {
    label:    "Q&A",
    menuLine: "See Q&A in action",
    getIntro(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Here's Q&A in action:\n\n` +
        `Customer: ${v.qa.customerQ}\n\n` +
        `Highmark: ${v.qa.botA}\n\n` +
        `⚡ ~4 seconds. No staff needed.\n\nReply anything to see the impact.`
      );
    },
    getFollowup(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Every FAQ and pricing question answered 24/7 — pulled from your website.\n\n` +
        `~${v.inquiries} after-hours inquiries a week that used to go unanswered. All handled automatically.`
      );
    },
  },
  2: {
    label:    "Lead Capture",
    menuLine: "See lead capture in action",
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
        `~${v.leads} leads/week that would have just bounced. Zero spreadsheets.`
      );
    },
  },
  3: {
    label:    "Booking",
    menuLine: "See the booking flow",
    getIntro(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Here's the booking flow:\n\n` +
        `Customer: ${v.booking.scenario}\n\n` +
        `${v.booking.outcome}\n\nReply anything to see more.`
      );
    },
    getFollowup(vertical) {
      const v = VERTICALS[vertical] || VERTICALS.default;
      return (
        `Full booking flow, zero friction.\n\n` +
        `~${v.bookings} more bookings/week from people who would have texted a competitor and heard nothing.`
      );
    },
  },
};

// ── Openers and menus ─────────────────────────────────────────────────────────

const OPENER =
`Welcome to Highmark 👋

I help businesses answer customer questions, capture leads, and drive bookings — automatically, by text.

Ask me anything about Highmark, or:
1️⃣ What Highmark does
2️⃣ See a demo
3️⃣ Pricing
4️⃣ Get this for my business`;

const MAIN_MENU =
`What would you like to know?\n\n1️⃣ What Highmark does\n2️⃣ See a demo\n3️⃣ Pricing\n4️⃣ Get this for my business\n\nOr ask me anything about Highmark.`;

const RESET_KEYWORDS = new Set(["START OVER", "DEMO", "RESTART", "RESET"]);

// ── Vertical detection ────────────────────────────────────────────────────────

export function detectVertical(text) {
  const t = text.toLowerCase();
  if (/snow|sled|tour|raft|rental|outdoor|adventure|fishing|atv|rzr|kayak|zipline/i.test(t)) return "outdoor";
  if (/salon|spa|beauty|nail|massage|facial|barber|esthetic|lash|wax/i.test(t))              return "appointments";
  if (/plumb|hvac|contractor|landscape|lawn|clean|handyman|home.?service|repair|roof|electric/i.test(t)) return "home_services";
  if (/restaurant|cafe|diner|\bbar\b|bistro|food|catering|dining|brewery|coffee/i.test(t))  return "restaurant";
  if (/gym|fitness|yoga|crossfit|pilates|studio|wellness|personal.?train|boot.?camp/i.test(t)) return "fitness";
  return "default";
}

// ── Q&A intent detection ──────────────────────────────────────────────────────

export function detectQuestionIntent(body) {
  const t = body.toLowerCase();
  if (/how much|pricing|price|cost|monthly|tier|fee|\bplan\b/i.test(t))                      return "pricing";
  if (/what.*feature|what.*include|capabilit|what.*can it|what comes/i.test(t))              return "features";
  if (/set.?up|how.*start|install|onboard|go live|configure|implement/i.test(t))             return "setup";
  if (/crm|campaign|analytics|dashboard|segment|broadcast|report|automation/i.test(t))       return "roadmap";
  if (/website|scrap|knowledge|faq|how.*learn|how.*know/i.test(t))                           return "scraping";
  if (/how.*work|how does it|sms|text message|phone number|twilio/i.test(t))                  return "how_it_works";
  if (/integrat|fareharbor|booking system|connect|third.?party|square|calendar/i.test(t))   return "integrations";
  if (/what.*do|what.*is|what.*highmark|overview|explain|tell me about|about highmark/i.test(t)) return "overview";
  return null;
}

// ── Demo menu builder ─────────────────────────────────────────────────────────

function buildDemoMenu(exploredPaths = [], vertical = "default") {
  const v = VERTICALS[vertical] || VERTICALS.default;
  const lines = [`${v.menuContext}\n\nWhat do you want to see?\n`];
  for (const [k, p] of Object.entries(PATHS)) {
    const n    = Number(k);
    const mark = exploredPaths.includes(n) ? "✅" : `${k}️⃣`;
    lines.push(`${mark} ${p.menuLine}`);
  }
  lines.push("\n4️⃣ Get this for my business");
  return lines.join("\n");
}

// ── Revenue simulation ────────────────────────────────────────────────────────

function buildRevenueSimulation(vertical) {
  const v = VERTICALS[vertical] || VERTICALS.default;
  return (
    `📊 Similar ${v.label}: ~${v.inquiries} inquiries/wk → ` +
    `${v.bookings} bookings + ${v.leads} leads\n` +
    `*(illustrative — results vary)*`
  );
}

// ── Post-path CTA builder ─────────────────────────────────────────────────────

function buildFollowupCta(path, exploredPaths, vertical = "default") {
  const unexplored = [1, 2, 3].filter((n) => !exploredPaths.includes(n) && n !== path);
  const lines      = [PATHS[path].getFollowup(vertical), ""];

  if (exploredPaths.length === 1) lines.push(buildRevenueSimulation(vertical), "");

  if (unexplored.length > 0) {
    const opts = unexplored.map((n) => `${n}️⃣ ${PATHS[n].label}`).join("  ");
    lines.push(`Reply YES to get started, or explore more:\n${opts}`);
  } else {
    lines.push(`You've seen everything. Ready to get this live?\n\nReply YES — I'll set it up for your business.`);
  }
  return lines.join("\n");
}

// ── Intent detection ──────────────────────────────────────────────────────────

export function isYesIntent(body) {
  return /^(yes|yep|yeah|yup|sure|absolutely|interested|definitely|lets do it|let's do it|lets go|let's go|sign me up|i'm in|im in|how do i start|get started|get this|i want this|set it up|4)/i.test(body.trim());
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
    step: "start", qaCount: 0, vertical: "default", path: null, exploredPaths: [],
    leadName: null, leadBusiness: null, prevStep: null,
  };
}

function setState(convo, patch) {
  if (!convo.bookingData) convo.bookingData = {};
  convo.bookingData._demo = { ...(convo.bookingData._demo ?? {}), ...patch };
}

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
    transition(convo, "browsing", {
      qaCount: 0, path: null, exploredPaths: [], vertical: "default",
      leadName: null, leadBusiness: null,
    });
    console.log(`[DEMO] Reset — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── Global: MENU ───────────────────────────────────────────────────────────
  if (bodyUpper === "MENU" || bodyUpper === "OPTIONS") {
    transition(convo, "browsing");
    return { reply: MAIN_MENU };
  }

  // ── Global: BACK ───────────────────────────────────────────────────────────
  if (bodyUpper === "BACK") {
    const state = getState(convo);
    const prev  = state.prevStep;
    if (prev && prev !== "start") {
      setState(convo, { step: prev, prevStep: null });
      if (prev === "browsing")  return { reply: MAIN_MENU };
      if (prev === "demo_menu") return { reply: buildDemoMenu(state.exploredPaths ?? [], state.vertical ?? "default") };
      if (prev === "demo_path" && state.path) return { reply: PATHS[state.path].getIntro(state.vertical ?? "default") };
    }
    transition(convo, "browsing");
    return { reply: MAIN_MENU };
  }

  const state = getState(convo);

  // ── First contact ──────────────────────────────────────────────────────────
  if (isNew || !state.step || state.step === "start") {
    transition(convo, "browsing", {
      qaCount: 0, path: null, exploredPaths: [], vertical: "default",
      leadName: null, leadBusiness: null,
    });
    console.log(`[DEMO] New visitor — ${fromNumber}`);
    return { reply: OPENER };
  }

  // ── browsing — main product assistant mode ─────────────────────────────────
  if (state.step === "browsing") {
    const vertical = state.vertical ?? "default";
    const qaCount  = state.qaCount ?? 0;

    // YES intent or "4" → lead capture
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }

    // "2" → See a demo → ask business type
    const path = detectPath(body);
    if (path === 2) {
      transition(convo, "awaiting_demo_type");
      return { reply: `What kind of business are you in?\n\nThis lets me show you the most relevant example.\n(e.g. tours, salon, restaurant, gym, contractor)` };
    }

    // "1" → What Highmark does
    if (path === 1) {
      setState(convo, { qaCount: qaCount + 1 });
      return { reply: `${HM.overview}\n\n${qaFollowon("overview", qaCount + 1)}` };
    }

    // "3" → Pricing
    if (path === 3) {
      setState(convo, { qaCount: qaCount + 1 });
      return { reply: `${HM.pricing}\n\n${qaFollowon("pricing", qaCount + 1)}` };
    }

    // Direct question about Highmark
    const qIntent = detectQuestionIntent(body);
    if (qIntent) {
      setState(convo, { qaCount: qaCount + 1 });
      return { reply: `${HM[qIntent]}\n\n${qaFollowon(qIntent, qaCount + 1)}` };
    }

    // Fallback — rephrase the main menu
    return { reply: MAIN_MENU };
  }

  // ── awaiting_demo_type ─────────────────────────────────────────────────────
  if (state.step === "awaiting_demo_type") {
    // YES or "4" → skip demo, go to lead capture
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }
    // Path number typed directly → use default vertical
    const directPath = detectPath(body);
    if (directPath) {
      transition(convo, "demo_path", { path: directPath, exploredPaths: addExplored([], directPath), vertical: "default" });
      return { reply: PATHS[directPath].getIntro("default") };
    }
    // Free-form business description → detect vertical → show demo menu
    const vertical = detectVertical(body);
    const v        = VERTICALS[vertical];
    transition(convo, "demo_menu", { vertical, exploredPaths: [] });
    console.log(`[DEMO] Vertical: ${vertical} (${v.label}) — ${fromNumber}`);
    return { reply: buildDemoMenu([], vertical) };
  }

  // ── demo_menu ─────────────────────────────────────────────────────────────
  if (state.step === "demo_menu") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "demo_path", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    return { reply: buildDemoMenu(state.exploredPaths ?? [], vertical) };
  }

  // ── demo_path → any reply shows followup ──────────────────────────────────
  if (state.step === "demo_path") {
    const vertical = state.vertical ?? "default";
    if (!state.path) { transition(convo, "demo_menu"); return { reply: buildDemoMenu(state.exploredPaths ?? [], vertical) }; }
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Love it! What's your name?" };
    }
    transition(convo, "demo_followup");
    return { reply: buildFollowupCta(state.path, state.exploredPaths ?? [], vertical) };
  }

  // ── demo_followup ─────────────────────────────────────────────────────────
  if (state.step === "demo_followup") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Awesome! What's your name?" };
    }
    const path = detectPath(body);
    if (path && path !== state.path) {
      transition(convo, "demo_path", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    if (isNoIntent(body)) {
      transition(convo, "browsing");
      return { reply: MAIN_MENU };
    }
    transition(convo, "demo_cta");
    return { reply: `This is exactly how Highmark works for your business.\n\nWant me to set this up?\n\nReply YES to get started. Or reply MENU to explore more.` };
  }

  // ── demo_cta ───────────────────────────────────────────────────────────────
  if (state.step === "demo_cta") {
    const vertical = state.vertical ?? "default";
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Perfect! What's your name?" };
    }
    if (isNoIntent(body)) {
      transition(convo, "browsing");
      return { reply: MAIN_MENU };
    }
    const path = detectPath(body);
    if (path) {
      transition(convo, "demo_path", { path, exploredPaths: addExplored(state.exploredPaths, path) });
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
        `Q&A turns: ${s.qaCount ?? 0}`,
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
      transition(convo, "demo_path", { path, exploredPaths: addExplored(state.exploredPaths, path) });
      return { reply: PATHS[path].getIntro(vertical) };
    }
    return { reply: "We'll reach out shortly! Reply MENU to keep exploring, or START OVER to restart." };
  }

  // Fallback
  transition(convo, "browsing", { qaCount: 0, vertical: "default", exploredPaths: [] });
  return { reply: OPENER };
}
