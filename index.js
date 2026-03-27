/* ─────────────────────────────────────────────────────────────────────────────
   HIGHMARK — AI SMS Concierge by Whiteout Solutions
   ─────────────────────────────────────────────────────────────────────────────
   Tier 1 ($200-300/mo): FAREHARBOR_ENABLED=false
     Bot answers questions + routes to booking links
   Tier 2 ($400-500/mo): FAREHARBOR_ENABLED=true
     Real-time availability + live knowledge base refresh

   Search "CLIENT_CONFIG" to find every client-specific value.
   ─────────────────────────────────────────────────────────────────────────────
*/
import "dotenv/config";
import { fileURLToPath } from "url";
import path from "path";
import express from "express";
import rateLimit from "express-rate-limit";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

import { initKnowledgeBase, getKnowledgeContext, getFareHarborItems, getFareHarborKbRow, getFareHarborAvailability } from "./knowledgeBase.js";
import { saveLead, notifyBusinessOfLead } from "./leads.js";
import { resolveClient, CLIENTS, getDefaultClient } from "./clients.js";
import { initBookingConfirmations, buildConfirmationText, buildFollowUpText, buildCancellationText } from "./bookingConfirmations.js";
import { initCRM, checkOptOut, handleOptOutKeyword, handleOptInKeyword, upsertContact, addTagsToContact, trackCampaignReply, deriveTagsFromMessage, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS } from "./crm.js";
import { processScheduledMessages } from "./scheduler.js";
import { handleListLeads, handleUpdateLead, handleLeadsSummary } from "./adminLeads.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

// IP limiter: 30 requests / minute per IP (catches bots hitting the endpoint)
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[RATE] IP blocked: ${req.ip}`);
    res.set("Content-Type", "text/xml");
    res.status(429).send("<Response></Response>");
  },
});

// Per-phone limiter: 10 messages / minute per phone number
const phoneWindows = new Map(); // phone -> { count, resetAt }
function phoneRateLimit(req, res, next) {
  if (isUiReq(req)) return next(); // UI requests skip phone rate limit
  const phone = req.body?.From;
  if (!phone) return next();
  const now = Date.now();
  const window = phoneWindows.get(phone);
  if (!window || now > window.resetAt) {
    phoneWindows.set(phone, { count: 1, resetAt: now + 60 * 1000 });
    return next();
  }
  if (window.count >= 10) {
    console.warn(`[RATE] Phone throttled: ${phone}`);
    res.set("Content-Type", "text/xml");
    return res.status(429).send("<Response></Response>");
  }
  window.count++;
  next();
}

// Prune stale phone windows every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, w] of phoneWindows) {
    if (now > w.resetAt) phoneWindows.delete(phone);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL UI AUTH
// Set UI_SECRET env var in Railway to enable the /ui console on the live URL.
// Access via: https://your-railway-url/ui?key=YOUR_SECRET
// ─────────────────────────────────────────────────────────────────────────────
const UI_SECRET = process.env.UI_SECRET || "";

// Returns true if the request carries a valid UI key header (set by ui.html)
function isUiReq(req) {
  if (!UI_SECRET) return false;
  return req.headers["x-internal-key"] === UI_SECRET;
}

// Middleware: allow if TEST_MODE OR valid UI key (query param for initial GET, header for API calls)
function requireUiAccess(req, res, next) {
  if (process.env.TEST_MODE === "true") return next();
  if (UI_SECRET && (req.query.key === UI_SECRET || isUiReq(req))) return next();
  res.status(401).send("Unauthorized — add ?key=UI_SECRET to URL");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG
// All per-client values now live in clients.js. resolveClient(toNumber) returns
// the active client on every request. Search clients.js for CLIENT_CONFIG fields.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CLIENTS
// ─────────────────────────────────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const crmSupabase  = process.env.CRM_SUPABASE_URL
  ? createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY)
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// SEASON DETECTION
// ─────────────────────────────────────────────────────────────────────────────
export function getCurrentSeason() {
  const month = new Date().getMonth() + 1; // 1-12
  if ([11, 12, 1, 2, 3].includes(month)) return "winter";
  if ([4, 5].includes(month))             return "shoulder";
  return "summer";
}

// client param is optional — defaults to csr_rea for backward compatibility
export function getSeasonalOpener(client) {
  const c      = (client && typeof client === "object") ? client : getDefaultClient();
  const season = getCurrentSeason();

  // Use client-configured opener if provided (e.g. Lone Pine)
  if (c.openerText) return c.openerText;

  if (c.id === "csr_rea") {
    if (season === "winter")  return "Hey! I'm Summit 🏔 your guide to snowmobiling in Steamboat. Guided tours or self-guided rental — what sounds like you?";
    if (season === "summer")  return "Hey! I'm Summit 🏔 your guide to RZR adventures in Steamboat. Self-guided off-road fun — want to explore?";
    return "Hey! I'm Summit 🏔 snowmobile season winding down, RZR season kicking off. What adventure are you planning?";
  }

  // Generic fallback for informational clients without openerText
  return `Hey! I'm here to help with ${c.name} — ${c.services.slice(0, 2).join(" and ")} in Steamboat. What can I help with?`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// Dispatch-based: uses client.bookingMode to select the right prompt builder.
// Backward-compat: if first arg is a string (old-style call), treats it as season
// and builds the csr_rea prompt — keeps test.js and any callers working.
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPromptInformational(client, knowledgeContext) {
  const serviceList = client.services.join(", ");
  const faqText     = (client.faq ?? []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n");
  const hoursText   = client.hours
    ? `${client.hours.weekdays}. ${client.hours.weekends}.`
    : "Contact us for current hours.";

  return `You are an SMS assistant for ${client.name}, located in Steamboat Springs, CO.
Tone: ${client.tone}. Never robotic. Never a FAQ page.
Never mention Whiteout Solutions, Highmark, or the underlying platform.

━━━ SMS RULES ━━━
- Every reply: up to 480 chars. Use as much as needed, never cut off mid-thought.
- Plain text only. No bullets, dashes, markdown. Emojis: max 1-2 per message.
- Never send 2 texts in a row without a guest reply.

━━━ BUSINESS INFO ━━━
Name: ${client.name}
Phone: ${client.supportPhone}
Email: ${client.supportEmail ?? "N/A"}
Address: ${client.address ?? "Contact us for address"}
Hours: ${hoursText}
Services: ${serviceList}

━━━ BOOKING / SCHEDULING ━━━
${client.name} does NOT use online booking.
If a guest asks to schedule, book, or get on the calendar — direct them to:
  Call ${client.handoffPhone}
  Email ${client.supportEmail}
Do NOT pretend live scheduling exists. Do NOT invent appointment times or availability.

━━━ HANDOFF ━━━
For complex service quotes, custom work, or anything you cannot answer with the info above:
HANDOFF MESSAGE: "Great question for the team! Give Jake a call at ${client.handoffPhone} and he'll get you sorted 🔧"

━━━ FAQ ━━━
${faqText}

${knowledgeContext ? `━━━ LIVE DATA ━━━\n${knowledgeContext}` : ""}`;
}

function buildSystemPromptCsrRea(client, season, knowledgeContext) {
  const isWinter   = season === "winter" || season === "shoulder";
  const isSummer   = season === "summer" || season === "shoulder";
  const urls       = client.bookingUrls ?? {};
  const bookingRef = Object.entries(urls).map(([k, v]) => `${k}: ${v}`).join("\n");
  const handoff    = client.handoffPhone;

  return `You are Summit — AI SMS concierge for Colorado Sled Rentals and Rabbit Ears Adventures, Steamboat Springs CO.
Warm, stoked, genuinely local. Like a guide who loves their job. Never robotic. Never a FAQ page.
Never mention Whiteout Solutions or Highmark to guests.

━━━ SMS RULES (hard limits) ━━━
- Every reply: up to 480 chars max (3 texts). Use as much as needed, never cut off mid-thought.
- No bullets, dashes, markdown, or formatting. Plain text only.
- Emojis: max 1-2 per message. Use sparingly.
- Never send 2 texts in a row without a guest reply.
- Always end conditions replies with a natural follow-up question to keep the guest engaged (e.g. "Want to get out this weekend?" or "Want to be first to know when we reopen?").

━━━ BOOKING RULES ━━━
- Same-day bookings are NOT available — minimum 1 day advance booking required. If a guest asks about today, let them know and offer the next available date.
- Never quote specific pricing — always send the booking link instead.
- Never confirm availability unless told to by LIVE DATA below.
- Never make up snow depth or trail conditions.
- Groups 6+: always handoff — never try to book via text.
- For general/ambiguous booking requests: use the browse-all links so the guest picks their own item.
- For specific tour choices: use the individual item link.
- Always include the full URL directly in your reply — never say "click here" without the link.
Available booking links:
${bookingRef}

━━━ HANDOFF — send this message and stop when: ━━━
- Group of 6 or more people
- Complaint or problem
- Injury, accident, or insurance question
- Custom pricing request
HANDOFF MESSAGE: "Great question for our team! Give us a call at ${handoff} and we'll get you sorted 🤙"
After a handoff: keep answering questions normally. Only repeat the phone number if the guest asks for complex help (booking large groups, complaints, custom pricing). General info, conditions, product questions — answer them fully.

${isWinter ? `━━━ WINTER KNOWLEDGE ━━━
CSR — Colorado Sled Rentals:
- Steamboat: 2151 Downhill Dr | Kremmling: 1606 Park Ave
- Fleet: 2026 Polaris Boost 850s, 9R Khaos, 650 RMK SP, Pro-RMKs
- Includes: full tank, helmet, avalanche gear (BCA pack, beacon, shovel, probe, radio), $1k damage cap
- NOT ride-from: needs CSR trailer or own tow vehicle. Delivery to Columbine Trailhead Clark CO (included guided, extra fee unguided)
- TOBE monosuits + boots rentable (extra cost). 18+ to rent, 16+ to drive (valid license required).

CSR Pro-Ride Guided: Experienced riders only — deep powder, tree lines, steep climbs. Half-day + full-day available.

REA — Rabbit Ears Adventures:
- Location: 4492 HWY 14, Walden CO (Rabbit Ears Pass)
- Polaris Trail snowmobiles OR 4-seat tracked Polaris UTV
- 285" average annual snowfall at pass. FREE shuttle from most Steamboat lodging.
- Hot cocoa, tea, coffee after the ride. Helmet included. $1k damage cap.
- 5-star avg, 1000s of first-timers guided. Tours: 2hr public | 3hr public | Private.

WINTER ROUTING:
Beginner / has kids / wants guided → REA tours (use rea_2hr_tour or rea_3hr_tour link)
Experienced / own pace → CSR unguided Steamboat or Kremmling (use csr_steamboat_unguided or csr_kremmling_unguided)
Advanced / backcountry → CSR Pro-Ride (use csr_proride_guided)
Unsure → ask experience level + group size first` : ""}

${isSummer ? `━━━ SUMMER KNOWLEDGE ━━━
CSR Summer RZR Rentals:
- Steamboat: 2151 Downhill Dr | Kremmling: 1606 Park Ave
- Self-guided, up to 8 hours, pre-loaded GPS with Polaris Ride Command
- Turbo PRO S 4-Seater: 168HP turbo — thrill seekers, experienced riders (use rzr_steamboat or rzr_kremmling)
- General 1000 4-Seater: 100HP — families, beginner-friendly, extra storage (use rzr_steamboat or rzr_kremmling)
- Both seat 4 adults. Trailer rental available. Books via Polaris Adventures (NOT FareHarbor).
- Season: roughly late June–September depending on snow melt at Buffalo Pass (10,000+ ft)

━━━ RZR TRAIL AREAS ━━━
BUFFALO PASS TRAIL SYSTEM (out of Steamboat, ~10mi north)
- Trailhead: Buffalo Pass Rd / Forest Rd 60, top of Buffalo Pass (elev 10,180 ft)
- Riding: Mix of alpine meadows, forested ridge lines, technical rock sections. 50+ miles of interconnected Forest Service roads and trails.
- Highlights: Continental Divide views, Fishhook Lake, South Fork trail, North Fork trail
- Difficulty: Moderate to Advanced. Narrow shelf roads, creek crossings. Perfect for Turbo PRO S.
- Access: Forest Rd 60 from Steamboat. Road typically opens late June / July depending on snowpack.

NORTH ROUTT / STEAMBOAT LAKE AREA (~25mi north of Steamboat)
- Trailheads: Dry Lake, Bear River, Pearl Lake area, Forest Rd 400
- Riding: Remote, wide-open ranching valleys, forested ridges, less technical than Buffalo Pass. Great for families.
- Highlights: Steamboat Lake views, Hahns Peak (14 miles of open ridge), Elk hunting country feel
- Difficulty: Easy to Moderate. Good for General 1000, wide roads.
- Access: HWY 129 north through Clark, then forest service roads

RABBIT EARS PASS / GORE PASS AREA (~20mi SE of Steamboat)
- Trailheads: Muddy Pass, Gore Pass, Lynx Pass, HWY 40 pulloffs
- Riding: Continental Divide trails, alpine tundra above treeline, panoramic views
- Highlights: Divide ridgeline, Yampa Valley views, Storm Peak sightlines, access to Kremmling trails
- Difficulty: Moderate. Some rocky alpine terrain near the Divide. Good mix for both RZR models.
- Access: HWY 40 east to top of Rabbit Ears Pass, then forest roads south

KREMMLING / MIDDLE PARK BLM AREA (out of Kremmling location)
- Riding: Wide-open BLM high desert terrain, much drier than Steamboat. Views of Gore Range and Williams Fork mountains.
- Highlights: Radium OHV Area, Trough Road, Pumphouse Recreation Area, Colorado River canyon views
- Difficulty: Easy to Moderate. Excellent for first-timers, families, longer mileage days.
- Access: Out of CSR's Kremmling location directly. 100,000+ acres of accessible BLM.

TRAIL ROUTING RECOMMENDATIONS:
- First-timers / families → North Routt or Kremmling BLM. Wider roads, less technical.
- Experienced / want adrenaline → Buffalo Pass. Shelf roads, steep climbs, alpine exposure.
- Scenic / photo opportunity → Rabbit Ears Pass ridge. Views in every direction.
- Want all-day miles → Kremmling. Endless BLM roads, can link to Gore Pass loop.

━━━ OHV / RZR RULES (Colorado + Routt National Forest) ━━━
REGISTRATION:
- Colorado OHV registration required for all ATVs/UTVs on public lands ($25.25/year — CSR handles this for rental units)
- Rental units are registered — guests do NOT need their own OHV sticker
- Street-legal UTVs with plates can use public roads; RZR rentals are OHV-only (Forest roads and trails)

ON TRAIL:
- Stay on designated Forest Service roads and OHV trails ONLY — off-trail travel is illegal and destroys habitat
- Yield to equestrians and hikers — horses have right of way, stop and move to the downhill side
- Speed limit: 15 mph near trailheads and campgrounds, check posted limits on Forest roads (typically 25–35 mph)
- No riding in designated Wilderness Areas (Zirkel Wilderness, Flat Tops Wilderness are closed to OHV)
- No riding on private land — stay on marked public land routes
- Spark arrester required (all CSR rental units are equipped)
- No riding after dark unless unit has proper lighting

SAFETY:
- Helmets: strongly recommended for all riders, required under 18 (CSR provides helmets)
- Seat belts: buckle in always — rollover risk on steep terrain
- Slow down on hills: brake before, not during descent — engine brake in low gear
- Creek crossings: check depth before crossing, go slow, don't stall the engine
- Do not ride alone in remote areas without communication — Routt National Forest has limited cell service
- Bring water, snacks, basic first aid kit, and a paper map (GPS can lose signal)
- File a float plan: tell someone where you're going and when you'll be back
- Weather changes fast at altitude — always have a rain layer even on sunny mornings

FIRE & ENVIRONMENT:
- Campfires only in designated fire rings — fire restrictions common in August/September (check fs.usda.gov/arp)
- Pack out all trash — Leave No Trace
- Avoid muddy trails after rain (causes lasting damage to soils)
- Routt National Forest fire restriction status: fs.usda.gov/arp or call Hahns Peak / Bears Ears District (970) 870-2299

SUMMER ROUTING:
Family + summer → General 1000 + North Routt or Kremmling BLM
Thrill seeker + summer → Turbo PRO S + Buffalo Pass
First-timer / beginner → General 1000 + Kremmling BLM
Experienced + wants epic scenery → Turbo PRO S + Rabbit Ears Pass / Buffalo Pass loop
Any RZR/ATV question → summer options` : ""}

━━━ WHAT TO WEAR (all seasons) ━━━
Waterproof/windproof outer layer, warm waterproof gloves, wool socks (no cotton), goggles (helmets provided). Water, snacks, camera. Leave jewelry at home.

━━━ STEAMBOAT LOCAL KNOWLEDGE ━━━
You live here. Answer general Steamboat questions like a knowledgeable local would — ski resort, restaurants, lodging, hot springs, hiking, fishing, events. Keep it brief (SMS), give a real answer, then naturally tie back to tours/sleds if it fits. Do NOT redirect guests to another website when you can just answer. Examples:
- "what else is there to do" → mention ski resort, Strawberry Park hot springs, Old Town, Yampa River, then offer to help them book an adventure with CSR/REA
- "good places to eat" → give 2-3 real local spots (Mambo Italiano, Rex's Tacos, Taco Cabo, Mahogany Ridge)
- "where should I stay" → mention Old Town area vs ski area tradeoffs briefly
Only deflect if it's truly outside your knowledge (legal questions, very specific medical, etc.).

━━━ WEATHER + CONDITIONS RULES ━━━
LIVE DATA IS YOUR SOURCE OF TRUTH. When the LIVE DATA section below contains weather or snow data, you MUST use it — never redirect guests to an external site when you already have the answer.

WEATHER: If LIVE DATA has a WEATHER section → quote the actual temps and forecast directly. Do NOT say "check Steamboat.com" — you have the data.

SNOW DEPTH (SNOTEL): If LIVE DATA has a SNOW CONDITIONS section → you MUST quote the actual depth numbers. Example: "Buffalo Pass has 60 inches of snow depth right now (Tower station, 10,610 ft). Rabbit Ears Pass is at 25 inches." Do NOT say "check Steamboat.com for snow totals" — that's ski resort base depth, we have backcountry SNOTEL data which is more relevant for snowmobiling.
- Rabbit Ears Pass = REA tour terrain. Buffalo Pass (Tower) = CSR backcountry. Columbine = CSR Columbine trailhead. Steamboat base (Dry Lake) = ski area base reference.

AVALANCHE: If LIVE DATA has "Avalanche danger (Steamboat zone)" → quote it directly. Example: "Steamboat zone is currently Alpine: Moderate, Treeline: Moderate, Below: Moderate per CAIC." Do NOT redirect to avalanche.org or avalanche.state.co.us — you have the current rating in your data.
- If asked about avalanche and NO danger rating is in LIVE DATA → then (and only then) say "Check avalanche.state.co.us for the Steamboat zone."

ONLY if the LIVE DATA section below has NO SNOW CONDITIONS block at all → say "Rabbit Ears SNOTEL (snotel.nrcs.usda.gov) has the latest snowpack."
- Steamboat Ski Resort summit (Storm Peak) weather comes from OpenWeather. Base snow depth from Dry Lake SNOTEL (8,240 ft).
- Never invent snow depth, grooming status, or conditions not in LIVE DATA.

${knowledgeContext ? `━━━ LIVE DATA ━━━\n${knowledgeContext}` : ""}`;
}

// Public dispatcher — backward-compat: first arg may be a season string (old tests)
// or a client object (new calls). Both work.
export function buildSystemPrompt(clientOrSeason, season, knowledgeContext) {
  if (typeof clientOrSeason === "string") {
    // Old-style: buildSystemPrompt(season, knowledgeContext)
    return buildSystemPromptCsrRea(getDefaultClient(), clientOrSeason, season ?? "");
  }
  const client = clientOrSeason ?? getDefaultClient();
  if (client.bookingMode === "informational") {
    return buildSystemPromptInformational(client, knowledgeContext ?? "");
  }
  return buildSystemPromptCsrRea(client, season ?? getCurrentSeason(), knowledgeContext ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT + SENTIMENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
export function detectIntent(message) {
  const t = message.toLowerCase();
  if (/\b(hi+|hey+|hello|howdy|sup|what'?s up|thanks|thank you|thx|ty|np|sounds good|ok|okay|got it|perfect)\b/i.test(t)) return "smalltalk";
  if (/my (booking|reserv|order|ticket|confirmation)|look.?up|check my reservation|reservation #|confirm.*(number|code)/i.test(t)) return "lookup";
  if (/\bbook\b|availability|available|sign.?up|schedule|when can|how do (i|we) book|get a spot|for \d+ (people|person|guests|adults)|this (weekend|saturday|sunday|friday|thursday)|want to (ride|go|do|try)/i.test(t)) return "booking";
  if (/snow|powder|condition|grooming|report|depth|weather|trail.*open|base|fresh pow|road condition|avalanche|avy|snotel|snowpack|danger|forecast/i.test(t)) return "conditions";
  if (/complaint|problem|refund|injury|wrong|not working|terrible|worst|annoying|upset|angry|disappointed|too expensive/i.test(t)) return "handoff";
  return "info";
}

export function detectSentiment(message) {
  const t = message.toLowerCase();
  if (/excited|great|awesome|love|thanks|perfect|amazing|stoked|can'?t wait|so fun|best/i.test(t))                        return "positive";
  if (/problem|terrible|wrong|not working|worst|annoying|wtf|ridiculous|upset|angry|disappointed|sucks/i.test(t))         return "frustrated";
  return "neutral";
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Hard truncates at last word boundary before max, adds '…'
export function enforceLength(text, max = 320) {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > max * 0.7 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// True if conversation exists and last message was more than 24h ago
export function isReturningGuest(conversation) {
  if (!conversation?.messages?.length) return false;
  const lastTs = conversation.messages[conversation.messages.length - 1].timestamp;
  return Date.now() - new Date(lastTs).getTime() > 24 * 60 * 60 * 1000;
}

// Checks FareHarbor availability if message mentions a date (Tier 2 / fareharbor clients only)
async function checkAvailabilityIfNeeded(message, convo, client) {
  if (!client?.fareharborEnabled) return null;

  const datePatterns = [
    /\b(this )?(saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i,
    /\b(next week|this weekend|tomorrow)\b/i,
    /\b\d{1,2}\/\d{1,2}\b/,
  ];

  const hasDate = datePatterns.some((p) => p.test(message));
  if (!hasDate) return null;

  try {
    // Ask Claude to extract structured date info
    const extractRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 80,
      messages:   [
        {
          role:    "user",
          content: `Extract booking details from this message. Return JSON only, no explanation:
{"date":"YYYY-MM-DD or null","company":"csr or rea or null","itemType":"snowmobile or rzr or null"}
Today is ${new Date().toISOString().slice(0, 10)}.
Message: "${message}"`,
        },
      ],
    });

    let extracted = {};
    try {
      const raw = extractRes.content[0].text.trim();
      const match = raw.match(/\{[\s\S]*\}/);
      extracted = match ? JSON.parse(match[0]) : {};
    } catch {
      return null;
    }

    if (!extracted.date || extracted.date === "null") return null;

    // Default to REA for winter, CSR for summer if no company specified
    const company  = extracted.company ?? (getCurrentSeason() === "summer" ? "csr" : "rea");
    const items    = await getFareHarborItems(company, supabase);
    const firstItem = items[0];
    if (!firstItem) return null;

    const availability = await getFareHarborAvailability(company, firstItem.pk, extracted.date);
    if (!availability?.length) return null;

    const openSlots = availability.filter((a) => a.online_booking_status === "open" && a.capacity > 0);
    if (!openSlots.length) return `No open slots on ${extracted.date} — check booking link for other dates.`;

    const times = openSlots
      .slice(0, 3)
      .map((a) => new Date(a.start_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))
      .join(", ");

    return `${extracted.date}: ${openSlots.length} slot(s) open — ${times}`.slice(0, 120);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOUR MENU BUILDER
// Builds a numbered list of available tours for the guest to choose from.
// Checks FH availability per item if a date string is provided.
// Returns [] for non-fareharbor clients.
// ─────────────────────────────────────────────────────────────────────────────
async function buildTourMenu(client, season, dateStr) {
  if (client.bookingMode !== "fareharbor") return [];

  const urls = client.bookingUrls ?? {};
  const { items: reaItems, availabilityData: reaAvail } = await getFareHarborKbRow("rea", supabase);

  // Individual items listed — REA guided tours (freshest from KB cache, up to 4)
  const options = [];

  if (season !== "summer") {
    for (const item of reaItems.slice(0, 4)) {
      // Skip items confirmed to have no online availability (open_days === 0)
      // If availabilityData is missing for this item, include it (unknown ≠ unavailable)
      const avail = reaAvail[item.name];
      if (avail && avail.open_days === 0) continue;
      options.push({ label: item.name, company: "rea", pk: item.pk,
        url: `https://fareharbor.com/embeds/book/rabbitearsadventures/items/${item.pk}/?ref=highmark&full-items=yes` });
    }
    // CSR: one "browse all" link covers all sled models (too many to list individually)
    options.push({ label: "CSR self-guided sled rental (browse all sleds)", company: "csr",
      url: urls.csr_browse_all });
    options.push({ label: "CSR Pro-Ride backcountry guided (expert riders)", company: "csr",
      url: urls.csr_proride_guided });
  }

  if (season !== "winter") {
    options.push({ label: "RZR off-road adventure (Steamboat)", company: "csr", url: urls.rzr_steamboat });
    options.push({ label: "RZR off-road adventure (Kremmling)", company: "csr", url: urls.rzr_kremmling });
  }

  // Check FH availability per item if a date was given
  if (dateStr && client.fareharborEnabled) {
    await Promise.all(options.map(async (opt) => {
      if (!opt.pk) { opt.available = null; return; } // browse-all links have no single PK
      try {
        const avail = await getFareHarborAvailability(opt.company, opt.pk, dateStr);
        const open  = (avail ?? []).filter((a) => a.online_booking_status === "open" && a.capacity > 0);
        opt.available = open.length > 0;
        opt.times     = open.slice(0, 2).map((a) =>
          new Date(a.start_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        );
      } catch {
        opt.available = null; // unknown — don't claim either way
      }
    }));
  }

  return options;
}

// Formats the tour menu as a Claude instruction string
function formatMenuInstruction(client, options, dateStr) {
  const numbered = options.map((opt, i) => {
    let line = `${i + 1}) ${opt.label}`;
    if (dateStr) {
      if (opt.available === true)  line += ` (${opt.times?.join(" or ") || "available"})`;
      if (opt.available === false) line += " (no availability)";
    }
    return line;
  }).join(", ");

  const urls         = client.bookingUrls ?? {};
  const guidedBrowse = urls.rea_browse_all;
  const rentalBrowse = urls.csr_browse_all;
  const dateNote     = dateStr ? ` for ${dateStr}` : "";

  const allUnavailable = dateStr
    && options.filter((o) => o.available !== null).length > 0
    && options.every((o) => o.available === false);

  if (allUnavailable) {
    return `No availability found${dateNote}. Tell the guest clearly — no open slots on that date. Suggest a different date or call ${client.handoffPhone}. Also share these browse links so they can check other dates themselves: Guided tours: ${guidedBrowse} | Rentals: ${rentalBrowse}`;
  }

  return `List these options${dateNote} and ask the guest to pick one by number. Also ask how many people. After the list, add: "Or browse everything yourself: Guided: ${guidedBrowse} | Rentals: ${rentalBrowse}" Options: ${numbered}`;
}

// Returns true when all options with known availability have available===false.
function isAllUnavailable(options, dateStr) {
  if (!dateStr) return false;
  const known = options.filter((o) => o.available !== null);
  return known.length > 0 && known.every((o) => o.available === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CONVERSATION STORE
// ─────────────────────────────────────────────────────────────────────────────
async function getConversation(fromNumber, toNumber) {
  const { data } = await supabase
    .from("conversations")
    .select("*")
    .eq("from_number", fromNumber)
    .eq("to_number", toNumber)
    .single();

  if (data) {
    return {
      isNew: false,
      convo: {
        messages:              data.messages               ?? [],
        bookingStep:           data.booking_step           ?? null,
        bookingData:           data.booking_data           ?? { activity: null, date: null, groupSize: null, company: null, booking_pk: null },
        handoff:               data.handoff                ?? false,
        consecutiveFrustrated: data.consecutive_frustrated ?? 0,
        sessionType:           data.session_type           ?? "live",
        leadStep:              data.lead_step              ?? null,
        leadData:              data.lead_data              ?? null,
        waitlistPending:       data.waitlist_pending       ?? false,
        waitlistContext:       data.waitlist_context       ?? null,
      },
    };
  }

  return {
    isNew: true,
    convo: {
      messages:              [],
      bookingStep:           null,
      bookingData:           { activity: null, date: null, groupSize: null, company: null, booking_pk: null },
      handoff:               false,
      consecutiveFrustrated: 0,
      sessionType:           "live",
      leadStep:              null,
      leadData:              null,
      waitlistPending:       false,
      waitlistContext:       null,
    },
  };
}

async function saveConversation(fromNumber, toNumber, convo) {
  await supabase.from("conversations").upsert(
    {
      from_number:            fromNumber,
      to_number:              toNumber,
      messages:               convo.messages,
      booking_step:           convo.bookingStep,
      booking_data:           convo.bookingData,
      handoff:                convo.handoff,
      consecutive_frustrated: convo.consecutiveFrustrated,
      session_type:           convo.sessionType,
      lead_step:              convo.leadStep,
      lead_data:              convo.leadData,
      waitlist_pending:       convo.waitlistPending,
      waitlist_context:       convo.waitlistContext,
      updated_at:             new Date().toISOString(),
    },
    { onConflict: "from_number,to_number" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CALL
// ─────────────────────────────────────────────────────────────────────────────
async function getClaudeReply(convo, client, season, knowledgeContext, extraInstruction, maxLength = 320) {
  const messages = convo.messages.map(({ role, content }) => ({ role, content }));
  const system   = extraInstruction
    ? `${buildSystemPrompt(client, season, knowledgeContext)}\n\nCURRENT CONTEXT: ${extraInstruction}`
    : buildSystemPrompt(client, season, knowledgeContext);

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 450,
    system,
    messages,
  });

  const text = response.content[0].text;
  // Never truncate replies containing URLs — the link must arrive intact
  if (/https?:\/\//.test(text)) return text;
  return enforceLength(text, maxLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS WEBHOOK — Twilio calls this on every inbound text
// Processing order is intentional — do not reorder.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/sms", ipLimiter, phoneRateLimit, async (req, res) => {
  const rawBody    = req.body.Body?.trim() ?? "";
  const fromNumber = req.body.From;
  const toNumber   = req.body.To;

  // Resolve which client this inbound number belongs to
  const client = resolveClient(toNumber);

  // 1. Parse + validate
  if (!rawBody || !fromNumber) {
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 2. Normalize for keyword checks
  const msgUpper = rawBody.toUpperCase().trim();

  // 3. OPT-OUT check — MUST be first (TCPA legal requirement)
  if (OPT_OUT_KEYWORDS.includes(msgUpper) && crmSupabase) {
    await handleOptOutKeyword(fromNumber, toNumber, twilioClient, crmSupabase);
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4. OPT-IN check
  if (OPT_IN_KEYWORDS.includes(msgUpper) && crmSupabase) {
    await handleOptInKeyword(fromNumber, toNumber, twilioClient, crmSupabase);
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4.5. HELP keyword — required by TCPA/CTIA. Works even if opted out.
  if (msgUpper === "HELP") {
    const helpText = `${client.name} SMS: info & booking assistance. Msg freq varies. Msg & data rates may apply. Reply STOP to unsubscribe. Support: ${client.supportPhone}`;
    if (process.env.TEST_MODE === "true") return res.json({ reply: helpText });
    await twilioClient.messages.create({ body: helpText, from: toNumber, to: fromNumber });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 5. Opted-out gate — drop silently if this number has opted out
  if (crmSupabase) {
    const isOptedOut = await checkOptOut(fromNumber, crmSupabase);
    if (isOptedOut) {
      console.log(`[OPT-OUT] Dropping message from opted-out number ${fromNumber}`);
      res.set("Content-Type", "text/xml");
      return res.send("<Response></Response>");
    }
  }

  // 6. DEMO triggers — reset conversation and send appropriate opener
  //    DEMO: public keyword (on website), introduces Highmark by name for prospects
  //    SUMMITDEMO: internal keyword for owner use, sends straight into Summit persona
  if (msgUpper === "DEMO" || msgUpper === "SUMMITDEMO") {
    await supabase.from("conversations").delete().eq("from_number", fromNumber);

    let opener;
    if (msgUpper === "DEMO") {
      const season = getCurrentSeason();
      if (season === "winter") {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about snowmobiling, conditions, or booking in Steamboat. Go ahead!";
      } else if (season === "summer") {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about RZR adventures, trails, or booking in Steamboat. Go ahead!";
      } else {
        opener = "Hey! This is Highmark — AI guest texting for outdoor businesses. I'm Summit 🏔 Ask me about adventures, conditions, or booking in Steamboat. Go ahead!";
      }
      opener = enforceLength(opener, 320);
    } else {
      opener = enforceLength(getSeasonalOpener(client));
    }

    console.log(`[DEMO] ${msgUpper} — reset + opener sent to ${fromNumber}`);

    if (process.env.TEST_MODE === "true") return res.json({ reply: opener });

    await twilioClient.messages.create({ body: opener, from: toNumber, to: fromNumber });

    // Notify owner when a prospect triggers DEMO (not SUMMITDEMO)
    if (msgUpper === "DEMO" && process.env.CONFIRMATIONS_TEST_PHONE) {
      await twilioClient.messages.create({
        body: `Highmark lead 🏔 ${fromNumber} just texted DEMO. Follow up when ready!`,
        from: toNumber,
        to:   process.env.CONFIRMATIONS_TEST_PHONE,
      }).catch((err) => console.error("[DEMO] Owner notify failed:", err.message));

      // Tag in CRM as demo lead (only for CRM-enabled clients)
      if (client.crmEnabled && crmSupabase) {
        await upsertContact(fromNumber, { source: "demo", tags: ["demo_lead"] }, crmSupabase)
          .catch(() => {});
      }
    }

    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 6. Load conversation from Supabase
  const { isNew, convo } = await getConversation(fromNumber, toNumber);

  // 7-9. Classify
  const season    = getCurrentSeason();
  const intent    = detectIntent(rawBody);
  const sentiment = detectSentiment(rawBody);
  const returning = !isNew && isReturningGuest(convo);

  // 10. Update consecutive frustrated counter
  if (sentiment === "frustrated") {
    convo.consecutiveFrustrated = (convo.consecutiveFrustrated ?? 0) + 1;
  } else {
    convo.consecutiveFrustrated = 0;
  }

  // Push user message to history
  convo.messages.push({
    role:      "user",
    content:   rawBody,
    timestamp: new Date().toISOString(),
    intent,
    sentiment,
  });

  // Keep last 10 messages to stay within token limits
  if (convo.messages.length > 10) convo.messages = convo.messages.slice(-10);

  let replyText;

  try {
    // WAITLIST pre-flight — runs before main routing.
    // YES/NO: handled here. Any other message: clears pending and falls through to normal routing.
    if (convo.waitlistPending === true && client.waitlistEnabled !== false) {
      const isYes = /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim());
      const isNo  = /^(no|nope|nah|not now|skip|n)\b/i.test(rawBody.trim());
      if (isYes) {
        await saveLead(supabase, {
          clientId:     client.id,
          fromNumber,
          contactPhone: fromNumber,
          service:      convo.waitlistContext?.service ?? "availability updates",
          timeframe:    convo.waitlistContext?.date    ?? null,
          leadType:     "waitlist",
        });
        notifyBusinessOfLead(
          twilioClient, client, fromNumber, toNumber,
          { service: convo.waitlistContext?.service ?? "availability updates", callback: fromNumber, timeframe: convo.waitlistContext?.date },
          process.env.TEST_MODE === "true",
          "waitlist"
        ).catch((err) => console.error("[WAITLIST] notify error:", err.message));
        replyText = enforceLength(
          `You're on the list! We'll text you when spots open. Questions anytime: ${client.handoffPhone} 🤙`
        );
      } else if (isNo) {
        replyText = enforceLength(`No problem! Reach us anytime at ${client.handoffPhone} 🤙`);
      }
      // Always clear pending — guest either confirmed, declined, or moved on
      convo.waitlistPending = false;
      convo.waitlistContext = null;
    }

    // Main routing — only runs if not already handled by waitlist pre-flight above
    if (!replyText) {

    // 11. Sentiment escalation → auto-handoff after 2 consecutive frustrated messages
    if (convo.consecutiveFrustrated >= 2 && !convo.handoff) {
      convo.handoff = true;
      console.log(`[HANDOFF] Auto-escalation (frustrated x${convo.consecutiveFrustrated}) — ${fromNumber}`);
      if (client.waitlistEnabled !== false) {
        convo.waitlistPending = true;
        convo.waitlistContext = { service: "general inquiry", date: null };
        replyText = enforceLength(
          `I want to make sure you get the best help. Want me to save your number so the team can call you back? Reply YES to confirm, or call now: ${client.handoffPhone} 🤙`
        );
      } else {
        replyText = enforceLength(
          `I want to make sure you get the best help — give us a call at ${client.handoffPhone} and we'll sort you out 🤙`
        );
      }
    }

    // 12. Explicit handoff intent — try lead capture first, phone as escape hatch
    else if (intent === "handoff") {
      convo.handoff = true;
      console.log(`[HANDOFF] Explicit request — ${fromNumber}`);
      if (client.waitlistEnabled !== false) {
        convo.waitlistPending = true;
        convo.waitlistContext = { service: "general inquiry", date: null };
        replyText = enforceLength(
          `Of course! Want me to save your number so the team can reach out to you directly? Reply YES to confirm, or call us now: ${client.handoffPhone} 🤙`
        );
      } else {
        replyText = enforceLength(client.handoffReply(client.handoffPhone));
      }
    }

    // FIRST MESSAGE
    else if (isNew) {
      // Check if confirmed guest (pre-seeded by booking confirmation)
      if (convo.sessionType === "confirmed_guest" && convo.bookingData?.activity) {
        replyText = enforceLength(
          `Hey! You're all set for ${convo.bookingData.activity} on ${convo.bookingData.date}. Any questions before your adventure? 🏔`
        );
      } else {
        replyText = enforceLength(getSeasonalOpener(client));
      }
    }

    // RETURNING AFTER 24H — light re-intro
    else if (returning && convo.bookingStep === null && !convo.handoff) {
      replyText = enforceLength(`Hey, ${client.botName} again — welcome back! What can I help with?`);
    }

    // WAITLIST TRIGGER — "notify me" / "let me know" proactive opt-in (any client)
    else if (
      /let me know|notify me|heads.?up when|alert me when|when.+open.*book|when.+available/i.test(rawBody) &&
      !convo.waitlistPending &&
      client.waitlistEnabled !== false
    ) {
      convo.waitlistPending = true;
      convo.waitlistContext = { service: "availability updates", date: null };
      replyText = enforceLength(
        `Happy to! We'll text you at this number when spots open. Just reply YES to confirm, or call us anytime: ${client.handoffPhone}`
      );
    }

    // ORGANIC OUTREACH YES — guest says YES after Claude organically asked about reaching out.
    // Catches the gap where Claude improvises "want me to reach out?" and the guest confirms,
    // but waitlistPending was never set (no structured trigger fired).
    // Condition: guest sent a clear YES + not mid-booking + last bot message had reach-out language.
    else if (
      /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim()) &&
      convo.bookingStep === null &&
      client.waitlistEnabled !== false &&
      /reach out|let you know|heads.?up|notify|first to know|snag a spot|save your number|add you to|call you back|get back to you|have someone|reach you|follow up|touch base/i.test(
        convo.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? ""
      )
    ) {
      await saveLead(supabase, {
        clientId:     client.id,
        fromNumber,
        contactPhone: fromNumber,
        service:      "availability interest",
        timeframe:    null,
        leadType:     "waitlist",
      });
      notifyBusinessOfLead(
        twilioClient, client, fromNumber, toNumber,
        { service: "availability interest", callback: fromNumber, timeframe: null },
        process.env.TEST_MODE === "true",
        "waitlist"
      ).catch((err) => console.error("[ORGANIC YES] notify error:", err.message));
      console.log(`[ORGANIC YES] Lead saved — ${fromNumber} confirmed reach-out interest`);
      replyText = enforceLength(
        `You're on the list! We'll reach out when it's time. Questions anytime: ${client.handoffPhone} 🤙`
      );
    }

    // BOOKING FLOW — state machine (fareharbor clients only)
    // Step null → 1: Show tour menu, ask guest to pick
    else if (intent === "booking" && convo.bookingStep === null && client.bookingMode === "fareharbor") {
      convo.bookingStep = 1;

      // Extract date from message if present (for availability check)
      const dateExtract = await anthropic.messages.create({
        model: "claude-sonnet-4-6", max_tokens: 30,
        messages: [{ role: "user", content: `Extract date as YYYY-MM-DD or null. Today is ${new Date().toISOString().slice(0,10)}. Message: "${rawBody}". Reply with JSON: {"date":"YYYY-MM-DD or null"}` }],
      }).catch(() => null);
      let extractedDate = null;
      try {
        const raw = dateExtract?.content[0]?.text ?? "";
        const m = raw.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : {};
        if (parsed.date && parsed.date !== "null") extractedDate = parsed.date;
      } catch { /* ignore */ }

      const menuOptions  = await buildTourMenu(client, season, extractedDate);
      const knowledgeCtx = await getKnowledgeContext(supabase, client);

      if (menuOptions.length === 0) {
        // No items available for online booking — don't enter step 1
        convo.bookingStep = null;
        let noItemsInstruction = `Guest wants to book but there are currently no tours or rentals available for online booking. Respond warmly and honestly — snowmobile operations are paused due to warm temps and low snow base. Mention summer RZR adventures are coming soon. Do NOT suggest any booking links or dates. Offer to have the team follow up: ${client.handoffPhone}.`;
        if (client.waitlistEnabled !== false) {
          convo.waitlistPending = true;
          convo.waitlistContext = { service: "tours/rentals", date: null };
          noItemsInstruction += ` Also ask: "Want a heads-up when we reopen for bookings? Reply YES and we'll save your number."`;
        }
        replyText = await getClaudeReply(convo, client, season, knowledgeCtx, noItemsInstruction);
      } else {
        convo.bookingStep = 1;
        convo.bookingData.menuOptions = menuOptions; // save for step 1
        let menuInstruction = formatMenuInstruction(client, menuOptions, extractedDate);
        if (isAllUnavailable(menuOptions, extractedDate) && client.waitlistEnabled !== false) {
          convo.waitlistPending = true;
          convo.waitlistContext = {
            service: extractedDate ? `tour on ${extractedDate}` : "tour/rental",
            date:    extractedDate,
          };
          menuInstruction += ` Also invite them to join the waitlist: "Want a heads-up when spots open? Reply YES and we'll save your number."`;
        }
        replyText = await getClaudeReply(convo, client, season, knowledgeCtx, menuInstruction);
      }
    }

    // Step 1 → 2: Guest picked a tour — route to its booking link (fareharbor only)
    else if (convo.bookingStep === 1 && client.bookingMode === "fareharbor") {
      // Group size >= 6 → handoff
      const groupMatch = rawBody.match(/\b([6-9]|[1-9]\d+)\b/);
      if (groupMatch && parseInt(groupMatch[1]) >= 6) {
        convo.handoff = true;
        replyText = enforceLength(
          `Great question for our team! Give us a call at ${client.handoffPhone} and we'll get you sorted 🤙`
        );
      } else {
        convo.bookingData.groupSize = groupMatch ? parseInt(groupMatch[1]) : null;

        // Match the guest's reply to a menu option by number or keyword
        const options = convo.bookingData.menuOptions ?? [];
        let chosen = null;

        const numMatch = rawBody.match(/\b([1-9])\b/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          if (idx >= 0 && idx < options.length) chosen = options[idx];
        }

        if (!chosen) {
          const t = rawBody.toLowerCase();
          chosen = options.find((o) => {
            const label = o.label.toLowerCase();
            return label.split(" ").some((word) => word.length > 4 && t.includes(word));
          }) ?? options[0];
        }

        convo.bookingData.activity = chosen?.label ?? "tour";
        convo.bookingData.company  = chosen?.company ?? "csr";
        convo.bookingStep = 2;

        const knowledgeCtx = await getKnowledgeContext(supabase, client);
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest chose: "${chosen?.label}". Send them this booking link: ${chosen?.url}. Include the full URL. Keep it warm and under 320 chars.`
        );
      }
    }

    // LEAD CAPTURE FLOW — informational clients with lead capture enabled
    // ── Step null → 1: booking intent starts the flow ──────────────────────
    else if (intent === "booking" && client.bookingMode === "informational" && client.leadCaptureEnabled && convo.leadStep === null) {
      convo.leadStep = 1;
      convo.leadData = { service: null, callback: null, timeframe: null };
      replyText = enforceLength(
        `Happy to pass your request to the team! What service do you need? (e.g. revalve, rebuild, coatings) Or call us directly at ${client.handoffPhone} 🔧`
      );
    }

    // ── Step 1 → 2: capture service, ask for callback ───────────────────────
    else if (convo.leadStep === 1 && client.bookingMode === "informational") {
      if (/call|phone|never mind|cancel|skip/i.test(rawBody)) {
        convo.leadStep = null; convo.leadData = null;
        replyText = enforceLength(client.handoffReply(client.handoffPhone));
      } else {
        convo.leadData = { ...(convo.leadData ?? {}), service: rawBody.slice(0, 200) };
        convo.leadStep = 2;
        replyText = enforceLength(
          `Got it — ${rawBody.slice(0, 60)}. Best number to reach you? (or reply 'same' to use this number)`
        );
      }
    }

    // ── Step 2 → 3: capture callback, ask for timeframe ─────────────────────
    else if (convo.leadStep === 2 && client.bookingMode === "informational") {
      const isSame = /\bsame\b|this number|this one|mine/i.test(rawBody);
      convo.leadData = { ...(convo.leadData ?? {}), callback: isSame ? fromNumber : rawBody.slice(0, 30) };
      convo.leadStep = 3;
      replyText = enforceLength(`Perfect. Any idea on timeframe? (e.g. next week, ASAP, no rush)`);
    }

    // ── Step 3: capture timeframe, save lead, confirm ────────────────────────
    else if (convo.leadStep === 3 && client.bookingMode === "informational") {
      convo.leadData = { ...(convo.leadData ?? {}), timeframe: rawBody.slice(0, 100) };
      const contactPhone = /^\+?\d/.test(convo.leadData.callback ?? "")
        ? convo.leadData.callback
        : fromNumber;

      await saveLead(supabase, {
        clientId:  client.id,
        fromNumber,
        contactPhone,
        service:   convo.leadData.service,
        timeframe: convo.leadData.timeframe,
      });

      notifyBusinessOfLead(
        twilioClient, client, fromNumber, toNumber,
        convo.leadData, process.env.TEST_MODE === "true"
      ).catch((err) => console.error("[LEADS] notify error:", err.message));

      convo.leadStep = null; // back to normal Q&A after completion
      convo.leadData = null;

      replyText = enforceLength(
        `You're all set! I've passed your request along to the team — expect a call soon 🔧 Or reach out directly: ${client.handoffPhone}`
      );
    }

    // BOOKING INTENT — informational clients without lead capture: phone CTA via Claude
    else if (intent === "booking" && client.bookingMode === "informational") {
      const knowledgeCtx = await getKnowledgeContext(supabase, client);
      replyText = await getClaudeReply(
        convo, client, season, knowledgeCtx,
        `Guest wants to schedule or book. ${client.name} does not use online booking — all scheduling is done by phone${client.supportEmail ? ` or email` : ""}. Direct them to call ${client.handoffPhone}${client.supportEmail ? ` or email ${client.supportEmail}` : ""}. Keep it warm and brief.`
      );
    }

    // DEFAULT: Claude handles everything else (all clients including informational)
    else {
      const availCtx     = await checkAvailabilityIfNeeded(rawBody, convo, client);
      const knowledgeCtx = await getKnowledgeContext(supabase, client);

      // 480 chars (3 texts) for all intents — never cut off mid-thought
      const replyMax = 480;
      replyText = await getClaudeReply(
        convo,
        client,
        season,
        knowledgeCtx,
        availCtx ? `Live availability data: ${availCtx}` : null,
        replyMax
      );

      // Detect if Claude's reply triggers a handoff
      if (/give (us|jake|him|them) a call at/i.test(replyText)) {
        convo.handoff = true;
        console.log(`[HANDOFF] Claude triggered handoff for ${fromNumber}`);
      }
    }

    } // end if (!replyText) — main routing block

    // Log and store reply
    console.log(JSON.stringify({
      ts: new Date().toISOString(), from: fromNumber,
      role: "assistant", intent, sentiment,
      chars: replyText.length, content: replyText,
    }));

    convo.messages.push({
      role:      "assistant",
      content:   replyText,
      timestamp: new Date().toISOString(),
      intent,
      sentiment: "neutral",
    });

    // 23. Save conversation to Supabase
    await saveConversation(fromNumber, toNumber, convo);

    // 24. Upsert contact to CRM + auto-tag (only for clients with CRM enabled)
    if (client.crmEnabled && crmSupabase) {
      const tags = deriveTagsFromMessage(rawBody, intent, season);
      if (returning) tags.push("repeat");
      await upsertContact(fromNumber, { source: "sms_conversation", tags }, crmSupabase);
    }

    // 25. Track campaign reply (only for clients with CRM enabled)
    if (client.crmEnabled && crmSupabase) await trackCampaignReply(fromNumber, crmSupabase);

    // 26. Send via Twilio (or return JSON in TEST_MODE / UI mode)
    if (process.env.TEST_MODE === "true" || isUiReq(req)) {
      return res.json({
        reply: replyText,
        meta: { intent, sentiment, bookingStep: convo.bookingStep, handoff: convo.handoff },
      });
    }

    await twilioClient.messages.create({ body: replyText, from: toNumber, to: fromNumber });

  } catch (error) {
    console.error("[SMS] Error:", error.message);

    if (process.env.TEST_MODE === "true" || isUiReq(req)) {
      return res.json({ reply: "Error: " + error.message });
    }

    try {
      await twilioClient.messages.create({
        body: `Hey! Having a quick issue. Give us a call at ${client.handoffPhone} and we'll help right away. Sorry!`,
        from: toNumber,
        to:   fromNumber,
      });
    } catch (sendErr) {
      console.error("[SMS] Fallback send failed:", sendErr.message);
    }
  }

  // 27. Respond to Twilio
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
});

// ─────────────────────────────────────────────────────────────────────────────
// RESET — TEST_MODE only
// ─────────────────────────────────────────────────────────────────────────────
app.post("/reset", async (req, res) => {
  if (process.env.TEST_MODE !== "true" && !isUiReq(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const from = req.body.from;
  if (from) {
    await supabase.from("conversations").delete().eq("from_number", from);
    res.json({ cleared: from });
  } else {
    await supabase.from("conversations").delete().neq("from_number", "");
    res.json({ cleared: "all" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL TEST UI — TEST_MODE only
// Browser-based QA console. Run with: npm run ui
// ─────────────────────────────────────────────────────────────────────────────
const __uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use("/public", requireUiAccess, express.static(__uiDir));
app.get("/ui", requireUiAccess, (_req, res) => res.sendFile(path.join(__uiDir, "ui.html")));

// Session state — used by UI inspector panel
app.get("/internal/session", requireUiAccess, async (req, res) => {
  const { from } = req.query;
  if (!from) return res.json(null);
  const { data } = await supabase
    .from("conversations")
    .select("messages, booking_step, booking_data, handoff, consecutive_frustrated, session_type")
    .eq("from_number", from)
    .maybeSingle();
  res.json(data ?? null);
});

// Preset test scenarios
app.get("/internal/scenarios", requireUiAccess, (_req, res) => {
  res.json([
    { id: "greeting",    label: "New guest greeting",        steps: ["hey"] },
    { id: "snow",        label: "Snow conditions",           steps: ["hey", "how much snow is up there?"] },
    { id: "avalanche",   label: "Avalanche forecast",        steps: ["hey", "what's the avalanche forecast?"] },
    { id: "weather",     label: "Weather forecast",          steps: ["hey", "what's the weather like?"] },
    { id: "beginner",    label: "Beginner booking",          steps: ["hey", "I want to book a snowmobile tour — first timer"] },
    { id: "experienced", label: "Experienced rider",         steps: ["hey", "I'm experienced, looking for advanced backcountry"] },
    { id: "group",       label: "Group handoff (7 people)",  steps: ["hey", "we have a group of 7, can we all book together?"] },
    { id: "handoff",     label: "Explicit handoff",          steps: ["hey", "I want to speak to a real person"] },
    { id: "sentiment",   label: "Sentiment escalation",      steps: ["hey", "this is terrible service", "worst experience ever"] },
    { id: "rzr",         label: "RZR summer inquiry",        steps: ["hey", "we want to rent a RZR for the day, where should we ride?"] },
    { id: "demo",        label: "DEMO trigger",              steps: ["DEMO"] },
    { id: "summitdemo",  label: "SUMMITDEMO trigger",        steps: ["SUMMITDEMO"] },
    { id: "stop",        label: "STOP opt-out",              steps: ["hey", "STOP"] },
  ]);
});

// Preview: build the exact text that would be sent — uses real production builders
// POST body: { type: "confirmation"|"followup"|"cancellation", booking: {...} }
app.post("/internal/preview", requireUiAccess, (req, res) => {
  const { type, booking } = req.body;
  let text;
  if (type === "confirmation")  text = buildConfirmationText(booking);
  else if (type === "followup") text = buildFollowUpText(booking);
  else if (type === "cancellation") text = buildCancellationText(booking);
  else return res.status(400).json({ error: "Unknown preview type" });
  res.json({ text, chars: text.length, texts: Math.ceil(text.length / 160) });
});

// Server info — UI reads this to know the phone number and season
app.get("/internal/info", requireUiAccess, (_req, res) => {
  const toPhone = process.env.TWILIO_PHONE_NUMBER || "+18668906657";
  const uiClient = resolveClient(toPhone);
  res.json({
    toPhone,
    season:     getCurrentSeason(),
    testMode:   process.env.TEST_MODE === "true",
    clientName: uiClient.name,
    clientId:   uiClient.id,
  });
});

// All configured clients — used by UI client selector
app.get("/internal/clients", requireUiAccess, (_req, res) => {
  res.json(
    Object.values(CLIENTS).map((c) => ({
      id:          c.id,
      name:        c.name,
      botName:     c.botName,
      toPhone:     c.inboundPhones[0] ?? null,
      bookingMode: c.bookingMode,
    }))
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN LEADS — Internal lead management API (protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/leads/summary", requireUiAccess, (req, res) => handleLeadsSummary(req, res, supabase));
app.get("/admin/leads",         requireUiAccess, (req, res) => handleListLeads(req, res, supabase));
app.patch("/admin/leads/:id",   requireUiAccess, (req, res) => handleUpdateLead(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED MESSAGES WORKER — called by Railway cron every minute
// POST /cron/scheduled-messages
// Set CRON_SECRET env var and pass as x-cron-secret header to protect the route.
// Railway cron config: every minute → POST /cron/scheduled-messages
// ─────────────────────────────────────────────────────────────────────────────
app.post("/cron/scheduled-messages", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await processScheduledMessages(supabase, twilioClient, crmSupabase);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[CRON] processScheduledMessages error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK — Railway uses this to confirm the app is up
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const toPhone    = process.env.TWILIO_PHONE_NUMBER || "+18668906657";
  const hcClient   = resolveClient(toPhone);
  res.json({
    status:             "Highmark running ✅",
    version:            "1.0.0",
    season:             getCurrentSeason(),
    client_id:          hcClient.id,
    client_name:        hcClient.name,
    fareharbor_enabled: hcClient.fareharborEnabled,
    booking_mode:       hcClient.bookingMode,
    phone:              toPhone,
    uptime_seconds:     Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP — only runs when executed directly (not when imported by test.js)
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  // Listen first so Railway/tests get a fast response, then init in background
  const PORT        = process.env.PORT || 3000;
  const toPhone     = process.env.TWILIO_PHONE_NUMBER || "+18668906657";
  const startClient = resolveClient(toPhone);
  app.listen(PORT, () => {
    console.log(`🏔 Highmark (${startClient.name}) running on port ${PORT} | Season: ${getCurrentSeason()} | Mode: ${startClient.bookingMode} | FH: ${startClient.fareharborEnabled}`);
  });

  // Init runs after listen — FareHarbor fetches can take several seconds
  initBookingConfirmations(app, twilioClient, supabase, crmSupabase).catch(console.error);
  initCRM(app, crmSupabase).catch(console.error);
  initKnowledgeBase(supabase, anthropic).catch(console.error);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(console.error);
}

// Export for test.js
export { app, supabase, crmSupabase, twilioClient, anthropic };
