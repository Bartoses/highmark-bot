// ─────────────────────────────────────────────────────────────────────────────
// HIGHMARK — Per-Client Configuration Registry
// Each entry defines all per-client behavior: capabilities, contact info,
// persona, knowledge sources, and booking mode.
//
// bookingMode values:
//   "fareharbor"   — real-time availability + booking menu (Tier 2)
//   "informational" — Q&A + handoff to phone, no booking API
//   "lead_capture"  — Q&A + collects name/email/need before routing to phone
//
// To add a new client:
//   1. Add an entry to CLIENTS keyed by client id
//   2. Set LONE_PINE_TWILIO_NUMBER (or equivalent) env var in Railway
//   3. No code changes required — resolveClient handles routing automatically
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENTS = {
  // ── Colorado Sled Rentals + Rabbit Ears Adventures ────────────────────────
  csr_rea: {
    id:    "csr_rea",
    slug:  "csr_rea",
    name:  "Colorado Sled Rentals + Rabbit Ears Adventures",
    botName: "Summit",
    tone:  "warm, stoked, genuinely local — like a guide who loves their job. Never robotic. Never a FAQ page.",

    // Twilio numbers that route to this client. The production number is hardcoded;
    // CSR_REA_TWILIO_NUMBER env var lets you override or add a second number.
    inboundPhones: [
      "+18668906657",
      process.env.CSR_REA_TWILIO_NUMBER,
    ].filter(Boolean),

    supportPhone: process.env.CLIENT_PHONE  || "(970) 439-1707",
    handoffPhone: process.env.HANDOFF_PHONE || process.env.CLIENT_PHONE || "(970) 439-1707",
    supportEmail: process.env.CLIENT_EMAIL  || null,
    address:      null,
    timezone:     "America/Denver",
    hours:        null, // hours are in the scraped KB for CSR/REA

    // Capability flags
    bookingMode:   "fareharbor",
    fareharborEnabled:        process.env.FAREHARBOR_ENABLED === "true",
    crmEnabled:               true,
    confirmationTextsEnabled: process.env.CONFIRMATIONS_ENABLED === "true",

    // FareHarbor companies operated by this client
    fareharborCompanies: [
      { id: "csr", shortname: "coloradosledrentals", userKeyEnv: "FAREHARBOR_USER_KEY_CSR", name: "Colorado Sled Rentals" },
      { id: "rea", shortname: "rabbitearsadventures", userKeyEnv: "FAREHARBOR_USER_KEY_REA", name: "Rabbit Ears Adventures" },
    ],

    // Website pages to scrape for business knowledge
    scrapeUrls: [
      "https://coloradosledrentals.com/",
      "https://coloradosledrentals.com/faq/",
      "https://coloradosledrentals.com/steamboat-summer/",
      "https://coloradosledrentals.com/kremmling-summer/",
      "https://www.rabbitearsadventures.com/",
      "https://www.rabbitearsadventures.com/faqs",
    ],

    // SNOTEL stations for live snow depth data
    snotelStations: [
      { id: "713:CO:SNTL", name: "Rabbit Ears Pass",           elevation: "9,426 ft",  relevance: "REA tours" },
      { id: "825:CO:SNTL", name: "Buffalo Pass (Tower)",        elevation: "10,610 ft", relevance: "CSR backcountry / North Routt / Buff Pass" },
      { id: "369:CO:SNTL", name: "Columbine",                   elevation: "8,540 ft",  relevance: "CSR Columbine trailhead" },
      { id: "457:CO:SNTL", name: "Steamboat Ski Resort (base)", elevation: "8,240 ft",  relevance: "Steamboat ski area base (3mi from Storm Peak summit)" },
    ],

    // Booking URLs keyed by offering type
    bookingUrls: {
      csr_browse_all:         "https://fareharbor.com/embeds/book/coloradosledrentals/items/?flow=1262218&full-items=yes&ref=highmark",
      rea_browse_all:         "https://fareharbor.com/embeds/book/rabbitearsadventures/items/?flow=1491038&full-items=yes&ref=homepage",
      csr_steamboat_unguided: "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=1262221",
      csr_kremmling_unguided: "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=1262222",
      csr_proride_guided:     "https://fareharbor.com/embeds/book/coloradosledrentals/items/?ref=highmark&flow=1470754&full-items=yes",
      rea_2hr_tour:           "https://fareharbor.com/embeds/book/rabbitearsadventures/?ref=highmark&full-items=yes&flow=1539483",
      rea_3hr_tour:           "https://fareharbor.com/embeds/book/rabbitearsadventures/items/673348/?ref=highmark&full-items=yes&flow=1491038",
      rea_private_tour:       "https://fareharbor.com/embeds/book/rabbitearsadventures/items/673358/?ref=highmark&full-items=yes&flow=1491038",
      all_winter:             "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=276228",
      rzr_steamboat:          "https://adventures.polaris.com/w/adventure/off-road-rental-for-pick-up-steamboat-springs-colorado-P-Q98-AZV?ref=highmark",
      rzr_kremmling:          "https://adventures.polaris.com/w/adventure/off-road-rental-for-pick-up-steamboat-springs-colorado-P-Q98-AZV?ref=highmark",
    },

    services: [
      "Guided snowmobile tours",
      "Self-guided snowmobile rentals",
      "RZR off-road adventures",
    ],
  },

  // ── Lone Pine Performance ─────────────────────────────────────────────────
  lone_pine: {
    id:    "lone_pine",
    slug:  "lone_pine",
    name:  "Lone Pine Performance",
    botName: "Lone Pine",
    tone:  "knowledgeable, local, professional, and helpful",

    // Set LONE_PINE_TWILIO_NUMBER in Railway env vars when the Twilio number is provisioned
    inboundPhones: [
      process.env.LONE_PINE_TWILIO_NUMBER,
    ].filter(Boolean),

    supportPhone: "(970) 761-2124",
    handoffPhone: "(970) 761-2124",
    supportEmail: "jake@lonepineperformance.com",
    address:      "1660 Copper Ridge Ct Unit 101, Steamboat Springs, CO 80487",
    timezone:     "America/Denver",
    hours: {
      weekdays: "Mon-Fri 9am-5pm",
      weekends:  "Closed Saturday and Sunday",
    },

    // Capability flags — informational only for now
    bookingMode:   "informational",
    fareharborEnabled:        false,
    crmEnabled:               false,
    confirmationTextsEnabled: false,

    fareharborCompanies: [],

    // Website pages to scrape for business knowledge (Chunk 2: per-client KB ingestion)
    scrapeUrls: [
      "https://lonepineperformance.com/",
    ],

    snotelStations: [], // no snow depth data needed for a suspension shop

    bookingUrls: {}, // no online booking — all via phone

    services: [
      "Suspension Revalve",
      "Factory Rebuild",
      "High Performance Coatings",
      "Telemetry Sessions",
    ],

    segments: [
      "Mountain bike",
      "Motorcycle",
      "Snow-related suspension (snowbike, snowmobile)",
    ],

    faq: [
      { q: "How do I schedule service?",    a: "Call (970) 761-2124 or email jake@lonepineperformance.com to get on the calendar." },
      { q: "What are your hours?",           a: "Monday through Friday, 9am to 5pm. Closed on weekends." },
      { q: "Where are you located?",         a: "1660 Copper Ridge Ct Unit 101, Steamboat Springs, CO 80487." },
      { q: "What suspension work do you do?", a: "Suspension revalve, factory rebuild, high performance coatings, and telemetry sessions for mountain bikes, motorcycles, and snow-related suspension." },
      { q: "Do you work on snowbikes?",      a: "Yes — snow-related suspension including snowbike and snowmobile suspension is part of what we do." },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT RESOLVER
// Matches inbound Twilio "To" number to a client config.
// Falls back to csr_rea for safety (backward compatibility with existing deploy).
// ─────────────────────────────────────────────────────────────────────────────
export function resolveClient(toNumber) {
  if (toNumber) {
    for (const client of Object.values(CLIENTS)) {
      if (client.inboundPhones.includes(toNumber)) return client;
    }
    // Only warn if it doesn't look like a test number
    if (!toNumber.startsWith("+1555")) {
      console.warn(`[CLIENT] No config match for To: ${toNumber} — falling back to csr_rea`);
    }
  }
  return CLIENTS.csr_rea;
}

// Convenience: get default client (csr_rea) for tests and backward-compat callers
export function getDefaultClient() {
  return CLIENTS.csr_rea;
}
