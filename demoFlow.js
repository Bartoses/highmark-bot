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
//   vertical:      string    — detected category (see VERTICALS keys)
//   subtypeKey:    string|null — specific subtype (see SUBTYPE_EXAMPLES keys)
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
import { loadSiteContent } from "./siteContent.js";

// ── Highmark product knowledge ───────────────────────────────────────────────
// Static defaults used when site_content DB is unavailable.
// buildHmFromSiteContent() overrides pricing + features from the CMS at runtime,
// so a site editor update automatically updates demo bot answers too.

const HM_DEFAULTS = {
  overview:
`Highmark is an AI SMS concierge. It connects to your business — website, booking system, whatever you use — and handles customer texts automatically. Q&A, lead capture, booking links, confirmations. 24/7. No staff needed.`,

  pricing:
`Three tiers:\n\n• Free ($0) — 24/7 Q&A, up to 100 msgs/mo\n• Growth ($249/mo) — unlimited msgs, lead capture, CRM, dedicated number\n• Pro ($449/mo) — everything + live booking integration (FareHarbor)\n\nSetup included. No per-message fees. Most clients live in 1–3 days.`,

  setup:
`Setup takes 1–3 days:\n1. Twilio number assigned\n2. Your website scraped for Q&A knowledge\n3. Bot persona + tone configured to match your brand\n4. Test pass → go live\n\nNo code. We handle everything.`,

  features:
`What's live today:\n• 24/7 Q&A from your website\n• Lead capture + instant team notification\n• Live booking availability (FareHarbor, Pro tier)\n• CRM: contacts, tags, opt-in/out\n• Booking confirmations + follow-up texts`,

  roadmap:
`Coming next:\n• Campaign messaging (scheduled SMS to customer segments)\n• Analytics dashboard\n• Additional booking integrations (Checkfront, Peek, Rezdy)\n• Multi-channel (web chat, Instagram DM)`,

  scraping:
`Yes. Highmark scrapes your website weekly — pricing, FAQs, hours, policies — and keeps its knowledge current. You can also provide a custom FAQ or static facts during setup. No website required to get started.`,

  how_it_works:
`Customer texts your number → Highmark reads the message → checks your business knowledge → replies in ~4 seconds. Complex questions or "talk to a person" requests route to your team instantly.`,

  integrations:
`Live integrations: FareHarbor (booking), Twilio (SMS), any public website (knowledge scraping).\n\nRoadmap: Checkfront, Peek, Rezdy, Square, and calendar integrations.`,
};

// Build the live HM object from site_content (DB) merged with static defaults.
// Called once per demo interaction — cache in siteContent.js handles DB load.
async function buildHm(supabase) {
  try {
    const sc = await loadSiteContent(supabase);

    // Pricing: format from structured tiers in site_content
    let pricing = HM_DEFAULTS.pricing;
    if (Array.isArray(sc.pricing?.tiers) && sc.pricing.tiers.length) {
      const lines = sc.pricing.tiers.map(t => {
        const price = t.price === 0 ? "Free" : `$${t.price}/mo`;
        // First included feature as the tier tagline
        const tagline = (t.features || []).find(f => f.included && f.text !== `Everything in ${t.name}`)?.text || t.description || "";
        return `• ${t.name} (${price})${tagline ? ` — ${tagline}` : ""}`;
      }).join("\n");
      pricing = `${lines}\n\nSetup included. No per-message fees. Most clients live in 1–3 days.`;
    }

    // Features: pull from Growth tier feature list (most representative)
    let features = HM_DEFAULTS.features;
    const growthTier = sc.pricing?.tiers?.find(t => t.id === "growth");
    if (growthTier?.features?.length) {
      const included = growthTier.features.filter(f => f.included).map(f => `• ${f.text}`);
      if (included.length) features = `What's included in Growth:\n${included.join("\n")}`;
    }

    // How it works: pull from site_content if steps are set
    let how_it_works = HM_DEFAULTS.how_it_works;
    if (Array.isArray(sc.how_it_works?.steps) && sc.how_it_works.steps.length) {
      how_it_works = sc.how_it_works.steps.map(s => `${s.num}. ${s.title} — ${s.body}`).join("\n");
    }

    return { ...HM_DEFAULTS, pricing, features, how_it_works };
  } catch {
    return HM_DEFAULTS;
  }
}

// Module-level fallback — used synchronously before the async build completes
const HM = { ...HM_DEFAULTS };

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
// These are GENERIC fallbacks — subtype-specific examples in SUBTYPE_EXAMPLES
// override them when the user's exact business type is recognized.

const VERTICALS = {
  outdoor: {
    label: "tour or rental company",
    menuContext: "Built for tour operators and rental companies.",
    qa: {
      customerQ: `"What do you have available this weekend?"`,
      botA:      `"We have morning and afternoon tours Saturday — guides included. Want me to check availability for your group size?"`,
    },
    lead: {
      scenario: `"Just looking at options for a group trip next month."`,
      outcome:  `"Perfect timing — how many in your group? I'll check availability and hold a spot for you."`,
    },
    booking: {
      scenario: `"I want to book a guided tour for Saturday, 4 people."`,
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

// ── Subtype examples ──────────────────────────────────────────────────────────
// Specific examples that override the generic VERTICALS fallback when the user's
// exact business type is recognized. Each entry has a keyword matcher, a label,
// and qa/lead/booking scenarios.

const SUBTYPE_EXAMPLES = {
  // ── Outdoor subtypes ──────────────────────────────────────────────────────
  bike: {
    match: /\bbike\b|\bcycl|\bMTB\b|mountain.?bike|bike.?tour|bike.?rental/i,
    category: "outdoor",
    label: "bike tour or rental company",
    qa: {
      customerQ: `"What's the easiest trail for a first-timer?"`,
      botA:      `"Our beginner loop is 8 miles, mostly flat — helmet and bike included. Tours run daily at 9am and 1pm. Want me to check Saturday availability?"`,
    },
    lead: {
      scenario: `"We're a group of 8, not sure everyone's the same skill level."`,
      outcome:  `"Easy — I can split you across two trail options. What date are you thinking? I'll hold the spots."`,
    },
    booking: {
      scenario: `"I want to book a guided mountain bike tour, 2 people this Saturday."`,
      outcome:  `Highmark checks guide availability, answers gear questions, confirms the booking, sends a reminder — done in 3 texts.`,
    },
    inquiries: 15, bookings: 7, leads: 5,
  },
  snowmobile: {
    match: /snowmobile|sled\b|sledding|snowcoach/i,
    category: "outdoor",
    label: "snowmobile tour and rental company",
    qa: {
      customerQ: `"What trails are open and how's the snow?"`,
      botA:      `"Trails are fully open — 8\" fresh snow last night. Guided tours from $249, self-guided rentals from $199. Want to check Saturday availability?"`,
    },
    lead: {
      scenario: `"Just looking at options for a group trip next month."`,
      outcome:  `"Perfect timing — how many in your group? I'll check availability and hold spots."`,
    },
    booking: {
      scenario: `"I want to book the guided snowmobile tour for Saturday, 4 people."`,
      outcome:  `Highmark shows open slots, answers questions, sends a direct booking link — confirmed in 3 texts.`,
    },
    inquiries: 14, bookings: 6, leads: 5,
  },
  raft: {
    match: /\braft\b|rafting|\bkayak\b|kayaking|\bcanoe\b|canoeing|paddle.?board|river.?trip|whitewater/i,
    category: "outdoor",
    label: "rafting or river guide company",
    qa: {
      customerQ: `"How intense is the Class 3 section? We have a 12-year-old."`,
      botA:      `"Class 3 is a great family run — splashy but manageable for kids 10+. Wetsuit and guide included. Want to book the 10am launch?"`,
    },
    lead: {
      scenario: `"Trying to plan a bachelorette river trip for 10 people."`,
      outcome:  `"Love it — what date? I can hold a private raft and check if we need a second guide for your group."`,
    },
    booking: {
      scenario: `"I want to book a half-day rafting trip for 4 adults this Saturday."`,
      outcome:  `Highmark confirms availability, collects waiver info, sends a booking link — all over text.`,
    },
    inquiries: 18, bookings: 8, leads: 6,
  },
  fishing: {
    match: /\bfish\b|fishing|angling|fly.?fish|fishing.?guide|fishing.?charter/i,
    category: "outdoor",
    label: "fishing guide service",
    qa: {
      customerQ: `"What's the best time of year for trout on this river?"`,
      botA:      `"Late May through early July is prime — hatches are incredible and water clarity is ideal. Full-day float trips from $450. Want to check available dates?"`,
    },
    lead: {
      scenario: `"Haven't picked dates yet, just scoping out options."`,
      outcome:  `"No rush — where are you coming from? I can suggest the best window based on conditions and your schedule."`,
    },
    booking: {
      scenario: `"I want to book a full-day fly fishing float trip for 2."`,
      outcome:  `Highmark checks guide availability, confirms the gear list, sends a booking link — confirmed over text.`,
    },
    inquiries: 11, bookings: 5, leads: 4,
  },
  ski: {
    match: /\bski\b|\bskiing\b|snowboard|ski.?lesson|ski.?rental|ski.?school/i,
    category: "outdoor",
    label: "ski rental or lesson company",
    qa: {
      customerQ: `"Do you have rentals for a total beginner? I've never skied."`,
      botA:      `"Yes — beginner package includes boots, skis, poles, and a 2-hour group lesson. All ages. Want to lock in a morning slot?"`,
    },
    lead: {
      scenario: `"We're a family of 5, kids are all different skill levels."`,
      outcome:  `"Got it — let me put together the right package for each age group. What dates are you visiting? I'll check lesson availability."`,
    },
    booking: {
      scenario: `"I want to book ski rentals and a lesson for 3 adults next Friday."`,
      outcome:  `Highmark confirms equipment sizes, books the lesson time, sends a confirmation — no phone call needed.`,
    },
    inquiries: 20, bookings: 9, leads: 6,
  },
  atv: {
    match: /\batv\b|\brzr\b|off.?road|\butv\b|side.?by.?side|jeep.?tour|dune.?buggy/i,
    category: "outdoor",
    label: "ATV/UTV rental or tour company",
    qa: {
      customerQ: `"Do I need experience to rent a RZR? We've never driven one."`,
      botA:      `"Nope — a quick orientation is included with every rental. Side-by-sides are intuitive, just follow the trail map. Helmets and insurance included. Want to check availability?"`,
    },
    lead: {
      scenario: `"Not sure if we want a guided tour or a self-drive rental."`,
      outcome:  `"Guided tours cover more terrain and take the navigation off your plate. Self-drive is more flexible. How many in your group? I'll help you decide."`,
    },
    booking: {
      scenario: `"I want to book a RZR rental for Saturday, 2 vehicles."`,
      outcome:  `Highmark confirms vehicle availability, walks through the insurance and fuel policy, sends a booking link — done over text.`,
    },
    inquiries: 16, bookings: 7, leads: 5,
  },
  hiking: {
    match: /\bhike\b|hiking|trail.?tour|guided.?hike|backpack/i,
    category: "outdoor",
    label: "hiking or trail tour company",
    qa: {
      customerQ: `"Is the summit trail doable for someone who doesn't hike much?"`,
      botA:      `"It's 6 miles with 1,200ft elevation — moderate, doable with trekking poles. Our guide sets a comfortable pace. Want to book the 8am departure?"`,
    },
    lead: {
      scenario: `"We want to do something outdoors but not sure which hike fits us."`,
      outcome:  `"Happy to match you — how many in your group and what's the fitness level? I'll suggest the right trail."`,
    },
    booking: {
      scenario: `"I want to book a guided summit hike for 3 people this Saturday."`,
      outcome:  `Highmark checks guide availability, confirms what to bring, sends a booking link — confirmed in a few texts.`,
    },
    inquiries: 13, bookings: 6, leads: 4,
  },
  zipline: {
    match: /zipline|zip.?line|canopy.?tour|zip.?tour/i,
    category: "outdoor",
    label: "zipline or canopy tour company",
    qa: {
      customerQ: `"Is there a weight limit? My dad wants to come but he's a bigger guy."`,
      botA:      `"Weight limit is 250 lbs — our harnesses are rated for it and guides check fit for everyone. Safety briefing included. Want to book a time?"`,
    },
    lead: {
      scenario: `"Trying to book something for a family reunion, about 15 people."`,
      outcome:  `"We can do private group tours — what date? I'll check if we can hold the whole course for you."`,
    },
    booking: {
      scenario: `"I want to book a zipline tour for 4 adults Saturday afternoon."`,
      outcome:  `Highmark checks availability, confirms the safety requirements, sends a booking link — done in a few texts.`,
    },
    inquiries: 14, bookings: 7, leads: 4,
  },
  // ── Appointment subtypes ──────────────────────────────────────────────────
  med_spa: {
    match: /med.?spa|botox|filler|laser|aesthetic|injection|medspa/i,
    category: "appointments",
    label: "medical spa or aesthetics clinic",
    qa: {
      customerQ: `"How long does a Botox appointment usually take?"`,
      botA:      `"About 30 minutes from check-in to checkout — no downtime. We're open Tuesday through Saturday. Want to book a consultation?"`,
    },
    lead: {
      scenario: `"I'm interested but want to know what to expect first."`,
      outcome:  `"Totally understandable — what treatment are you curious about? I can walk you through the process and pricing."`,
    },
    booking: {
      scenario: `"I want to schedule a Botox appointment for next week."`,
      outcome:  `Highmark checks the injector's schedule, confirms the time, sends a reminder the day before.`,
    },
    inquiries: 24, bookings: 12, leads: 8,
  },
  tattoo: {
    match: /tattoo|piercing|ink\b|body.?art/i,
    category: "appointments",
    label: "tattoo or piercing studio",
    qa: {
      customerQ: `"How far out are you booked? I want to get something done next month."`,
      botA:      `"We have openings in 3 weeks — walk-ins available for small pieces most weekdays. Want to consult on your idea first?"`,
    },
    lead: {
      scenario: `"I have a design in mind but want to get a price estimate first."`,
      outcome:  `"Happy to quote it — can you describe the size and placement? I'll connect you with the right artist."`,
    },
    booking: {
      scenario: `"I want to book a consultation for a sleeve design."`,
      outcome:  `Highmark matches you with an artist, books the consult, sends a confirmation — all over text.`,
    },
    inquiries: 18, bookings: 9, leads: 6,
  },
};

// Detect a specific subtype from the user's raw business description.
// Returns a SUBTYPE_EXAMPLES key, or null if no specific match is found.
// Falls back to the category-level VERTICALS example if null.
export function detectSubtype(text) {
  for (const [key, entry] of Object.entries(SUBTYPE_EXAMPLES)) {
    if (entry.match.test(text)) return key;
  }
  return null;
}

// Merge category + subtype into a single context object used by all example builders.
// Subtype fields take precedence over category fields when both are present.
function getVerticalContext(vertical, subtypeKey = null) {
  const cat = VERTICALS[vertical] || VERTICALS.default;
  const sub = subtypeKey ? SUBTYPE_EXAMPLES[subtypeKey] : null;
  if (!sub) return cat;
  return {
    label:      sub.label,
    menuContext: cat.menuContext,
    qa:         sub.qa,
    lead:       sub.lead,
    booking:    sub.booking,
    inquiries:  sub.inquiries ?? cat.inquiries,
    bookings:   sub.bookings  ?? cat.bookings,
    leads:      sub.leads     ?? cat.leads,
  };
}

// ── Demo feature paths ────────────────────────────────────────────────────────

const PATHS = {
  1: {
    label:    "Q&A",
    menuLine: "See Q&A in action",
    getIntro(vertical, exploredPaths = [], subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `Here's how Highmark handles Q&A for a ${v.label}:\n\n` +
        `Customer: ${v.qa.customerQ}\n\n` +
        `Highmark: ${v.qa.botA}\n\n` +
        `⚡ ~4 seconds. No staff needed.\n\n` +
        getNextPathOptions(1, exploredPaths)
      );
    },
    getFollowup(vertical, subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `Every FAQ and pricing question answered 24/7 — pulled from your website.\n\n` +
        `~${v.inquiries} after-hours inquiries a week that used to go unanswered. All handled automatically.`
      );
    },
  },
  2: {
    label:    "Lead Capture",
    menuLine: "See lead capture in action",
    getIntro(vertical, exploredPaths = [], subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `Here's lead capture in action:\n\n` +
        `Customer: ${v.lead.scenario}\n\n` +
        `Highmark: ${v.lead.outcome}\n\n` +
        `✅ Lead saved. You're notified instantly.\n\n` +
        getNextPathOptions(2, exploredPaths)
      );
    },
    getFollowup(vertical, subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `You get a text the moment a lead comes in — name, number, what they need.\n\n` +
        `~${v.leads} leads/week that would have just bounced. Zero spreadsheets.`
      );
    },
  },
  3: {
    label:    "Booking",
    menuLine: "See the booking flow",
    getIntro(vertical, exploredPaths = [], subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `Here's the booking flow:\n\n` +
        `Customer: ${v.booking.scenario}\n\n` +
        `${v.booking.outcome}\n\n` +
        getNextPathOptions(3, exploredPaths)
      );
    },
    getFollowup(vertical, subtypeKey = null) {
      const v = getVerticalContext(vertical, subtypeKey);
      return (
        `Full booking flow, zero friction.\n\n` +
        `~${v.bookings} more bookings/week from people who would have texted a competitor and heard nothing.`
      );
    },
  },
};

// Returns the explicit next-step options for the end of a path intro.
// Only shows paths not yet explored and not the current one.
function getNextPathOptions(currentPath, exploredPaths = []) {
  const remaining = [1, 2, 3].filter(n => n !== currentPath && !exploredPaths.includes(n));
  if (remaining.length === 0) return "Reply YES to get this for your business.";
  const opts = remaining.map(n => `${n}️⃣ ${PATHS[n].menuLine}`).join("  ");
  return `${opts}\n\nOr reply YES to get started.`;
}

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

function buildRevenueSimulation(vertical, subtypeKey = null) {
  const v = getVerticalContext(vertical, subtypeKey);
  return (
    `📊 Similar ${v.label}: ~${v.inquiries} inquiries/wk → ` +
    `${v.bookings} bookings + ${v.leads} leads\n` +
    `*(illustrative — results vary)*`
  );
}

// ── Post-path CTA builder ─────────────────────────────────────────────────────

function buildFollowupCta(path, exploredPaths, vertical = "default", subtypeKey = null) {
  const unexplored = [1, 2, 3].filter((n) => !exploredPaths.includes(n) && n !== path);
  const lines      = [PATHS[path].getFollowup(vertical, subtypeKey), ""];

  if (exploredPaths.length === 1) lines.push(buildRevenueSimulation(vertical, subtypeKey), "");

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
    step: "start", qaCount: 0, vertical: "default", subtypeKey: null,
    path: null, exploredPaths: [],
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

  // Load live product knowledge from site_content (same source as the website).
  // Falls back to HM_DEFAULTS if DB unavailable. Cached for 5 min per siteContent.js.
  const hm = await buildHm(supabase);

  console.log(`[DEMO] ${fromNumber} → "${body.slice(0, 40)}"`);

  // ── Global: reset ──────────────────────────────────────────────────────────
  if (RESET_KEYWORDS.has(bodyUpper)) {
    transition(convo, "browsing", {
      qaCount: 0, path: null, exploredPaths: [], vertical: "default", subtypeKey: null,
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
      if (prev === "demo_path" && state.path) return { reply: PATHS[state.path].getIntro(state.vertical ?? "default", state.exploredPaths ?? [], state.subtypeKey ?? null) };
    }
    transition(convo, "browsing");
    return { reply: MAIN_MENU };
  }

  const state = getState(convo);

  // ── First contact ──────────────────────────────────────────────────────────
  if (isNew || !state.step || state.step === "start") {
    transition(convo, "browsing", {
      qaCount: 0, path: null, exploredPaths: [], vertical: "default", subtypeKey: null,
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
      return { reply: `${hm.overview}\n\n${qaFollowon("overview", qaCount + 1)}` };
    }

    // "3" → Pricing
    if (path === 3) {
      setState(convo, { qaCount: qaCount + 1 });
      return { reply: `${hm.pricing}\n\n${qaFollowon("pricing", qaCount + 1)}` };
    }

    // Direct question about Highmark
    const qIntent = detectQuestionIntent(body);
    if (qIntent) {
      setState(convo, { qaCount: qaCount + 1 });
      return { reply: `${hm[qIntent] ?? HM_DEFAULTS[qIntent] ?? hm.overview}\n\n${qaFollowon(qIntent, qaCount + 1)}` };
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
      const ep = addExplored([], directPath);
      transition(convo, "demo_path", { path: directPath, exploredPaths: ep, vertical: "default" });
      return { reply: PATHS[directPath].getIntro("default", ep) };
    }
    // Free-form business description → detect vertical + subtype → show tailored Q&A
    const vertical   = detectVertical(body);
    const subtypeKey = detectSubtype(body);
    const vc         = getVerticalContext(vertical, subtypeKey);
    const exploredPaths = [1]; // Q&A shown immediately as the first example
    transition(convo, "demo_path", { vertical, subtypeKey, path: 1, exploredPaths });
    console.log(`[DEMO] Vertical: ${vertical}${subtypeKey ? ` / ${subtypeKey}` : ""} (${vc.label}) — ${fromNumber}`);
    return { reply: PATHS[1].getIntro(vertical, exploredPaths, subtypeKey) };
  }

  // ── demo_menu ─────────────────────────────────────────────────────────────
  if (state.step === "demo_menu") {
    const vertical   = state.vertical   ?? "default";
    const subtypeKey = state.subtypeKey ?? null;
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Let's get started! What's your name?" };
    }
    const path = detectPath(body);
    if (path) {
      const ep = addExplored(state.exploredPaths, path);
      transition(convo, "demo_path", { path, exploredPaths: ep });
      return { reply: PATHS[path].getIntro(vertical, ep, subtypeKey) };
    }
    return { reply: buildDemoMenu(state.exploredPaths ?? [], vertical) };
  }

  // ── demo_path → any reply shows followup ──────────────────────────────────
  if (state.step === "demo_path") {
    const vertical   = state.vertical   ?? "default";
    const subtypeKey = state.subtypeKey ?? null;
    if (!state.path) { transition(convo, "demo_menu"); return { reply: buildDemoMenu(state.exploredPaths ?? [], vertical) }; }
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Love it! What's your name?" };
    }
    transition(convo, "demo_followup");
    return { reply: buildFollowupCta(state.path, state.exploredPaths ?? [], vertical, subtypeKey) };
  }

  // ── demo_followup ─────────────────────────────────────────────────────────
  if (state.step === "demo_followup") {
    const vertical   = state.vertical   ?? "default";
    const subtypeKey = state.subtypeKey ?? null;
    if (isYesIntent(body)) {
      transition(convo, "lead_name");
      return { reply: "Awesome! What's your name?" };
    }
    const path = detectPath(body);
    if (path && path !== state.path) {
      const ep = addExplored(state.exploredPaths, path);
      transition(convo, "demo_path", { path, exploredPaths: ep });
      return { reply: PATHS[path].getIntro(vertical, ep, subtypeKey) };
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
    const vertical   = state.vertical   ?? "default";
    const subtypeKey = state.subtypeKey ?? null;
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
      const ep = addExplored(state.exploredPaths, path);
      transition(convo, "demo_path", { path, exploredPaths: ep });
      return { reply: PATHS[path].getIntro(vertical, ep, subtypeKey) };
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
        `Vertical: ${s.vertical ?? "default"}${s.subtypeKey ? ` / ${s.subtypeKey}` : ""}`,
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
    const vertical   = state.vertical   ?? "default";
    const subtypeKey = state.subtypeKey ?? null;
    if (isYesIntent(body)) {
      return { reply: "We'll be in touch very soon! Reply MENU to keep exploring the platform." };
    }
    const path = detectPath(body);
    if (path) {
      const ep = addExplored(state.exploredPaths, path);
      transition(convo, "demo_path", { path, exploredPaths: ep });
      return { reply: PATHS[path].getIntro(vertical, ep, subtypeKey) };
    }
    return { reply: "We'll reach out shortly! Reply MENU to keep exploring, or START OVER to restart." };
  }

  // Fallback
  transition(convo, "browsing", { qaCount: 0, vertical: "default", subtypeKey: null, exploredPaths: [] });
  return { reply: OPENER };
}
