// siteContent.js — Website content management for the Highmark marketing site
//
// DEFAULTS contains the full baseline content for every editable section.
// DB rows contain only the overrides — the app deep-merges DB on top of DEFAULTS.
// If the DB is empty or unavailable, the site renders from DEFAULTS (safe fallback).
//
// Sections: hero · how_it_works · demo_band · pricing · faq · final_cta · announcement
//
// To add a new editable section:
//   1. Add its key to SECTION_KEYS
//   2. Add its default content to DEFAULTS
//   3. The admin endpoints and public API pick it up automatically
//
// To update pricing without a deploy:
//   PATCH /admin/site-content/pricing   { "tiers": [...] }

export const SECTION_KEYS = [
  "hero",
  "how_it_works",
  "demo_band",
  "pricing",
  "faq",
  "final_cta",
  "announcement",
];

export const DEFAULTS = {
  hero: {
    badge: "🏔 Live demo available now — no signup required",
    headline: "Stop losing customers at 11pm.",
    subheadline:
      "Highmark answers every customer inquiry automatically — on SMS and your website — so you never miss a lead because you were on the mountain.",
    primary_cta_text: "📱 See it live — text DEMO to (866) 890-6657",
    secondary_cta_text: "See how it works ↓",
    demo_phone: "+18668906657",
    demo_display: "(866) 890-6657",
    demo_body: "DEMO",
    proof_items: [
      "SMS + web chat",
      "Live in 1–3 days",
      "Used by outdoor businesses across Colorado",
    ],
  },

  how_it_works: {
    headline: "Up and running in days, not weeks",
    subheadline:
      "Highmark connects to your existing business in three steps. No code required.",
    steps: [
      {
        num: "1",
        title: "Connect your business",
        body:
          "We scrape your website, configure your bot persona, and assign a dedicated Twilio number. Takes 1–3 business days.",
      },
      {
        num: "2",
        title: "Customers text or chat",
        body:
          "They text your number or message your website — Highmark replies in seconds, 24/7, trained on your business.",
      },
      {
        num: "3",
        title: "You grow",
        body:
          "Lead notifications hit your phone. Bookings confirm automatically. Send SMS campaigns to re-engage your list. Your team only steps in when it truly matters.",
      },
    ],
  },

  demo_band: {
    headline: "See it work right now",
    subheadline:
      "Text the demo number below. Ask anything — pricing, availability, how it works. Highmark will respond in seconds.",
    hint: "Text anything to start · Works on any phone",
    cta_text: "📱 Open in Messages",
  },

  pricing: {
    headline: "Start free. Scale when you're ready.",
    subheadline:
      "No long-term contracts. No per-message fees. Most clients go live in 1–3 days.",
    footnote:
      "Pricing shown is per client. Volume discounts available for agencies.",
    tiers: [
      {
        id: "free",
        name: "Free",
        price: 0,
        period: "forever, limited",
        description:
          "Try Highmark with your business — no risk, no credit card.",
        featured: false,
        badge: null,
        cta_text: "Text the demo →",
        cta_href: "sms:+18668906657?body=DEMO",
        cta_style: "ghost",
        features: [
          { text: "Basic SMS Q&A chatbot", included: true },
          { text: "Up to 100 messages/month", included: true },
          { text: "Shared Twilio number", included: true },
          { text: "FAQ answering from your website", included: true },
          { text: "Lead capture", included: false },
          { text: "CRM & contact records", included: false },
          { text: "Booking integration", included: false },
          { text: "Campaign messaging", included: false },
          { text: "Follow-up automation", included: false },
        ],
      },
      {
        id: "growth",
        name: "Growth",
        price: 249,
        period: "billed monthly · setup included",
        description:
          "Everything you need to capture every lead and never miss a customer.",
        featured: true,
        badge: "Most Popular",
        cta_text: "Get started →",
        cta_href: "mailto:hello@whiteoutsolutions.co?subject=Highmark%20Growth%20Plan",
        cta_style: "primary",
        features: [
          { text: "Everything in Free", included: true },
          { text: "Unlimited messages", included: true },
          { text: "Dedicated Twilio number", included: true },
          { text: "Lead capture + team notifications", included: true },
          { text: "CRM — contacts, tags, opt-in/out", included: true },
          { text: "Custom bot persona & tone", included: true },
          { text: "Weekly website knowledge refresh", included: true },
          { text: "Follow-up automation", included: true },
          { text: "Live booking integration", included: false },
          { text: "Campaign messaging", included: false },
        ],
      },
      {
        id: "pro",
        name: "Pro",
        price: 449,
        period: "billed monthly · setup included",
        description:
          "Full platform. Real-time availability, booking automation, and more.",
        featured: false,
        badge: null,
        cta_text: "Talk to us →",
        cta_href: "mailto:hello@whiteoutsolutions.co?subject=Highmark%20Pro%20Plan",
        cta_style: "ghost",
        features: [
          { text: "Everything in Growth", included: true },
          { text: "Live booking availability", included: true },
          { text: "FareHarbor integration", included: true },
          { text: "Booking confirmation texts", included: true },
          { text: "Campaign messaging — unlimited sends", included: true },
          { text: "Audience targeting (new, engaged, all leads)", included: true },
          { text: "Priority support", included: true },
          { text: "Analytics dashboard", included: true },
        ],
      },
    ],
  },

  faq: {
    headline: "Common questions",
    items: [
      {
        q: "How long does setup take?",
        a: "Most businesses are live in 1–3 business days. We handle everything: Twilio number setup, website scraping, bot configuration, and a test pass before going live. You don't touch any code.",
      },
      {
        q: "What do my customers need to do differently?",
        a: "Nothing. They text your business number exactly as they do today. Highmark replies automatically — they may not even know they're talking to an AI until they ask for a person.",
      },
      {
        q: "What happens when a customer asks something the bot can't answer?",
        a: "Highmark handles the vast majority of questions automatically. For anything complex, or when a customer explicitly asks for a person, Highmark routes to your team immediately with context already captured.",
      },
      {
        q: "Does it work with FareHarbor?",
        a: "Yes — Pro plan includes FareHarbor integration with live availability, direct booking links, and automated booking confirmation texts. Growth plan includes booking link support without live availability.",
      },
      {
        q: "What if I don't have a website?",
        a: "No problem. You can provide a FAQ document, a list of services, hours, and policies during setup. Highmark uses that as its knowledge base. A website isn't required to get started.",
      },
      {
        q: "Is it TCPA compliant?",
        a: "Yes. Highmark has built-in STOP/UNSTOP handling, opt-out tracking, HELP responses, and compliant messaging frequency. It follows TCPA best practices out of the box.",
      },
      {
        q: "Can I try it before committing?",
        a: "Absolutely. Text our demo number — (866) 890-6657 — right now and experience the full product Q&A flow. No signup, no credit card. The Free tier also lets you test with your own business before upgrading.",
      },
      {
        q: "Can I send outbound texts to my leads?",
        a: "Yes — Pro plan includes campaign messaging. Write a message, pick an audience (all leads, new contacts, or engaged prospects), and send. Messages go out at a safe pace with opt-out handling built in. Perfect for promos, seasonal offers, or re-engagement.",
      },
      {
        q: "Who is Highmark built for?",
        a: "Any customer-facing business that handles a high volume of repetitive inbound questions — tour operators, rental companies, service businesses, salons, gyms, restaurants, contractors. If customers text you, Highmark can handle it.",
      },
    ],
  },

  final_cta: {
    headline: "Your customers are texting. Your leads are going cold.",
    subheadline:
      "Highmark answers every text, captures every lead, and sends campaigns that bring them back — automatically. See it work in the next 30 seconds.",
    primary_cta_text: "📱 Text DEMO to (866) 890-6657",
    secondary_cta_text: "Talk to us →",
    secondary_cta_href: "mailto:hello@whiteoutsolutions.co",
  },

  // Set to null or omit to hide the banner entirely.
  // When set, renders a top-of-page announcement strip.
  // { text, style: "info|warning|success", link_text, link_href }
  announcement: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache — avoids a DB query on every page load
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cache = null;
let _cacheAt = 0;

export function invalidateSiteContentCache() {
  _cache = null;
  _cacheAt = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadSiteContent — returns DEFAULTS deeply merged with any DB overrides.
// Safe to call even if supabase is null / DB is unavailable.
// ─────────────────────────────────────────────────────────────────────────────
export async function loadSiteContent(supabase) {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  const result = buildDefaults();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("site_content")
        .select("section, content");

      if (!error && data) {
        for (const row of data) {
          if (row.section && row.content && SECTION_KEYS.includes(row.section)) {
            // Shallow merge: DB content overrides the matching section default.
            // For nested arrays (tiers, items, steps) the DB value replaces entirely
            // when present — admins supply the full array in those fields.
            result[row.section] = { ...DEFAULTS[row.section], ...row.content };
          }
        }
      }
    } catch {
      // DB unavailable — fall through to defaults
    }
  }

  _cache = result;
  _cacheAt = now;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// getSiteSection — returns a single section merged with its default.
// ─────────────────────────────────────────────────────────────────────────────
export async function getSiteSection(supabase, section) {
  try {
    const { data } = await supabase
      .from("site_content")
      .select("content")
      .eq("section", section)
      .maybeSingle();

    const base = DEFAULTS[section] ?? null;
    if (!data) return base;
    return base ? { ...base, ...data.content } : data.content;
  } catch {
    return DEFAULTS[section] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateSiteSection — upsert a section, then bust cache.
// ─────────────────────────────────────────────────────────────────────────────
export async function updateSiteSection(supabase, section, content) {
  const { data, error } = await supabase
    .from("site_content")
    .upsert(
      { section, content, updated_at: new Date().toISOString() },
      { onConflict: "section" }
    )
    .select()
    .single();

  if (error) throw error;
  invalidateSiteContentCache();
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Returns a fresh deep copy of DEFAULTS (prevents mutation across callers)
function buildDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}
