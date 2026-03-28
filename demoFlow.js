// ─────────────────────────────────────────────────────────────────────────────
// DEMO FLOW — Guided sales demo for Highmark prospects (Chunk 7)
//
// Used when client.bookingMode === "demo" (the +18668906657 demo number).
// Deterministic state machine — no AI calls, no real APIs.
// All state lives in convo.bookingData._demo (persisted via saveConversation).
//
// Steps:
//   null / "start"   → show guided opener
//   "awaiting_path"  → waiting for 1, 2, or 3
//   "path_intro"     → showing path intro
//   "cta"            → CTA shown, waiting for YES/NO
//   "lead_name"      → asked for name
//   "lead_business"  → asked for business name
//   "lead_website"   → asked for website (skippable)
//   "complete"       → done
// ─────────────────────────────────────────────────────────────────────────────

import { saveLead } from "./leads.js";

// Required opener — verbatim from spec
const DEMO_OPENER = `Welcome to Highmark 👋

I'm your AI SMS concierge.

I can show you how businesses use me to:
1️⃣ Answer customer questions instantly
2️⃣ Capture leads automatically
3️⃣ Drive more bookings

What do you want to see first?
Reply 1, 2, or 3.`;

const PATHS = {
  1: {
    name:     "Q&A",
    intro:    `Here's how I handle Q&A.\n\nCustomer texts "What are your hours?" I reply instantly — pulled from the business's website. Accurate, 24/7, no staff needed.`,
    followup: `Every FAQ, pricing question, and policy handled automatically. Staff only steps in when it truly matters.`,
  },
  2: {
    name:     "Lead Capture",
    intro:    `Here's how I capture leads.\n\nCustomer shows interest but isn't ready to book. I collect their info and alert your team instantly — no lead falls through.`,
    followup: `Every interested customer is followed up on. You get a text the moment a lead comes in. Zero spreadsheets.`,
  },
  3: {
    name:     "Booking",
    intro:    `Here's how I drive bookings.\n\nCustomer texts "I want to book." I show availability, answer questions, send a direct booking link — all in one thread.`,
    followup: `Full booking flow, zero phone tag. Most businesses see 20–30% more conversions vs. just a phone number.`,
  },
};

const CTA = `This is exactly how Highmark works for your business.\n\nWant me to set this up for you?\nReply YES and I'll get you started.`;

const RESET_KEYWORDS = new Set(["START OVER", "DEMO", "RESTART", "RESET"]);

// ── Intent detection ───────────────────────────────────────────────────────────

export function isYesIntent(body) {
  return /^(yes|yep|yeah|yup|sure|absolutely|interested|definitely|lets do it|let's do it|lets go|let's go|sign me up|i'm in|im in|pricing|how do i start|how much|get started|start|i want|set it up)/i.test(body.trim());
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

// ── State helpers ──────────────────────────────────────────────────────────────

function getState(convo) {
  return convo.bookingData?._demo ?? { step: "start", path: null, leadName: null, leadBusiness: null };
}

function setState(convo, state) {
  if (!convo.bookingData) convo.bookingData = {};
  convo.bookingData._demo = state;
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

  // ── Reset keywords ─────────────────────────────────────────────────────────
  if (RESET_KEYWORDS.has(bodyUpper)) {
    setState(convo, { step: "awaiting_path", path: null, leadName: null, leadBusiness: null });
    console.log(`[DEMO] Reset — ${fromNumber}`);
    return { reply: DEMO_OPENER };
  }

  const state = getState(convo);

  // ── First contact ──────────────────────────────────────────────────────────
  if (isNew || !state.step || state.step === "start") {
    setState(convo, { step: "awaiting_path", path: null, leadName: null, leadBusiness: null });
    console.log(`[DEMO] New visitor — ${fromNumber}`);
    return { reply: DEMO_OPENER };
  }

  // ── Path selection ─────────────────────────────────────────────────────────
  if (state.step === "awaiting_path") {
    const path = detectPath(body);
    if (path) {
      setState(convo, { ...state, step: "path_intro", path });
      console.log(`[DEMO] Path ${path} selected — ${fromNumber}`);
      return { reply: PATHS[path].intro };
    }
    return { reply: "Choose a path to see:\n1️⃣ Q&A  2️⃣ Lead Capture  3️⃣ Booking\nReply 1, 2, or 3." };
  }

  // ── After path intro → show followup + CTA ────────────────────────────────
  if (state.step === "path_intro") {
    const p = PATHS[state.path] ?? PATHS[1];
    setState(convo, { ...state, step: "cta" });
    return { reply: `${p.followup}\n\n${CTA}` };
  }

  // ── CTA response ───────────────────────────────────────────────────────────
  if (state.step === "cta") {
    if (isYesIntent(body)) {
      setState(convo, { ...state, step: "lead_name" });
      return { reply: "Awesome! What's your name?" };
    }
    if (isNoIntent(body)) {
      setState(convo, { ...state, step: "complete" });
      return { reply: "No worries! Text START OVER any time to try again. Questions? hello@whiteoutsolutions.co" };
    }
    // Nudge — re-show CTA
    return { reply: CTA };
  }

  // ── Lead capture: name ────────────────────────────────────────────────────
  if (state.step === "lead_name") {
    const name = body.slice(0, 60) || null;
    setState(convo, { ...state, step: "lead_business", leadName: name });
    return { reply: `Nice to meet you${name ? ", " + name : ""}! What's the name of your business?` };
  }

  // ── Lead capture: business ────────────────────────────────────────────────
  if (state.step === "lead_business") {
    const business = body.slice(0, 100) || null;
    setState(convo, { ...state, step: "lead_website", leadBusiness: business });
    return { reply: "Got it! Do you have a website? (Reply SKIP to skip)" };
  }

  // ── Lead capture: website → save + notify ────────────────────────────────
  if (state.step === "lead_website") {
    const website = /^(skip|none|no|nope|n\/a)$/i.test(body.trim()) ? null : body.trim().slice(0, 200);
    setState(convo, { ...state, step: "complete", leadWebsite: website });

    // Save to leads table
    if (supabase) {
      await saveLead(supabase, {
        clientId:     "highmark_demo",
        fromNumber,
        contactPhone: fromNumber,
        contactEmail: null,
        name:         state.leadName,
        service:      PATHS[state.path ?? 1]?.name ?? "demo",
        timeframe:    website ? `website: ${website}` : null,
        leadType:     "demo",
      }).catch((err) => console.error("[DEMO] saveLead error:", err.message));
    }

    // Notify admin
    const notifyPhone = getDemoNotifyPhone();
    if (notifyPhone && twilioClient && !testMode) {
      const lines = [
        "🏔 New Highmark demo lead!",
        `Name: ${state.leadName ?? "unknown"}`,
        `Business: ${state.leadBusiness ?? "unknown"}`,
        `Phone: ${fromNumber}`,
        `Demo path: ${PATHS[state.path ?? 1]?.name ?? "demo"}`,
      ];
      if (website) lines.push(`Website: ${website}`);
      twilioClient.messages.create({
        body: lines.join("\n"),
        from: toNumber,
        to:   notifyPhone,
      }).catch((err) => console.error("[DEMO] admin notify error:", err.message));
    }

    console.log(`[DEMO] Lead captured — ${fromNumber} | ${state.leadName} | ${state.leadBusiness}`);
    return { reply: "Awesome — we'll reach out to you shortly 🏔\n\nIn the meantime: usehighmark.com" };
  }

  // ── Complete ──────────────────────────────────────────────────────────────
  if (state.step === "complete") {
    return { reply: "Thanks for trying Highmark! Text START OVER to explore another demo path. Questions: hello@whiteoutsolutions.co" };
  }

  // Fallback — shouldn't be reached
  setState(convo, { step: "awaiting_path", path: null, leadName: null, leadBusiness: null });
  return { reply: DEMO_OPENER };
}
