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
import { runCrawlerForClient } from "./crawler.js";
import { saveLead, notifyBusinessOfLead } from "./leads.js";
import { resolveClient, CLIENTS, getDefaultClient, getAllClients, resolveClientById } from "./clients.js";
import { initBookingConfirmations, buildConfirmationText, buildFollowUpText, buildCancellationText } from "./bookingConfirmations.js";
import { initCRM, checkOptOut, handleOptOutKeyword, handleOptInKeyword, upsertContact, addTagsToContact, trackCampaignReply, deriveTagsFromMessage, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS } from "./crm.js";
import { processScheduledMessages } from "./scheduler.js";
import { handleListLeads, handleGetLead, handleUpdateLead, handleLeadsSummary } from "./adminLeads.js";
import { handleDemoAnalyticsSummary, handleDemoAnalyticsEvents } from "./demoAnalytics.js";
import { scheduleFollowUps, checkAndMarkLeadEngaged } from "./followUpEngine.js";
import { handleListScheduledMessages } from "./adminScheduledMessages.js";
import { handleListClients, handleGetClient, handleCreateClient, handleUpdateClient } from "./adminClients.js";
import { handleCreateCampaign, handleListCampaigns, handleGetCampaign, handleUpdateCampaign, handleSendCampaign } from "./adminCampaigns.js";
import { makePortalAuth, resolvePortalClientId } from "./portalAuth.js";
import { handlePortalMe, handlePortalDashboard, handlePortalLeads, handlePortalUpdateLead, handlePortalCampaigns, handlePortalCreateCampaign, handlePortalGetCampaign, handlePortalUpdateCampaign, handlePortalSendCampaign, handlePortalAnalytics, handlePortalSettings, handlePortalUpdateSettings, handleCreatePortalUser, handleListPortalUsers, handlePortalClients, handlePortalCreateClient, handlePortalUpdateClient, handlePortalScrapeSources, handlePortalCreateScrapeSource, handlePortalUpdateScrapeSource, handlePortalDeleteScrapeSource, handlePortalBookingOptions, handlePortalCreateBookingOption, handlePortalUpdateBookingOption, handlePortalDeleteBookingOption, handlePortalCrawlPages, handlePortalIntegrations, handlePortalMessaging, handlePortalUpdateMessaging,
  handlePortalBotConfig, handlePortalUpdateBotConfig, handlePortalBookingConfig, handlePortalUpdateBookingConfig,
  handleOnboardingAnalyze, handleOnboardingGetDraft, handleOnboardingUpdateDraft, handleOnboardingSave,
  handleOnboardingCreateClient, handlePortalFhTest, handlePortalFhSync,
  handleGetCustomIntegrations, handleCreateCustomIntegration, handleUpdateCustomIntegration,
  handleDeleteCustomIntegration, handleTestCustomIntegration,
  handleGetOptimization, handleRunOptimizationAnalysis, handleDismissInsight,
  handleGetRewrites, handleRunRewrites, handleUpdateRewriteStatus,
  handlePortalAudiencePreview,
  handlePortalEmbedConfig, handlePortalUpdateEmbedConfig,
  handlePortalAttribution,
  handlePortalPerformance } from "./adminPortal.js";
import { getCustomApiContext } from "./apiIntegrations.js";
import { getAcceptedRewriteInstruction } from "./rewriteEngine.js";
import { handleCreateInvite, handleListInvites, handleResendInvite, handleRevokeInvite, handleUpdatePortalUser, handleInviteInfo, handleAcceptInvite, handlePortalUsers, handlePortalInvites, handlePortalCreateInvite, handlePortalResendInvite, handlePortalRevokeInvite, handlePortalUpdateUser } from "./adminInvites.js";
import { handleListSiteContent, handleGetSiteSection, handleUpdateSiteSection } from "./adminSiteContent.js";
import { loadSiteContent } from "./siteContent.js";
import { loadDbClients } from "./clients.js";
import { handleDemoFlow, handleDemoFlowWithMeta } from "./demoFlow.js";
import { getRuntimeClientConfig } from "./clientConfig.js";
import { getConversationConfig, buildMainMenu, routeMenuSelection, buildConversationInstruction } from "./conversationEngine.js";
import { selectResponseMode, buildResponseModeInstruction } from "./responseMode.js";
import { resolveLiveTruth, buildTruthInstruction } from "./livetruth.js";
import { detectCancellationIntent, detectRescheduleIntent, handleCancellationMessage, handleRescheduleMessage } from "./messagingEngine.js";
import { sendMessageWeb, createWebSession, getWebClientConfig } from "./webChat.js";
import { getIdentityByPhone, loadCrossChannelContext, buildCrossChannelSummary } from "./crossChannel.js";
import { extractBookingContext, resolveBookingLink } from "./bookingLinks.js";
import { getOrchestratorReply, runOrchestrator } from "./agentOrchestrator.js";
import { detectOwner } from "./ownerMode.js";
import { callClaudeForChannel } from "./messageEngine.js";

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy — required for express-rate-limit + req.ip to work correctly
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

// IP limiter: 30 requests / minute per IP (catches bots hitting the endpoint)
// Skipped in TEST_MODE so integration tests can send many requests freely.
const ipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.TEST_MODE === "true",
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
const requirePortalAuth = makePortalAuth(supabase);
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
export function getSeasonalOpener(client, seasonOverride) {
  const c      = (client && typeof client === "object") ? client : getDefaultClient();
  const season = seasonOverride ?? getCurrentSeason();

  // Use client-configured opener if provided (e.g. Lone Pine)
  if (c.openerText) return c.openerText;

  if (c.id === "csr_rea") {
    const biz = c.name;
    const bot = c.botName ?? "Summit";
    if (season === "winter")  return `Hey! You're texting ${biz}. I'm ${bot} 🏔 your guide to snowmobiling in Steamboat. Guided tours or self-guided rental — what sounds like you?`;
    if (season === "summer")  return `Hey! You're texting ${biz}. I'm ${bot} 🏔 your guide to RZR adventures in Steamboat. Self-guided off-road fun — want to explore?`;
    return `Hey! You're texting ${biz}. I'm ${bot} 🏔 snowmobile season winding down, RZR season kicking off. What adventure are you planning?`;
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

━━━ PERSONALITY & TONE ━━━
Match your energy to the customer and the moment.
- Customer is playful or technical → match their energy; any humor must be tied to suspension, bikes, speed, or control — never generic
- Customer is concise → be concise
- Customer is frustrated → no humor, solve the problem
- Customer is uncertain → clear, direct, and reassuring
Sarcasm: joking bravado (e.g. "I want to go faster") → acknowledge with a knowing nod toward what suspension work can do. Irritated sarcasm → no jokes, acknowledge and route to Jake. Technical question → be specific and confident.
Flow: when the customer is ready to schedule or get a quote, be clear and direct. Never repeat questions already answered earlier in the conversation.

━━━ SMS RULES ━━━
- Every reply: up to 480 chars. Use as much as needed, never cut off mid-thought.
- Plain text only. No bullets, dashes, markdown. Emojis: max 1-2 per message.
- Never send 2 texts in a row without a guest reply.

━━━ RESPONSE PRIORITY (follow this order every turn) ━━━
1. Answer the question directly
2. Add one useful insight tied to the specific service or product
3. Move the conversation forward with one clear next step
4. Offer to connect them with the team before dumping a phone number
5. Provide call/email only when it is genuinely the best path

DO NOT:
- Default to "give Jake a call" at the first sign of complexity — answer it first
- Ask multiple questions at once
- Repeat information already covered in the conversation
- Re-explain after the customer says "yeah" or "sounds good" — just move forward
- Claim booking links are unavailable or not loading — all booking links are in this system prompt

PACING:
- 2–4 sentences for most replies. Longer only for option comparisons or technical explanations.
- If customer is moving toward a decision: tighten up, give clear direction.
- If customer says "yeah" / "sounds good" after a recommendation: move to next step immediately.

━━━ CONTACT INFO FAILSAFE ━━━
You are talking to the customer OVER SMS. You already have their number — it is the number they are texting from. NEVER ask for a phone number.
If collecting follow-up info: only ask for a name. One thing. Stop there.
Before including business phone/email: "Have I offered to connect them with the team?"
If NO: do not include contact details. End with a soft offer: "Want me to have the team reach out?" or "Want to get that sorted?"
If YES and they declined, or explicitly asked for it: then include it.
Never run your own multi-step data collection. One soft question, then stop.

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
  const urls        = client.bookingUrls ?? {};
  const legacyRef   = Object.entries(urls).map(([k, v]) => `${k}: ${v}`).join("\n");
  const portalLinks = (client.bookingLinks ?? []).filter((l) => l.url);
  // When portal booking links are available (including bookingUrls fallback), use them.
  // Fallback titles = raw key names (e.g. "rea_2hr_tour") so routing instructions stay valid.
  // When a client has added portal rows with human-readable titles, those appear here instead.
  const bookingRef  = portalLinks.length
    ? `Available booking links:\n${portalLinks.map((l) => `${l.title}: ${l.url}`).join("\n")}`
    : `Available booking links:\n${legacyRef}`;
  const handoff     = client.handoffPhone;

  return `You are Summit — AI SMS concierge for Colorado Sled Rentals and Rabbit Ears Adventures, Steamboat Springs CO.
Warm, stoked, genuinely local. Like a guide who loves their job. Never robotic. Never a FAQ page.
Never mention Whiteout Solutions or Highmark to guests.

━━━ PERSONALITY & TONE ━━━
Match your energy to the guest and the moment. Adjust as the conversation evolves.
- Guest is playful or joking → stay playful; humor must be tied to snowmobiles, powder, trails, RZRs, or the specific thing they're asking about — never generic
- Guest is concise → match their brevity
- Guest is technical (machines, specs, conditions, gear) → be sharper and more specific
- Guest is a first-timer or uncertain → warm, reassuring — no sarcasm
- Guest is frustrated → drop humor entirely, solve the problem
Sarcasm: playful sarcasm (e.g. "this should go great" from a first-timer) → infer real meaning, reply with a light brand-appropriate acknowledgment, then answer. Joking bravado (e.g. "I want to go as fast as possible") → match the energy, tie it to the machine or terrain. Irritated sarcasm → no humor, acknowledge and resolve.
Flow: discovery and conditions → full personality. Recommendation → tie humor to the specific machine, tour, or trail. Booking step → cleaner and more direct. Support or complaint → no humor.
Continuity: use prior turns to maintain tone. Never ask about group size, experience level, or preferences already shared. If the guest is clearly moving toward a decision, stop asking discovery questions.

━━━ SMS RULES (hard limits) ━━━
- Every reply: up to 480 chars max (3 texts). Use as much as needed, never cut off mid-thought.
- No bullets, dashes, markdown, or formatting. Plain text only.
- Emojis: max 1-2 per message. Use sparingly.
- Never send 2 texts in a row without a guest reply.
- Always end conditions replies with a natural follow-up question to keep the guest engaged (e.g. "Want to get out this weekend?" or "Want to be first to know when we reopen?").

━━━ RESPONSE PRIORITY (follow this order every turn) ━━━
1. Answer the question directly
2. Add one useful insight tied to the specific service, machine, or trail
3. Move the conversation forward with one clear next step or question
4. If buying intent is present: offer to connect them with the team (before giving a phone number)
5. Provide call/email only when it is genuinely the best path — not as a default escape

DO NOT:
- Default to "give us a call" at the first sign of complexity
- List everything available — lead with a confident recommendation
- Ask multiple questions at once
- Repeat information already in the conversation
- Re-explain after the guest says "yeah", "sounds good", or "let's do it" — just move forward
- Claim booking links are unavailable, not loading, or that you can't access them — all booking links are embedded in this system prompt and are always available

PACING:
- 2–4 sentences for most replies. Longer only for recommendations, option comparisons, or safety/logistics info.
- If guest is moving toward a decision: tighten up, give clear direction, stop asking discovery questions.
- If guest says "yeah" / "sounds good" / "let's do it" after a recommendation: transition to next step immediately — do not restart explanation.

━━━ CONTACT INFO FAILSAFE ━━━
You are talking to the guest OVER SMS. You already have their phone number — it is the number they are texting from. NEVER ask for a phone number.
If asking for any follow-up info: only ask for a name. One thing at a time.
Before including the business phone number or email in your reply: "Have I offered to connect them with the team?"
If NO: do not include contact details. End with a soft offer: "Want me to have the team reach out?" or "Want to get that set up?"
If YES and they declined, or they explicitly asked for it: then include it.
Never run multi-step data collection on your own. One soft question, then stop — the system handles the rest.

━━━ BOOKING RULES ━━━
- Same-day bookings are NOT available — minimum 1 day advance booking required. If a guest asks about today, let them know and offer the next available date.
- Never quote specific pricing — always send the booking link instead.
- Never confirm availability unless told to by LIVE DATA below.
- Never make up snow depth or trail conditions.
- Groups 6+: always handoff — never try to book via text.
- For general/ambiguous booking requests: use the browse-all links so the guest picks their own item.
- For specific tour choices: use the individual item link.
- Always include the full URL directly in your reply — never say "click here" without the link.
- RZR/UTV/off-road booking requests: ALWAYS include the Polaris Adventures URL from SUMMER ROUTING above — never give a phone number as the primary response. Customers pre-book in advance; always send the link.
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
- Turbo PRO S 4-Seater: 168HP turbo — thrill seekers, experienced riders
- General 1000 4-Seater: 100HP — families, beginner-friendly, extra storage
- Both seat 4 adults. Trailer rental available. Books via Polaris Adventures (NOT FareHarbor).
- Steamboat bookings: ${urls.rzr_steamboat ?? "(see booking links)"}
- Kremmling bookings: ${urls.rzr_kremmling ?? "(see booking links)"}
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

SUMMER ROUTING (always include the full booking URL in your reply):
Family + Steamboat → General 1000 + North Routt: ${urls.rzr_steamboat ?? ""}
Family + Kremmling → General 1000 + Kremmling BLM: ${urls.rzr_kremmling ?? ""}
Thrill seeker + Steamboat → Turbo PRO S + Buffalo Pass: ${urls.rzr_steamboat ?? ""}
First-timer / beginner → General 1000 + Kremmling BLM: ${urls.rzr_kremmling ?? ""}
Experienced + scenic → Turbo PRO S + Rabbit Ears Pass: ${urls.rzr_steamboat ?? ""}
Any RZR question → include the relevant URL above in your reply` : ""}

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
  let base;
  if (client.bookingMode === "informational") {
    base = buildSystemPromptInformational(client, knowledgeContext ?? "");
  } else {
    base = buildSystemPromptCsrRea(client, season ?? getCurrentSeason(), knowledgeContext ?? "");
  }
  // Append portal-configured custom instructions if present
  if (client.systemPromptAddon?.trim()) {
    base += `\n\n--- CUSTOM INSTRUCTIONS ---\n${client.systemPromptAddon.trim()}`;
  }
  return base;
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
  if (/what.*recommend|what.*best|which.*option|what.*should i|what.*would you|which.*is better|help me choose|what.*makes sense|what.*do you suggest|best.*for me|which.*service|what.*right for/i.test(t)) return "recommendation";
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

// Smarter truncation — cuts at the last sentence boundary before max.
// Falls back to word boundary if no suitable sentence end found.
// Does NOT append '…' when a clean sentence end is found.
export function truncateAtSentenceBoundary(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  // Find the rightmost sentence-ending punctuation in the usable range (>55% of max)
  let best = -1;
  const re = /[.!?](?:\s|$)/g;
  let m;
  while ((m = re.exec(slice)) !== null) {
    if (m.index >= max * 0.55) best = m.index + 1; // include the punctuation char
  }
  if (best > 0) return text.slice(0, best).trim();
  // Fall back to word boundary
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

// Truncates text at sentence/word boundaries before max chars.
// Updated from raw word-cut to prefer complete sentences.
export function enforceLength(text, max = 320) {
  if (text.length <= max) return text;
  return truncateAtSentenceBoundary(text, max);
}

// Ensures `url` appears in `text`. If already present or url is falsy, returns text unchanged.
// If missing, appends url on a new line. Used to guarantee Claude's response contains the link.
export function ensureUrlInResponse(text, url) {
  if (!url) return text;
  if ((text ?? "").includes(url)) return text;
  return `${text ?? ""}\n${url}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING LINK HELPERS
// Client-agnostic booking link retrieval and context-aware matching.
// Works for all booking modes — fareharbor, static_links, hybrid, informational.
// ─────────────────────────────────────────────────────────────────────────────

// Returns the active booking links for a client, normalized.
// Prefers portal-managed client_booking_options; falls back to bookingUrls.
export function getClientBookingLinks(client) {
  return (client.bookingLinks ?? []).filter((l) => l.url);
}

// True if the message is a direct/explicit request for a booking link.
export function isDirectLinkRequest(message) {
  const t = (message ?? "").toLowerCase().trim();
  if (/^(link|book|reserve|booking)$/i.test(t)) return true;
  return /\b(booking link|book now|book online|send.{0,20}link|link to book|just.*book|reserve now|get.*link|book.*direct|direct.*book|how (do i|can i|to) book online)\b/.test(t);
}

// Scores and ranks booking links against a message + optional context.
//
// Returns:
//   null                                   — no active links available
//   { link, confidence: 'high' | 'low' }   — single best match
//   { links: [...], confidence: 'medium' } — 2-3 close options (ask user to pick)
//
// Context: { season: 'winter' | 'summer' | 'shoulder' }
export function findRelevantBookingLink(message, bookingLinks, context = {}) {
  const active = (bookingLinks ?? []).filter((l) => l.url);
  if (!active.length) return null;
  if (active.length === 1) return { link: active[0], confidence: "high" };

  const text   = (message ?? "").toLowerCase();
  const season = context.season ?? null;

  const scored = active.map((link) => {
    const meta     = link.metadata_json ?? {};
    // Normalize underscores to spaces so "rzr_kremmling" matches "kremmling"
    const haystack = [
      link.title, link.description,
      Array.isArray(meta.keywords) ? meta.keywords.join(" ") : (meta.keywords ?? ""),
      meta.label, meta.location, meta.category, meta.subtype, meta.season,
    ].filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");

    let score = 0;

    // General keyword overlap (words > 3 chars)
    for (const word of text.split(/\W+/).filter((w) => w.length > 3)) {
      if (haystack.includes(word)) score += 10;
    }

    // High-value geographic matches
    if (/steamboat|steam\s*boat/i.test(text) && /steamboat/i.test(haystack)) score += 15;
    if (/kremmling|kremm/i.test(text)        && /kremmling/i.test(haystack)) score += 15;
    // Trail-area aliases — North Routt and Buffalo Pass are Steamboat-area trail systems
    if (/north\s*routt|buffalo\s*pass|buff\s*pass/i.test(text) && /steamboat/i.test(haystack))   score += 12;
    if (/rabbit\s*ears/i.test(text)                            && /rabbit|rea/i.test(haystack))   score += 12;
    if (/middle\s*park|\bblm\b/i.test(text)                    && /kremmling/i.test(haystack))    score += 12;

    // Product type matches
    if (/\brzr\b|side.?by.?side|utv|off.road/i.test(text) && /rzr|off.road|rental/i.test(haystack))  score += 10;
    if (/snowmobile|sled|guided.*tour|tour/i.test(text)    && /snowmobile|sled|tour/i.test(haystack)) score += 10;
    if (/\bguided\b/i.test(text)               && /guided/i.test(haystack))  score += 8;
    if (/self.?guided|rental|\brent\b/i.test(text) && /rental|self/i.test(haystack)) score += 8;

    // Season match
    if (season === "summer"  && /rzr|summer|off.road|rental/i.test(haystack))  score += 5;
    if (season !== "summer"  && /snowmobile|sled|tour|winter/i.test(haystack)) score += 5;
    if (meta.season && meta.season === season)                                   score += 5;

    // Slight deprioritize generic browse-all links vs. specific links
    if (/browse.?all/i.test(haystack)) score -= 3;

    return { link, score };
  }).sort((a, b) => b.score - a.score);

  const top    = scored[0];
  const second = scored[1];

  // High confidence: clear winner (score > 0 and 1.5× better than runner-up)
  if (top.score >= 10 && top.score > (second?.score ?? 0) * 1.5 + 5) {
    return { link: top.link, confidence: "high" };
  }
  // Medium confidence: 2-3 decent options — offer short disambiguation
  if (top.score > 0) {
    const candidates = scored.filter((s) => s.score > 0).slice(0, 3).map((s) => s.link);
    if (candidates.length >= 2) return { links: candidates, confidence: "medium" };
  }
  // Low confidence / no keyword match: return first (highest sort_order priority)
  return { link: active[0], confidence: "low" };
}

// True if conversation exists and last message was more than 24h ago
export function isReturningGuest(conversation) {
  if (!conversation?.messages?.length) return false;
  const lastTs = conversation.messages[conversation.messages.length - 1].timestamp;
  return Date.now() - new Date(lastTs).getTime() > 24 * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUYING SIGNAL DETECTION
// Returns { hasBuyingSignal, strength: 'none'|'low'|'medium'|'high', signals[], inferredGoal }
// Pure function — no side effects.
// ─────────────────────────────────────────────────────────────────────────────
export function detectBuyingSignals(body, convo) {
  const text     = body.toLowerCase().trim();
  const userMsgs = convo.messages.filter((m) => m.role === "user").length;
  const lastBot  = convo.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? "";
  const signals  = [];
  let strength   = "none";

  // LOW — exploring with commercial intent
  if (/what.*recommend|what.*best|which.*option|what.*different|compare|vs\b|versus|which.*should|what.*suggest/i.test(text)) {
    signals.push("seeking_recommendation"); strength = "low";
  }
  if (/can you help|you work on|do you do|do you handle|do you offer|can you fix|do you have/i.test(text)) {
    signals.push("checking_capability"); if (strength === "none") strength = "low";
  }
  if (/my (bike|sled|setup|suspension|ride|rig|ktm|yeti|trek|specialized|polaris|ski.?doo|snowmobile|rzr|utv)|\b(ktm|yeti|trek|specialized|polaris|ski.?doo|rzr|utv)\b|i (have|ride|got|run|own) (a |an )?(ktm|yeti|trek|specialized|polaris|ski.?doo|snowmobile|rzr|utv)|\bsb\d{2,3}\b|\bsc\d{2,3}\b|stumpjumper|enduro|meta\b|hightower|ripley|bronson|megatower|evo\b/i.test(text)) {
    signals.push("product_context"); if (strength === "none") strength = "low";
  }

  // MEDIUM — moving toward a decision
  if (/what.*would work|what.*make sense|what.*right for me|what.*need|what.*service|best option|best fit|what.*do i need/i.test(text)) {
    signals.push("personalized_fit"); strength = "medium";
  }
  if (/how long|turnaround|timeline|when can|next step|how.*get started|how.*process|how.*work|what.*process/i.test(text)) {
    signals.push("logistics_interest"); if (strength !== "high") strength = "medium";
  }
  if (/availability|open.*slot|when.*available|do you have.*open|opening|get.*in/i.test(text)) {
    signals.push("availability_check"); if (strength !== "high") strength = "medium";
  }

  // Agreement after bot gave a recommendation — context-dependent
  const botRecommended = /recommend|suggest|go with|try the|would work|best option|good choice|perfect for|ideal for|right for|i'?d go with|sounds like/i.test(lastBot);
  if (
    userMsgs >= 1 && botRecommended &&
    /^(yeah|yes|yep|sure|ok|okay|sounds good|that works|that'?s it|perfect|great|cool|let'?s do|i'?m in|i want|let me|that makes sense|makes sense|sounds right|exactly|yes please|that'?s what)/i.test(text)
  ) {
    signals.push("agreement_after_recommendation"); if (strength !== "high") strength = "medium";
  }

  // HIGH — ready to act
  if (/\bbook\b|schedule.*appoint|come in|when.*open|get.*started|sign.*up|let'?s do it|want to book|want to schedule|ready.*go|move forward|i'?m ready/i.test(text)) {
    signals.push("booking_intent"); strength = "high";
  }
  if (/\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}|[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i.test(text)) {
    signals.push("contact_provided"); strength = "high";
  }
  if (/have.*reach out|have.*call.*me|contact me|reach me|my (number|email|phone)|text me at|call me at/i.test(text)) {
    signals.push("explicit_contact_request"); strength = "high";
  }

  let inferredGoal = null;
  if (signals.includes("booking_intent") || signals.includes("contact_provided")) inferredGoal = "ready_to_book";
  else if (signals.includes("agreement_after_recommendation"))                     inferredGoal = "moving_forward";
  else if (signals.includes("personalized_fit") || signals.includes("logistics_interest")) inferredGoal = "needs_guidance";
  else if (signals.includes("seeking_recommendation"))                             inferredGoal = "exploring_options";

  return { hasBuyingSignal: strength !== "none", strength, signals, inferredGoal };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION STAGE MACHINE
// Stages (additive, never downgrade): new → discovery → engaged → considering
//   → high_intent → lead_capture_requested → lead_captured → closed
// Stored in convo.stage. Updated once per turn.
// ─────────────────────────────────────────────────────────────────────────────
export function updateConversationStage(convo, buyingSignals, intent, sentiment) {
  // Frustrated → handoff; already-terminal stages: don't touch
  if (sentiment === "frustrated") { convo.stage = "handoff"; return; }
  if (["handoff", "lead_captured", "closed"].includes(convo.stage)) return;

  const ORDER  = ["new", "discovery", "engaged", "considering", "high_intent", "lead_capture_requested", "lead_captured", "closed", "handoff"];
  const current = convo.stage ?? "new";
  const curIdx  = ORDER.indexOf(current);
  const userMsgCount = convo.messages.filter((m) => m.role === "user").length;

  let next = current;

  if (current === "new" && userMsgCount >= 1) next = "discovery";

  if (["new", "discovery"].includes(current)) {
    if (buyingSignals.strength === "low" || intent === "recommendation")  next = "engaged";
    if (buyingSignals.strength === "medium")                               next = "considering";
    if (buyingSignals.strength === "high")                                 next = "high_intent";
  }

  if (current === "engaged") {
    if (intent === "recommendation" || buyingSignals.signals.includes("personalized_fit") || buyingSignals.signals.includes("logistics_interest")) next = "considering";
    if (buyingSignals.strength === "high") next = "high_intent";
  }

  if (current === "considering") {
    if (buyingSignals.strength === "high" || buyingSignals.signals.includes("agreement_after_recommendation")) next = "high_intent";
  }

  // Never downgrade
  const nextIdx = ORDER.indexOf(next);
  if (nextIdx > curIdx) convo.stage = next;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD CAPTURE TRIGGER
// Returns true when intent and timing are right for a proactive soft lead ask.
// ─────────────────────────────────────────────────────────────────────────────
export function shouldAttemptLeadCapture(convo, buyingSignals, client) {
  if (["lead_captured", "handoff", "closed"].includes(convo.stage)) return false;
  if (convo.waitlistPending || convo.leadCaptureAttempted)           return false;
  if (convo.leadStep !== null)                                        return false; // mid structured-flow
  const userMsgCount = convo.messages.filter((m) => m.role === "user").length;
  if (userMsgCount < 2)                                               return false;
  if ((convo.consecutiveFrustrated ?? 0) >= 1)                       return false;
  if (!["considering", "high_intent"].includes(convo.stage))         return false;
  if (buyingSignals.strength !== "medium" && buyingSignals.strength !== "high") return false;
  if (client.waitlistEnabled === false)                               return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// NUMERIC BUYING INTENT SCORE
// Returns { score: 0-100, strength, reasons[] }
// Weighted numeric scoring — complements detectBuyingSignals() for decisions
// that need finer-grained thresholds.
// ─────────────────────────────────────────────────────────────────────────────
export function scoreBuyingIntent(body, convo) {
  const text     = body.toLowerCase().trim();
  const lastBot  = convo.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? "";
  const userMsgs = convo.messages.filter((m) => m.role === "user").length;
  let score = 0;
  const reasons = [];

  if (/what.*recommend|what.*best|which.*option|what.*should|what.*suggest|what.*would you/i.test(text)) {
    score += 15; reasons.push("seeking_recommendation");
  }
  if (/can you help|do you work on|do you do|do you handle|do you fix/i.test(text)) {
    score += 10; reasons.push("checking_capability");
  }
  if (/my (bike|sled|setup|suspension|ride|rig)|\b(ktm|yeti|trek|specialized|polaris|ski.?doo|rzr)\b|\bsb\d{2,3}\b|\bsc\d{2,3}\b/i.test(text)) {
    score += 10; reasons.push("product_context");
  }
  if (/what.*right for|what.*work for|what.*do i need|best.*for me|what.*make sense|what.*fit/i.test(text)) {
    score += 15; reasons.push("personalized_fit");
  }
  if (/how long|turnaround|next step|how.*get started|how.*process|when can i|timeline/i.test(text)) {
    score += 20; reasons.push("logistics_interest");
  }
  if (/availability|open.*slot|when.*available|do you have.*open|get.*in/i.test(text)) {
    score += 20; reasons.push("availability_check");
  }
  // Agreement after bot gave a recommendation
  const botRecommended = /recommend|suggest|go with|try the|would work|best option|good choice|perfect for|ideal for|right for|i'?d go with/i.test(lastBot);
  if (userMsgs >= 1 && botRecommended &&
    /^(yeah|yes|yep|sure|ok|okay|sounds good|that works|perfect|great|cool|let'?s do|i'?m in|exactly|makes sense|sounds right)/i.test(text)) {
    score += 25; reasons.push("agreement_after_recommendation");
  }
  if (/how do i (book|schedule|get started|proceed|move forward)|what.*(next step)|how.*sign up/i.test(text)) {
    score += 30; reasons.push("next_step_inquiry");
  }
  if (/\bbook\b|let'?s do it|want to book|ready.*go|move forward|i'?m ready|sign.*up/i.test(text)) {
    score += 40; reasons.push("booking_intent");
  }
  if (/\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}|[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i.test(text)) {
    score += 35; reasons.push("contact_provided");
  }
  if (/have.*reach out|contact me|reach me|text me at|call me at/i.test(text)) {
    score += 30; reasons.push("explicit_contact_request");
  }
  // Negative modifiers
  if (/just looking|maybe later|not now|just curious|no thanks|browsing/i.test(text)) {
    score -= 20; reasons.push("casual_browsing");
  }
  if ((convo.consecutiveFrustrated ?? 0) >= 1) {
    score -= 40; reasons.push("frustration_penalty");
  }

  score = Math.max(0, Math.min(100, score));
  let strength = "none";
  if (score >= 60)      strength = "high";
  else if (score >= 35) strength = "medium";
  else if (score >= 15) strength = "low";

  return { score, strength, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPERTISE-FIRST GUARD
// Returns true when the assistant must show expertise / answer before any
// lead capture attempt. Prevents lead capture from interrupting genuine help.
// ─────────────────────────────────────────────────────────────────────────────
export function needsExpertiseFirst(intent, buyingSignals, convo) {
  // Once we've given a recommendation, expertise has been demonstrated
  if (convo.commercialState?.recommendationGiven === true) return false;
  // Recommendation requests must always be answered before capturing
  if (intent === "recommendation") return true;
  // Personalized fit or "what's best for me" type signals need an answer first
  if (
    buyingSignals.signals.includes("personalized_fit") ||
    buyingSignals.signals.includes("seeking_recommendation")
  ) return true;
  // Short intent-revealing messages that imply a question (e.g. "u want to go fast")
  const lastUserText = convo.messages.filter((m) => m.role === "user").slice(-1)[0]?.content?.toLowerCase() ?? "";
  if (/want.*fast|go.*fast|too soft|too stiff|what.*should|best.*for/i.test(lastUserText)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MICRO-CLOSE LIBRARY
// Returns a single context-appropriate soft close.
// One per response — never stack multiple asks.
// ─────────────────────────────────────────────────────────────────────────────
export function getMicroClose(client, inferredGoal) {
  if (client.bookingMode === "informational") {
    if (inferredGoal === "ready_to_book" || inferredGoal === "moving_forward") {
      return "Want me to have Jake take a look at your setup?";
    }
    return "Want help getting that dialed in?";
  }
  // Adventure / fareharbor clients
  if (inferredGoal === "ready_to_book" || inferredGoal === "moving_forward") {
    return "Want me to help get this set up for you?";
  }
  return "Want me to have the crew reach out here with the best option?";
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE PLAN
// Deterministic decision layer — runs before the Claude call and produces a
// structured plan that tells Claude what to accomplish and what is forbidden.
// ─────────────────────────────────────────────────────────────────────────────
export function buildResponsePlan(intent, sentiment, buyingSignals, convo, client) {
  const cs             = convo.commercialState ?? {};
  const expertiseFirst = needsExpertiseFirst(intent, buyingSignals, convo);
  const forbiddenMoves = ["ask_for_phone_when_sms"]; // always forbidden in SMS

  // Primary goal
  let primaryGoal = "answer";
  if (intent === "recommendation" || expertiseFirst) primaryGoal = "recommend";
  else if (buyingSignals.signals.includes("booking_intent"))    primaryGoal = "book";

  const mustRecommend           = primaryGoal === "recommend";
  const mustIncludeLocalContext = mustRecommend ||
    buyingSignals.signals.some((s) => ["personalized_fit", "product_context", "seeking_recommendation"].includes(s));

  // Lead capture only after expertise shown and not on a recommendation turn
  const captureOk = !expertiseFirst && !mustRecommend && shouldAttemptLeadCapture(convo, buyingSignals, client);

  // Soft close: recommendation was given on a PRIOR turn and signals are present
  const shouldSoftClose = cs.recommendationGiven === true && buyingSignals.strength !== "none" && !captureOk && !mustRecommend;

  const microClose = (shouldSoftClose || captureOk)
    ? getMicroClose(client, buyingSignals.inferredGoal)
    : null;

  // Forbidden moves
  if (expertiseFirst || mustRecommend) {
    forbiddenMoves.push("lead_capture_before_recommendation");
    forbiddenMoves.push("hard_handoff_before_answer");
  }
  if (client.waitlistEnabled !== false) {
    forbiddenMoves.push("dump_contact_info_without_micro_close");
  }

  return {
    primaryGoal,
    mustAnswer:              true,
    mustRecommend,
    mustIncludeLocalContext,
    shouldSoftClose,
    shouldAttemptLeadCapture: captureOk,
    shouldHardHandoff:       false,
    forbiddenMoves,
    microClose,
  };
}

// Converts a response plan to a Claude instruction string injected as CURRENT CONTEXT
function formatResponsePlanInstruction(plan, client) {
  const lines = [];

  if (plan.mustRecommend) {
    lines.push(
      "CURRENT TURN — give a specific recommendation: (1) clear recommendation, " +
      "(2) one-sentence why, (3) local/product/use-case context. " +
      "Optional: one micro-close at the end. Do NOT attempt lead capture or include contact info."
    );
  }

  if (plan.shouldSoftClose && plan.microClose) {
    lines.push(`After answering, end with this micro-close: "${plan.microClose}"`);
  }

  if (plan.forbiddenMoves.includes("ask_for_phone_when_sms")) {
    lines.push("Do NOT ask for a phone number — the customer is in an SMS thread, their number is already known.");
  }

  if (plan.forbiddenMoves.includes("dump_contact_info_without_micro_close")) {
    const offer = plan.microClose ? `"${plan.microClose}"` : '"Want me to have the team reach out?"';
    lines.push(`Do NOT include the business phone number or email unless explicitly asked. Use a soft offer instead: ${offer}`);
  }

  if (plan.forbiddenMoves.includes("lead_capture_before_recommendation")) {
    lines.push("Do NOT ask for contact info or attempt lead capture in this response — answer first.");
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-GENERATION VALIDATORS
// Run on the generated response text before sending to catch forbidden patterns.
// ─────────────────────────────────────────────────────────────────────────────

// Returns true if the response appears to ask the customer for their phone number
export function containsPhoneAsk(text) {
  // Match patterns like "what's your number?", "best number to reach you?", "phone number?"
  // Exclude patterns that reference the business's own number ("call us at", "our number")
  if (/our (phone|number)|call us at|reach us at|contact us at/i.test(text)) return false;
  return (
    /\b(best number|your number|your phone|reach you at|what.*(number|phone).*\?)\b/i.test(text) ||
    (/\b(number|phone)\b.*\?/i.test(text) && !/\b(booking|tour|option|trail|trail number|slot|available)\b/i.test(text))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD INFO EXTRACTION
// Pulls phone and/or email from a user message (e.g. "text me at 555-123-4567").
// Returns { name, phone, email, source } or null if nothing found.
// ─────────────────────────────────────────────────────────────────────────────
export function extractLeadInfo(body) {
  const phoneMatch = body.match(/\b(\+?1?\s?[-.]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const emailMatch = body.match(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i);
  const nameMatch  = body.match(/(?:i'?m|i am|my name is|call me|it'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (!phoneMatch && !emailMatch) return null;
  return {
    name:   nameMatch  ? nameMatch[1]              : null,
    phone:  phoneMatch ? phoneMatch[1].replace(/\D/g, "") : null,
    email:  emailMatch ? emailMatch[0].toLowerCase() : null,
    source: "chat_capture",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOFT LEAD CAPTURE PROMPT BUILDER
// Generates a context-aware soft ask that fits the brand and conversation moment.
// ─────────────────────────────────────────────────────────────────────────────
function buildLeadCapturePrompt(client, inferredGoal) {
  const phone = client.handoffPhone;
  if (client.bookingMode === "informational") {
    if (inferredGoal === "moving_forward" || inferredGoal === "ready_to_book") {
      return `Want me to have the team reach out to help get that sorted? Reply YES and I'll pass your number along. Or call directly: ${phone} 🔧`;
    }
    return `Want me to have someone from the team reach out with the best fit for your situation? Reply YES to confirm, or call: ${phone} 🔧`;
  }
  // fareharbor / adventure clients
  if (inferredGoal === "moving_forward" || inferredGoal === "ready_to_book") {
    return `Want me to have someone from the team reach out to help get this set up? Reply YES and we'll text you. Or call now: ${phone} 🤙`;
  }
  return `Want me to have the team reach out with the best option for your situation? Reply YES to confirm. Or call us: ${phone} 🤙`;
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
    const bd = data.booking_data ?? {};
    return {
      isNew: false,
      convo: {
        messages:              data.messages               ?? [],
        bookingStep:           data.booking_step           ?? null,
        bookingData:           bd,
        handoff:               data.handoff                ?? false,
        consecutiveFrustrated: data.consecutive_frustrated ?? 0,
        sessionType:           data.session_type           ?? "live",
        leadStep:              data.lead_step              ?? null,
        leadData:              data.lead_data              ?? null,
        waitlistPending:       data.waitlist_pending       ?? false,
        waitlistContext:       data.waitlist_context       ?? null,
        stage:                  bd._stage                    ?? "new",
        leadCaptureAttempted:   bd._leadCaptureAttempted    ?? false,
        leadCapturePendingName: bd._leadCapturePendingName  ?? false,
        commercialState:        bd._commercialState          ?? { recommendationGiven: false, leadCaptureAttempts: 0 },
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
      stage:                 "new",
      leadCaptureAttempted:  false,
      leadCapturePendingName: false,
      commercialState:       { recommendationGiven: false, leadCaptureAttempts: 0 },
    },
  };
}

async function saveConversation(fromNumber, toNumber, convo, clientId) {
  // Persist stage + leadCaptureAttempted inside booking_data to avoid schema changes
  const bookingData = {
    ...(convo.bookingData ?? {}),
    _stage:                convo.stage                ?? "new",
    _leadCaptureAttempted: convo.leadCaptureAttempted ?? false,
    _leadCapturePendingName: convo.leadCapturePendingName ?? false,
    _commercialState:      convo.commercialState      ?? { recommendationGiven: false, leadCaptureAttempts: 0 },
  };
  await supabase.from("conversations").upsert(
    {
      from_number:            fromNumber,
      to_number:              toNumber,
      messages:               convo.messages,
      booking_step:           convo.bookingStep,
      booking_data:           bookingData,
      handoff:                convo.handoff,
      consecutive_frustrated: convo.consecutiveFrustrated,
      session_type:           convo.sessionType,
      lead_step:              convo.leadStep,
      lead_data:              convo.leadData,
      waitlist_pending:       convo.waitlistPending,
      waitlist_context:       convo.waitlistContext,
      client_id:              clientId ?? process.env.CLIENT_ID ?? "csr_rea",
      channel:                "sms",
      updated_at:             new Date().toISOString(),
    },
    { onConflict: "from_number,to_number" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CALL — Phase 11.4: delegates to callClaudeForChannel (messageEngine.js)
// Kept as a thin wrapper so all existing call sites in the SMS handler stay
// unchanged. New channels call callClaudeForChannel directly.
// ─────────────────────────────────────────────────────────────────────────────
async function getClaudeReply(convo, client, season, knowledgeContext, extraInstruction, maxLength = 320) {
  return callClaudeForChannel(anthropic, convo, client, season, knowledgeContext, extraInstruction, "sms", maxLength);
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
  let client = resolveClient(toNumber);

  // 1. Parse + validate
  if (!rawBody || !fromNumber) {
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 2. Normalize for keyword checks
  const msgUpper = rawBody.toUpperCase().trim();

  // 3. OPT-OUT check — MUST be first (TCPA legal requirement)
  //    Uses DB1 (supabase) — works for all clients regardless of CRM config
  if (OPT_OUT_KEYWORDS.includes(msgUpper)) {
    await handleOptOutKeyword(fromNumber, toNumber, twilioClient, supabase, crmSupabase, client?.name);
    if (isUiReq(req)) return res.json({ reply: `You've been unsubscribed${client?.name ? ` from ${client.name}` : ""}. Reply START to resubscribe.` });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4. OPT-IN check
  if (OPT_IN_KEYWORDS.includes(msgUpper)) {
    await handleOptInKeyword(fromNumber, toNumber, twilioClient, supabase, crmSupabase, client?.name);
    if (isUiReq(req)) return res.json({ reply: `You're resubscribed${client?.name ? ` to ${client.name} messages` : ""}. Text us anytime.` });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4.5. HELP keyword — required by TCPA/CTIA. Works even if opted out.
  if (msgUpper === "HELP") {
    const helpText = `${client.name} SMS: info & booking assistance. Msg freq varies. Msg & data rates may apply. Reply STOP to unsubscribe. Support: ${client.supportPhone}`;
    if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply: helpText });
    await twilioClient.messages.create({ body: helpText, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[HELP] Twilio send error:", err.message));
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 4.6. RESETNOW — universal reset keyword (owner / demo use).
  //      Clears the conversation and sends the appropriate opener for this client.
  //      For demo clients: fall through to handleDemoFlow (isNew=true) so they get
  //      the full demo opener with the numbered menu — same as the test console.
  if (msgUpper === "RESETNOW") {
    await supabase.from("conversations").delete()
      .eq("from_number", fromNumber).eq("to_number", toNumber);
    console.log(`[RESET] RESETNOW from ${fromNumber} on ${toNumber} — conversation cleared`);

    if (client.isDemo) {
      // Fall through to demo flow — handleDemoFlow with isNew=true sends the proper demo opener
    } else {
      const opener = enforceLength(client.openerText ?? getSeasonalOpener(client));
      if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply: opener });
      await twilioClient.messages.create({ body: opener, from: toNumber, to: fromNumber })
        .catch((err) => console.error("[RESET] Twilio send error:", err.message));
      res.set("Content-Type", "text/xml");
      return res.send("<Response></Response>");
    }
  }

  // 5. Opted-out gate — drop silently if this number has opted out (DB1, all clients)
  const isOptedOut = await checkOptOut(fromNumber, supabase);
  if (isOptedOut) {
    console.log(`[OPT-OUT] Dropping message from opted-out number ${fromNumber}`);
    if (isUiReq(req)) return res.json({ reply: "[opted out — message dropped]" });
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 5.5. Mark lead ENGAGED if this is a reply from a lead we've been following up with.
  //      Fire-and-forget — never delays the SMS response.
  checkAndMarkLeadEngaged(supabase, fromNumber);

  // 5.6. Enrich client config with DB-backed settings (feature toggles, booking links, scrape sources).
  //      Merges portal settings into the runtime client object for this request.
  //      Falls back safely if DB is unavailable or tables don't exist yet.
  client = await getRuntimeClientConfig(client, supabase);

  // 5.7. Detect owner phone — must run after getRuntimeClientConfig so ownerPhone is populated.
  //      Owner messages skip guest-routing branches (opener, returning, booking steps) and go
  //      directly to the orchestrator's internal operator mode.
  const isOwner = detectOwner(fromNumber, client);
  if (isOwner) console.log(`[OWNER] Inbound from owner phone ${fromNumber} — activating internal mode`);

  // 6. Demo mode — deterministic guided sales demo, no AI/API calls
  //    Triggered when bookingMode==="demo" OR isDemo flag (protects against DB overriding bookingMode).
  if (client.bookingMode === "demo" || client.isDemo) {
    const { isNew, convo } = await getConversation(fromNumber, toNumber);
    if (isNew && isUiReq(req)) convo.sessionType = "test";
    const { reply, meta } = await handleDemoFlowWithMeta({
      supabase, twilioClient, fromNumber, toNumber, rawBody,
      testMode: process.env.TEST_MODE === "true", isNew, convo, client,
      source: isUiReq(req) ? "ui" : "sms",
    });
    await saveConversation(fromNumber, toNumber, convo, client?.id);
    if (process.env.TEST_MODE === "true" || isUiReq(req)) return res.json({ reply, meta });
    await twilioClient.messages.create({ body: reply, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[DEMO] Twilio send error:", err.message));
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  // 7. DEMO triggers — reset conversation and send appropriate opener
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

    await twilioClient.messages.create({ body: opener, from: toNumber, to: fromNumber })
      .catch((err) => console.error("[DEMO] Twilio send error:", err.message));

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
  // Mark UI console sessions as test so they're filterable in the DB
  if (isNew && isUiReq(req)) convo.sessionType = "test";

  // Phase 11.8: SMS→Web — for new or short conversations, check if this phone
  // has a linked web session and inject that context into the system prompt.
  // Graceful: failure never delays the SMS response.
  let xchContext = null;
  if (!isOwner && (isNew || convo.messages.length < 4)) {
    const identity = await getIdentityByPhone(supabase, client.id, fromNumber).catch(() => null);
    if (identity?.session_ids?.length) {
      const webMessages = await loadCrossChannelContext(supabase, client.id, identity.session_ids).catch(() => null);
      if (webMessages?.length) {
        xchContext = buildCrossChannelSummary(webMessages, 6);
        console.log(`[CROSS_CHANNEL] SMS→Web context loaded for ${fromNumber} (${webMessages.length} web msgs)`);
      }
    }
  }

  // 7-9. Classify
  const season       = getCurrentSeason();
  const intent       = detectIntent(rawBody);
  const sentiment    = detectSentiment(rawBody);
  const returning    = !isNew && isReturningGuest(convo);
  const buyingSignals    = detectBuyingSignals(rawBody, convo);
  const convConfig       = getConversationConfig(client);

  // 9.5. Menu selection routing — only when guided flow is enabled and not mid-flow.
  //      Maps "1" / "booking" / "pricing" → intent key, which the routing block below handles.
  //      Guards: skip if in active booking/lead step, or if flagged for name capture.
  const menuKey = (
    convConfig.enable_guided_flow &&
    !convo.bookingStep &&
    !convo.leadStep &&
    !convo.waitlistPending &&
    !convo.leadCapturePendingName
  ) ? routeMenuSelection(rawBody, client) : null;

  // Override intent if the message is a menu selection — existing routing handles it
  let effectiveIntent = intent;
  if (menuKey) {
    effectiveIntent = menuKey === "recommendations" ? "recommendation" : menuKey;
    console.log(`[MENU] "${rawBody.trim()}" → menu key: ${menuKey} (intent override: ${effectiveIntent})`);
  }

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

  // Update conversation stage based on this turn's signals
  updateConversationStage(convo, buyingSignals, intent, sentiment);

  let replyText;
  let orchestratorDebug = null; // Phase 7: populated when AGENT_ORCHESTRATOR_ENABLED=true

  try {
    // NAME CAPTURE pre-flight — guest said YES on a prior turn; we asked for their name.
    // This must run before the waitlist pre-flight so it doesn't fall through to normal routing.
    if (convo.leadCapturePendingName === true) {
      const isSkip = /^(skip|no|nope|nah|n\/a|none|pass)\b/i.test(rawBody.trim());
      const name   = isSkip ? null : rawBody.trim().slice(0, 60) || null;
      const service = convo.waitlistContext?.service ?? "general inquiry";
      const date    = convo.waitlistContext?.date    ?? null;

      const waitlistLead = await saveLead(supabase, {
        clientId:     client.id,
        fromNumber,
        contactPhone: fromNumber, // always use the SMS number
        contactEmail: null,
        name,
        service,
        timeframe:    date,
        leadType:     "waitlist",
        source:       isUiReq(req) ? "ui" : "sms",
      });
      if (waitlistLead) {
        scheduleFollowUps(supabase, waitlistLead, client.outboundPhone || toNumber); // fire-and-forget
      }
      notifyBusinessOfLead(
        twilioClient, client, fromNumber, toNumber,
        { name, service, callback: fromNumber, timeframe: date },
        process.env.TEST_MODE === "true",
        "waitlist"
      ).catch((err) => console.error("[NAME CAPTURE] notify error:", err.message));
      console.log(`[NAME CAPTURE] Lead saved — ${fromNumber}${name ? ` / ${name}` : ""}`);

      convo.leadCapturePendingName = false;
      convo.waitlistContext        = null;
      convo.stage                  = "lead_captured";
      replyText = enforceLength(
        name
          ? `Perfect, ${name} — we'll text you here when it's time! Questions anytime: ${client.handoffPhone} 🤙`
          : `You're on the list! We'll text you here when it's time. Questions anytime: ${client.handoffPhone} 🤙`
      );
    }

    // WAITLIST pre-flight — runs before main routing.
    // YES/NO: handled here. Any other message: clears pending and falls through to normal routing.
    else if (convo.waitlistPending === true && client.waitlistEnabled !== false) {
      const isYes = /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim());
      const isNo  = /^(no|nope|nah|not now|skip|n)\b/i.test(rawBody.trim());
      if (isYes) {
        // We already have their phone (it's the SMS number). Ask for a name, then save on next turn.
        convo.leadCapturePendingName = true;
        replyText = enforceLength(`Got it! What name should I put on it?`);
      } else if (isNo) {
        replyText = enforceLength(`No problem! Reach us anytime at ${client.handoffPhone} 🤙`);
      }
      // Clear waitlistPending — but keep waitlistContext if we still need it for the name step
      convo.waitlistPending = false;
      if (!convo.leadCapturePendingName) convo.waitlistContext = null;
    }

    // Main routing — only runs if not already handled by waitlist pre-flight above
    if (!replyText) {

    // 11. Sentiment escalation → auto-handoff after 2 consecutive frustrated messages
    //     Skipped when humanHandoffEnabled is false (bot stays in conversation)
    if (convo.consecutiveFrustrated >= 2 && !convo.handoff && client.humanHandoffEnabled !== false) {
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
    //     Skipped when humanHandoffEnabled is false (falls through to Claude default)
    else if (effectiveIntent === "handoff" && client.humanHandoffEnabled !== false) {
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

    // CONFIRMED GUEST: Cancellation / Reschedule intent
    // Intercepts lifecycle messages from guests who have a confirmed booking.
    // Returns a deterministic reply — no Claude call needed.
    else if (
      convo.sessionType === "confirmed_guest" &&
      convo.bookingData?.activity &&
      !isNew &&
      (detectCancellationIntent(rawBody) || detectRescheduleIntent(rawBody))
    ) {
      if (detectCancellationIntent(rawBody)) {
        console.log(`[MSG] Cancellation intent from confirmed guest — ${fromNumber}`);
        replyText = enforceLength(handleCancellationMessage(convo, client));
      } else {
        console.log(`[MSG] Reschedule intent from confirmed guest — ${fromNumber}`);
        replyText = enforceLength(handleRescheduleMessage(convo, client));
      }
    }

    // FIRST MESSAGE — skip for owner phones; they go to orchestrator directly
    else if (isNew && !isOwner) {
      // Check if confirmed guest (pre-seeded by booking confirmation)
      if (convo.sessionType === "confirmed_guest" && convo.bookingData?.activity) {
        replyText = enforceLength(
          `Hey! You're all set for ${convo.bookingData.activity} on ${convo.bookingData.date}. Any questions before your adventure? 🏔`
        );
      } else {
        let opener = getSeasonalOpener(client);
        // If guided flow + show_main_menu_on_start: append numbered menu to opener
        if (convConfig.enable_guided_flow && convConfig.show_main_menu_on_start) {
          const menu = buildMainMenu(client);
          if (menu) opener = `${opener}\n\n${menu}`;
        }
        replyText = enforceLength(opener);
      }
    }

    // RETURNING AFTER 24H — light re-intro (skip for owners)
    else if (returning && convo.bookingStep === null && !convo.handoff && !isOwner) {
      replyText = enforceLength(`Hey, ${client.botName} again — welcome back! What can I help with?`);
    }

    // WAITLIST TRIGGER — "notify me" / "let me know" proactive opt-in (any client, not owner)
    else if (
      !isOwner &&
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
      !isOwner &&
      /^(yes|yeah|yep|sure|ok|okay|please|y)\b/i.test(rawBody.trim()) &&
      convo.bookingStep === null &&
      client.waitlistEnabled !== false &&
      /reach out|let you know|heads.?up|notify|first to know|snag a spot|save your number|add you to|call you back|get back to you|have someone|reach you|follow up|touch base|get in touch|connect with|talk through|in contact|pass your|pass along/i.test(
        convo.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? ""
      )
    ) {
      // Phone is already known (SMS). Ask for name, then save lead on next turn.
      convo.leadCapturePendingName = true;
      convo.waitlistContext        = convo.waitlistContext ?? { service: "availability interest", date: null };
      console.log(`[ORGANIC YES] Confirmed reach-out intent — ${fromNumber}, asking for name`);
      replyText = enforceLength(`Got it! What name should I put on it?`);
    }

    // PROACTIVE LEAD CAPTURE — fires when buying signals are strong and timing is right.
    // Sets waitlistPending so the pre-flight above handles the YES/NO on the next turn.
    // Does NOT fire for: booking intents, handoff, conditions, expertise-first, or owner.
    else if (
      !isOwner &&
      shouldAttemptLeadCapture(convo, buyingSignals, client) &&
      !needsExpertiseFirst(intent, buyingSignals, convo) &&
      intent !== "booking" && intent !== "handoff" && intent !== "conditions"
    ) {
      convo.waitlistPending      = true;
      convo.leadCaptureAttempted = true;
      convo.waitlistContext      = {
        service: buyingSignals.inferredGoal ?? "general inquiry",
        date:    null,
      };
      replyText = enforceLength(buildLeadCapturePrompt(client, buyingSignals.inferredGoal));
      console.log(`[LEAD] Proactive capture triggered — stage: ${convo.stage}, signal: ${buyingSignals.strength}, goal: ${buyingSignals.inferredGoal} — ${fromNumber}`);
    }

    // BOOKING INTENT — call_only: route directly to phone CTA (no booking links)
    else if (effectiveIntent === "booking" && client.bookingMode === "call_only") {
      const knowledgeCtx = await getKnowledgeContext(supabase, client);
      replyText = await getClaudeReply(
        convo, client, season, knowledgeCtx,
        `Guest wants to book. ${client.name} books by phone only — no online booking. Direct them to call ${client.handoffPhone}${client.supportEmail ? ` or email ${client.supportEmail}` : ""}. Keep it warm and brief.`
      );
    }

    // BOOKING INTENT — static_links or hybrid: show numbered booking link list
    else if (effectiveIntent === "booking" && (client.bookingMode === "static_links" || client.bookingMode === "hybrid")) {
      const links = (client.bookingLinks ?? []).filter((l) => l.url);
      if (links.length === 0) {
        // No links configured — fall back to phone CTA
        const knowledgeCtx = await getKnowledgeContext(supabase, client);
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest wants to book. No booking links are configured yet. Direct them to call ${client.handoffPhone}. Keep it warm and brief.`
        );
      } else {
        const numbered = links
          .map((l, i) => `${i + 1}. ${l.title}${l.description ? ` — ${l.description}` : ""}: ${l.url}`)
          .join("\n");
        const hybridCta = client.bookingMode === "hybrid" ? `\n\nOr call us: ${client.handoffPhone}` : "";
        replyText = enforceLength(`Here are your booking options:\n${numbered}${hybridCta}`, 640);
      }
    }

    // BOOKING FLOW — state machine (fareharbor clients only)
    // Step null → 1: Show tour menu, ask guest to pick.
    //   Fast path: if guest explicitly asks for "the booking link", skip the menu
    //   and send the most relevant link directly.
    else if (intent === "booking" && convo.bookingStep === null && client.bookingMode === "fareharbor") {

      // DIRECT LINK REQUEST: skip tour menu, resolve and send the best matching link immediately.
      // Uses resolveBookingLink (config → API → crawl → fallback) — no model-generated URLs.
      if (isDirectLinkRequest(rawBody)) {
        const bCtx = extractBookingContext(rawBody);
        const resolved = await resolveBookingLink({
          message: rawBody,
          entity:   bCtx.entity,
          company:  bCtx.company,
          location: bCtx.location,
          season,
          client,
          supabase,
        });
        if (resolved?.url) {
          const knowledgeCtx = await getKnowledgeContext(supabase, client);
          convo.bookingStep          = 2;
          convo.bookingData.activity = resolved.url;
          replyText = await getClaudeReply(
            convo, client, season, knowledgeCtx,
            `Guest asked for a booking link directly. Send them this link: ${resolved.url}. Include the full URL. Keep it brief and warm.`
          );
          replyText = ensureUrlInResponse(replyText, resolved.url);
        }
      }

      // Normal menu flow — runs when not a direct link request, or no portal links resolved above
      if (!replyText) {
        convo.bookingStep = 1;

        // Extract date from message if present (for availability check)
        const dateExtract = await anthropic.messages.create({
          model: "claude-sonnet-4-6", max_tokens: 30,
          messages: [{ role: "user", content: `Extract date as YYYY-MM-DD or null. Today is ${new Date().toISOString().slice(0,10)}. Message: "${rawBody}". Reply with JSON: {"date":"YYYY-MM-DD or null"}` }],
        }).catch(() => null);
        let extractedDate = null;
        try {
          const raw = dateExtract?.content[0]?.text ?? "";
          const m   = raw.match(/\{[\s\S]*\}/);
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
          convo.bookingData.menuOptions = menuOptions;
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
    }

    // Step 1 → 2: Guest picked a tour — route to its booking link (fareharbor only).
    // Previous behavior: groups ≥ 6 auto-handed off without sending a link.
    // New behavior: always send the booking link; note group logistics if size ≥ 6.
    // Handoff only fires if no booking URL is available.
    else if (convo.bookingStep === 1 && client.bookingMode === "fareharbor") {
      // Detect group size — only treat single-digit 1-5 as option picks; 6+ as group count
      const groupMatch = rawBody.match(/\b([6-9]|[1-9]\d+)\b/);
      const groupSize  = groupMatch ? parseInt(groupMatch[1]) : null;

      convo.bookingData.groupSize = groupSize;

      // Match the guest's reply to a menu option by number or keyword
      const options = convo.bookingData.menuOptions ?? [];
      let chosen    = null;

      // Only use 1-5 as option selectors to avoid confusing group count with option number
      const numMatch = rawBody.match(/\b([1-5])\b/);
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

      if (!chosen?.url) {
        // No booking URL — handoff is the right call
        convo.handoff = true;
        replyText = enforceLength(
          `Give us a call at ${client.handoffPhone} and we'll sort out all the details for you 🤙`
        );
      } else if (groupSize !== null && groupSize >= 6) {
        // Large group: send booking link + note about group logistics
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest has a group of ${groupSize}. Send them this booking link: ${chosen.url}. Include the full URL. Mention they can start the booking online and suggest calling ${client.handoffPhone} to discuss group pricing or special arrangements. Keep it warm.`
        );
        replyText = ensureUrlInResponse(replyText, chosen.url);
      } else {
        // Normal: send booking link
        replyText = await getClaudeReply(
          convo, client, season, knowledgeCtx,
          `Guest chose: "${chosen.label}". Send them this booking link: ${chosen.url}. Include the full URL. Keep it warm and brief.`
        );
        replyText = ensureUrlInResponse(replyText, chosen.url);
      }
    }

    // LEAD CAPTURE FLOW — informational clients with lead capture enabled
    // ── Step null → 1: booking intent starts the flow ──────────────────────
    else if (effectiveIntent === "booking" && client.bookingMode === "informational" && client.leadCaptureEnabled && convo.leadStep === null) {
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

      const savedLead = await saveLead(supabase, {
        clientId:  client.id,
        fromNumber,
        contactPhone,
        service:   convo.leadData.service,
        timeframe: convo.leadData.timeframe,
        source:    isUiReq(req) ? "ui" : "sms",
      });

      if (savedLead) {
        scheduleFollowUps(supabase, savedLead, client.outboundPhone || toNumber); // fire-and-forget
      }

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
    else if (effectiveIntent === "booking" && client.bookingMode === "informational") {
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

      // Phase 6: custom API integrations — inject inject_always endpoint data
      const customApiCtx    = await getCustomApiContext(supabase, client.id, rawBody).catch(() => "");
      const rewriteCtx      = await getAcceptedRewriteInstruction(supabase, client.id).catch(() => "");
      const fullKnowledgeCtx = [knowledgeCtx, customApiCtx, rewriteCtx].filter(Boolean).join("\n\n") || knowledgeCtx;

      // Live truth — resolve before Claude to prevent pitching unavailable offerings.
      // Phase 3: delegates to adapter registry (FareHarbor, Static, Hours, etc.)
      // Returns null for non-availability messages or non-integrated clients.
      const liveTruth        = await resolveLiveTruth(rawBody, client, supabase);
      const truthInstruction = buildTruthInstruction(liveTruth);

      // Phase 3: response mode — deterministic strategy selection before generation
      const responseMode     = selectResponseMode({ intent, sentiment, truth: liveTruth, buyingSignals, convo, client });
      const modeInstruction  = buildResponseModeInstruction(responseMode, client, liveTruth);
      console.log(`[MODE] ${responseMode} — ${fromNumber}`);

      // Build deterministic response plan — tells Claude what to do and what is forbidden
      const responsePlan    = buildResponsePlan(intent, sentiment, buyingSignals, convo, client);
      const planInstruction = formatResponsePlanInstruction(responsePlan, client);

      // Combine availability context with plan, conversation guidance, and response mode
      const convInstruction = buildConversationInstruction(effectiveIntent, client);
      // Owner mode: skip all guest-facing response plan instructions — they conflict with operator behavior.
      // Owner gets a clean context so the agent prompts and action results are not polluted by
      // booking nudges, lead capture directives, or sentiment escalation logic.
      let extraInstruction = isOwner ? null : ([
        xchContext        ? `CROSS-CHANNEL CONTEXT: This guest previously chatted via the website. Recent web conversation:\n${xchContext}\nContinue naturally — do not mention channel switching unless they bring it up.` : null,
        availCtx          ? `Live availability data: ${availCtx}` : null,
        planInstruction   || null,
        convInstruction   || null,
        truthInstruction  || null,
        modeInstruction   || null,
      ].filter(Boolean).join("\n\n") || null);

      // 480 chars (3 texts) — never cut off mid-thought
      const replyMax = 480;

      // Phase 5: Agent Orchestrator — routes through multi-agent system when enabled.
      // Falls back to existing getClaudeReply() path when disabled (default).
      // Enable via: AGENT_ORCHESTRATOR_ENABLED=true in Railway env vars.
      if (process.env.AGENT_ORCHESTRATOR_ENABLED === "true") {
        const orchResult = await runOrchestrator({
          message:          rawBody,
          convo,
          client,
          anthropic,
          fromNumber,
          supabase,
          crmSupabase,
          twilioClient,
          knowledgeContext: fullKnowledgeCtx,
          extraInstruction,
        });
        replyText = orchResult.reply;
        orchestratorDebug = {
          agent:     orchResult.agent,
          action:    orchResult.parsed?.action ?? null,
          context:   orchResult.context,
          ownerMode: orchResult.ownerMode,
        };
      } else {
        replyText = await getClaudeReply(convo, client, season, fullKnowledgeCtx, extraInstruction, replyMax);
      }

      // Post-generation validator: catch phone ask and regenerate once with stricter instruction
      if (containsPhoneAsk(replyText) && responsePlan.forbiddenMoves.includes("ask_for_phone_when_sms")) {
        console.warn(`[VALIDATOR] Phone ask detected — regenerating for ${fromNumber}`);
        const correction = [
          availCtx ? `Live availability data: ${availCtx}` : null,
          planInstruction || null,
          "CORRECTION: Your previous draft asked for a phone number. The customer is already texting you — remove any phone-ask and replace with a soft offer like \"Want me to have the team reach out?\"",
        ].filter(Boolean).join("\n\n");
        // Regenerate through same path (orchestrator or classic)
        if (process.env.AGENT_ORCHESTRATOR_ENABLED === "true") {
          const regenResult = await runOrchestrator({
            message:          rawBody,
            convo,
            client,
            anthropic,
            fromNumber,
            supabase,
            crmSupabase,
            twilioClient,
            knowledgeContext: fullKnowledgeCtx,
            extraInstruction: correction,
          });
          replyText       = regenResult.reply;
          orchestratorDebug = {
            agent:     regenResult.agent,
            action:    regenResult.parsed?.action ?? null,
            context:   regenResult.context,
            ownerMode: regenResult.ownerMode,
          };
        } else {
          replyText = await getClaudeReply(convo, client, season, fullKnowledgeCtx, correction, replyMax);
        }
      }

      // Track that a recommendation was given — unlocks lead capture on the next turn
      if (intent === "recommendation") {
        if (!convo.commercialState) convo.commercialState = { recommendationGiven: false, leadCaptureAttempts: 0 };
        convo.commercialState.recommendationGiven = true;
      }

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
    await saveConversation(fromNumber, toNumber, convo, client.id);

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
        meta: {
          intent, sentiment,
          bookingStep:           convo.bookingStep,
          handoff:               convo.handoff,
          stage:                 convo.stage,
          buyingSignalStrength:  buyingSignals.strength,
          buyingSignals:         buyingSignals.signals,
          recommendationGiven:   convo.commercialState?.recommendationGiven ?? false,
          // Phase 7: orchestrator debug fields (null when orchestrator disabled)
          agent:     orchestratorDebug?.agent     ?? null,
          action:    orchestratorDebug?.action    ?? null,
          context:   orchestratorDebug?.context   ?? null,
          ownerMode: orchestratorDebug?.ownerMode ?? false,
          channel:   "sms",
        },
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
// WEB CHAT — Phase 11: embed widget API
// Public (no auth) — rate-limited by IP limiter above.
// ─────────────────────────────────────────────────────────────────────────────

// Serve the embed script publicly (no auth required — it's meant to be embedded)
const __uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.get("/embed.js", (_req, res) => {
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "public, max-age=300"); // 5-min CDN cache
  res.sendFile(path.join(__uiDir, "embed.js"));
});

// Public config endpoint: returns non-secret client config for the widget.
// Phase 11.2: fetches embed_config row so widget gets full customization.
// CORS preflight for embed widget (runs on third-party sites)
app.options("/web/config/:clientId", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET");
  res.end();
});
app.options("/web/chat", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.end();
});

app.get("/web/config/:clientId", ipLimiter, async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { clientId } = req.params;
  let client = resolveClientById(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });
  try { client = await getRuntimeClientConfig(client, supabase); } catch { /* use static */ }
  let embedConfig = null;
  try {
    const { data } = await supabase.from("embed_config").select("*").eq("client_id", clientId).maybeSingle();
    embedConfig = data ?? null;
  } catch { /* no embed_config table yet — use defaults */ }
  return res.json(getWebClientConfig(client, embedConfig));
});

// Web chat message handler: same bot logic as SMS, JSON transport
app.post("/web/chat", ipLimiter, async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { clientId, sessionId, message, pageHint, pageUrl } = req.body ?? {};
  if (!clientId || !sessionId || !message?.trim()) {
    return res.status(400).json({ error: "clientId, sessionId, and message are required" });
  }

  let client = resolveClientById(clientId);
  if (!client) return res.status(404).json({ error: "Client not found" });

  try {
    client = await getRuntimeClientConfig(client, supabase);
  } catch { /* use static config */ }

  // Channel toggle: if client explicitly disables web chat, reject gracefully
  if (client.enableWebchat === false) {
    return res.status(403).json({ error: "Web chat is not enabled for this client." });
  }

  // Ensure session row exists (fire-and-forget)
  createWebSession(supabase, clientId, sessionId).catch(() => {});

  try {
    const result = await sendMessageWeb(supabase, anthropic, client, sessionId, message.trim(), {
      pageHint: pageHint ?? null,
      pageUrl:  pageUrl  ?? null,
    });

    // Phase 11.8: Web→SMS bridge — send context SMS if visitor provided a phone number
    if (result?.bridgePhone && process.env.TEST_MODE !== "true") {
      const smsFrom = client.inboundPhones?.[0];
      if (smsFrom && twilioClient) {
        twilioClient.messages.create({
          body: result.bridgePhone.message,
          from: smsFrom,
          to:   result.bridgePhone.phone,
        }).catch((err) => console.error("[CROSS_CHANNEL] Web→SMS bridge Twilio error:", err.message));
      }
    }

    // Phase 7: include channel in debug output so widget can surface it
    if (result && !result.debug) {
      result.debug = {
        channel:   "web",
        clientId,
        intent:    null,
        agent:     null,
        action:    null,
        context:   null,
        ownerMode: false,
      };
    }
    return res.json(result);
  } catch (err) {
    console.error("[WEB_CHAT] sendMessageWeb error:", err.message);
    return res.status(500).json({ error: "Bot error", reply: "Sorry, I ran into an issue. Please try again in a moment!" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL TEST UI — TEST_MODE only
// Browser-based QA console. Run with: npm run ui
// ─────────────────────────────────────────────────────────────────────────────
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
    { id: "owner_report",  label: "Owner: report query",     steps: ["give me this week's booking stats"] },
    { id: "owner_campaign",label: "Owner: campaign prompt",  steps: ["send a promo to all customers"] },
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

// All configured clients (static + DB-backed) — used by UI client selector
app.get("/internal/clients", requireUiAccess, (_req, res) => {
  res.json(
    Object.values(getAllClients()).map((c) => ({
      id:          c.id,
      name:        c.name,
      botName:     c.botName,
      toPhone:     c.inboundPhones[0] ?? null,
      bookingMode: c.bookingMode,
      tier:        c.tier ?? null,
      isDemo:      c.isDemo ?? false,
    }))
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN LEADS — Internal lead management API (protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/leads/summary", requireUiAccess, (req, res) => handleLeadsSummary(req, res, supabase));
app.get("/admin/leads",         requireUiAccess, (req, res) => handleListLeads(req, res, supabase));
app.get("/admin/leads/:id",     requireUiAccess, (req, res) => handleGetLead(req, res, supabase));
app.patch("/admin/leads/:id",   requireUiAccess, (req, res) => handleUpdateLead(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN SCHEDULED MESSAGES — Follow-up queue visibility (protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/scheduled-messages", requireUiAccess, (req, res) => handleListScheduledMessages(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DEMO ANALYTICS — Funnel event tracking (protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/demo-analytics/summary", requireUiAccess, (req, res) => handleDemoAnalyticsSummary(req, res, supabase));
app.get("/admin/demo-analytics/events",  requireUiAccess, (req, res) => handleDemoAnalyticsEvents(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CLIENTS — Client provisioning API (protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/admin/clients",       requireUiAccess, (req, res) => handleListClients(req, res));
app.get("/admin/clients/:id",   requireUiAccess, (req, res) => handleGetClient(req, res));
app.post("/admin/clients",      requireUiAccess, (req, res) => handleCreateClient(req, res, supabase));
app.patch("/admin/clients/:id", requireUiAccess, (req, res) => handleUpdateClient(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CAMPAIGNS — Campaign engine (protected by UI_SECRET)
// Requires db1_campaigns.sql migration to have been run in Supabase DB1.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/admin/campaigns",              requireUiAccess, (req, res) => handleCreateCampaign(req, res, supabase));
app.get("/admin/campaigns",               requireUiAccess, (req, res) => handleListCampaigns(req, res, supabase));
app.get("/admin/campaigns/:id",           requireUiAccess, (req, res) => handleGetCampaign(req, res, supabase));
app.patch("/admin/campaigns/:id",         requireUiAccess, (req, res) => handleUpdateCampaign(req, res, supabase));
app.post("/admin/campaigns/:id/send",     requireUiAccess, (req, res) => handleSendCampaign(req, res, supabase, crmSupabase));

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PORTAL (Chunk 10)
//
// Auth: Supabase JWT (Bearer token) — separate from the UI_SECRET admin system.
// Requires: db1_portal.sql migration + SUPABASE_ANON_KEY env var.
//
// Portal users are created via POST /admin/portal-users (UI_SECRET protected).
// Roles: internal_admin (any client) | client_user (own client only).
// ─────────────────────────────────────────────────────────────────────────────

// Public config — Supabase anon key for client-side auth init (safe to expose)
app.get("/portal/config", (_req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL     ?? null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
  });
});

// Portal static pages (no auth — frontend handles JWT redirect)
app.get("/portal",           (_req, res) => res.redirect("/portal/login"));
app.get("/portal/login",     (_req, res) => res.sendFile(path.join(__uiDir, "portal-login.html")));
// Old section URLs redirect to their new tab locations
app.get('/portal/bot-config',     (_req, res) => res.redirect(302, '/portal/settings?tab=bot'));
app.get('/portal/booking-config', (_req, res) => res.redirect(302, '/portal/settings'));
app.get('/portal/website-embed',  (_req, res) => res.redirect(302, '/portal/settings?tab=embed'));
app.get('/portal/attribution',    (_req, res) => res.redirect(302, '/portal/analytics?tab=traffic'));

// Catch-all for portal SPA sub-paths (dashboard, leads, campaigns, analytics,
// settings, conversations, knowledge, integrations, messaging, users, clients, etc.)
// login and invite have their own routes above and match first.
app.get("/portal/:section", (_req, res) => res.sendFile(path.join(__uiDir, "portal.html")));

// Portal invite acceptance — public, no auth (serves portal-accept.html)
app.get("/portal/invite",             (_req, res) => res.sendFile(path.join(__uiDir, "portal-accept.html")));
app.get("/portal/api/invite-info",    (req, res) => handleInviteInfo(req, res, supabase));
app.post("/portal/api/accept-invite", (req, res) => handleAcceptInvite(req, res, supabase));

// Portal API — all require valid Supabase JWT
app.get(  "/portal/api/me",                  requirePortalAuth, (req, res) => handlePortalMe(req, res));
app.get(  "/portal/api/clients",             requirePortalAuth, (req, res) => handlePortalClients(req, res));
app.post( "/portal/api/clients",             requirePortalAuth, (req, res) => handlePortalCreateClient(req, res, supabase));
app.patch("/portal/api/clients/:id",         requirePortalAuth, (req, res) => handlePortalUpdateClient(req, res, supabase));
app.get(  "/portal/api/dashboard",           requirePortalAuth, (req, res) => handlePortalDashboard(req, res, supabase));
app.get(  "/portal/api/leads",               requirePortalAuth, (req, res) => handlePortalLeads(req, res, supabase));
app.patch("/portal/api/leads/:id",           requirePortalAuth, (req, res) => handlePortalUpdateLead(req, res, supabase));
app.get(  "/portal/api/campaigns",                  requirePortalAuth, (req, res) => handlePortalCampaigns(req, res, supabase));
app.post( "/portal/api/campaigns",                  requirePortalAuth, (req, res) => handlePortalCreateCampaign(req, res, supabase));
app.get(  "/portal/api/campaigns/audience-preview", requirePortalAuth, (req, res) => handlePortalAudiencePreview(req, res, supabase));
app.get(  "/portal/api/campaigns/:id",              requirePortalAuth, (req, res) => handlePortalGetCampaign(req, res, supabase));
app.patch("/portal/api/campaigns/:id",              requirePortalAuth, (req, res) => handlePortalUpdateCampaign(req, res, supabase));
app.post( "/portal/api/campaigns/:id/send",         requirePortalAuth, (req, res) => handlePortalSendCampaign(req, res, supabase, crmSupabase));
app.get(  "/portal/api/analytics",           requirePortalAuth, (req, res) => handlePortalAnalytics(req, res, supabase));
app.get(  "/portal/api/settings",            requirePortalAuth, (req, res) => handlePortalSettings(req, res, supabase));
app.patch("/portal/api/settings",            requirePortalAuth, (req, res) => handlePortalUpdateSettings(req, res, supabase));
// Scrape sources CRUD
app.get(   "/portal/api/scrape-sources",         requirePortalAuth, (req, res) => handlePortalScrapeSources(req, res, supabase));
app.post(  "/portal/api/scrape-sources",         requirePortalAuth, (req, res) => handlePortalCreateScrapeSource(req, res, supabase));
app.patch( "/portal/api/scrape-sources/:id",     requirePortalAuth, (req, res) => handlePortalUpdateScrapeSource(req, res, supabase));
app.delete("/portal/api/scrape-sources/:id",     requirePortalAuth, (req, res) => handlePortalDeleteScrapeSource(req, res, supabase));
// Booking options CRUD
app.get(   "/portal/api/booking-options",        requirePortalAuth, (req, res) => handlePortalBookingOptions(req, res, supabase));
app.post(  "/portal/api/booking-options",        requirePortalAuth, (req, res) => handlePortalCreateBookingOption(req, res, supabase));
app.patch( "/portal/api/booking-options/:id",    requirePortalAuth, (req, res) => handlePortalUpdateBookingOption(req, res, supabase));
app.delete("/portal/api/booking-options/:id",    requirePortalAuth, (req, res) => handlePortalDeleteBookingOption(req, res, supabase));
// Crawler pages + manual trigger
app.get( "/portal/api/crawl-pages",   requirePortalAuth, (req, res) => handlePortalCrawlPages(req, res, supabase));
app.get( "/portal/api/integrations",  requirePortalAuth, (req, res) => handlePortalIntegrations(req, res, supabase));
app.post("/portal/api/integrations/fareharbor/test", requirePortalAuth, (req, res) => handlePortalFhTest(req, res));
app.post("/portal/api/integrations/fareharbor/sync", requirePortalAuth, (req, res) => handlePortalFhSync(req, res, supabase));
// Phase 6 — Custom API integrations
app.get(   "/portal/api/custom-integrations",         requirePortalAuth, (req, res) => handleGetCustomIntegrations(req, res, supabase));
app.post(  "/portal/api/custom-integrations",         requirePortalAuth, (req, res) => handleCreateCustomIntegration(req, res, supabase));
app.patch( "/portal/api/custom-integrations/:id",     requirePortalAuth, (req, res) => handleUpdateCustomIntegration(req, res, supabase));
app.delete("/portal/api/custom-integrations/:id",     requirePortalAuth, (req, res) => handleDeleteCustomIntegration(req, res, supabase));
app.post(  "/portal/api/custom-integrations/:id/test",requirePortalAuth, (req, res) => handleTestCustomIntegration(req, res, supabase));
// Phase 7 — Optimization Engine
app.get( "/portal/api/optimization",           requirePortalAuth, (req, res) => handleGetOptimization(req, res, supabase));
app.post("/portal/api/optimization/run",        requirePortalAuth, (req, res) => handleRunOptimizationAnalysis(req, res, supabase));
app.post("/portal/api/optimization/dismiss/:id",requirePortalAuth, (req, res) => handleDismissInsight(req, res, supabase));
// Phase 8 — Rewrite Engine
app.get(  "/portal/api/rewrites",      requirePortalAuth, (req, res) => handleGetRewrites(req, res, supabase));
app.post( "/portal/api/rewrites/run",  requirePortalAuth, (req, res) => handleRunRewrites(req, res, supabase, anthropic));
app.patch("/portal/api/rewrites/:id",  requirePortalAuth, (req, res) => handleUpdateRewriteStatus(req, res, supabase));
app.get( "/portal/api/messaging",      requirePortalAuth, (req, res) => handlePortalMessaging(req, res, supabase));
app.patch("/portal/api/messaging",     requirePortalAuth, (req, res) => handlePortalUpdateMessaging(req, res, supabase));
app.get( "/portal/api/bot-config",    requirePortalAuth, (req, res) => handlePortalBotConfig(req, res, supabase));
app.patch("/portal/api/bot-config",   requirePortalAuth, (req, res) => handlePortalUpdateBotConfig(req, res, supabase));
app.get( "/portal/api/booking-config",  requirePortalAuth, (req, res) => handlePortalBookingConfig(req, res, supabase));
app.patch("/portal/api/booking-config", requirePortalAuth, (req, res) => handlePortalUpdateBookingConfig(req, res, supabase));
// Phase 11.2 — Widget Embed Builder
app.get(  "/portal/api/embed-config",  requirePortalAuth, (req, res) => handlePortalEmbedConfig(req, res, supabase));
app.patch("/portal/api/embed-config",  requirePortalAuth, (req, res) => handlePortalUpdateEmbedConfig(req, res, supabase));
/// Phase 11.5: attribution — top pages + event counts
app.get("/portal/api/attribution",     requirePortalAuth, (req, res) => handlePortalAttribution(req, res, supabase, resolvePortalClientId));
// Phase 11.10: primary analytics metrics (chats, leads, bookings, conversion rate)
app.get("/portal/api/performance",     requirePortalAuth, (req, res) => handlePortalPerformance(req, res, supabase, resolvePortalClientId));
// Onboarding (Phase 3 — AI Auto-Config) — internal_admin only
app.post("/portal/api/onboarding/analyze",          requirePortalAuth, (req, res) => handleOnboardingAnalyze(req, res, supabase, anthropic));
app.get( "/portal/api/onboarding/drafts/:id",       requirePortalAuth, (req, res) => handleOnboardingGetDraft(req, res, supabase));
app.patch("/portal/api/onboarding/drafts/:id",      requirePortalAuth, (req, res) => handleOnboardingUpdateDraft(req, res, supabase));
app.post("/portal/api/onboarding/drafts/:id/save",  requirePortalAuth, (req, res) => handleOnboardingSave(req, res, supabase));
app.post("/portal/api/onboarding/create-client",    requirePortalAuth, (req, res) => handleOnboardingCreateClient(req, res, supabase, anthropic));
app.post("/portal/api/crawl-now",   requirePortalAuth, async (req, res) => {
  if (!req.portalUser?.isAdmin && !req.portalUser?.isClientAdmin) return res.status(403).json({ error: "Admin only" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id required" });
  const client = getAllClients()[clientId];
  if (!client)  return res.status(404).json({ error: "Client not found" });
  if (!client.crawlSettings?.enabled) return res.status(400).json({ error: "Crawler not enabled for this client" });
  runCrawlerForClient(supabase, anthropic, client).catch((err) =>
    console.error(`[CRAWLER] Portal-triggered crawl failed for ${clientId}:`, err.message)
  );
  res.json({ ok: true, message: "Crawl started — check back in a few minutes" });
});
// Portal invite + user management — requirePortalAuth (internal_admin role enforced inside handlers)
app.get(  "/portal/api/users",               requirePortalAuth, (req, res) => handlePortalUsers(req, res, supabase));
app.patch("/portal/api/users/:id",           requirePortalAuth, (req, res) => handlePortalUpdateUser(req, res, supabase));
app.get(  "/portal/api/invites",             requirePortalAuth, (req, res) => handlePortalInvites(req, res, supabase));
app.post( "/portal/api/invites",             requirePortalAuth, (req, res) => handlePortalCreateInvite(req, res, supabase));
app.post( "/portal/api/invites/:id/resend",  requirePortalAuth, (req, res) => handlePortalResendInvite(req, res, supabase));
app.post( "/portal/api/invites/:id/revoke",  requirePortalAuth, (req, res) => handlePortalRevokeInvite(req, res, supabase));

// Admin portal user management (UI_SECRET — internal only)
app.post( "/admin/portal-users",             requireUiAccess, (req, res) => handleCreatePortalUser(req, res, supabase));
app.get(  "/admin/portal-users",             requireUiAccess, (req, res) => handleListPortalUsers(req, res, supabase));
app.patch("/admin/portal-users/:id",         requireUiAccess, (req, res) => handleUpdatePortalUser(req, res, supabase));
// Admin invite management (UI_SECRET — internal only)
app.post("/admin/portal-invites",            requireUiAccess, (req, res) => handleCreateInvite(req, res, supabase));
app.get( "/admin/portal-invites",            requireUiAccess, (req, res) => handleListInvites(req, res, supabase));
app.post("/admin/portal-invites/:id/resend", requireUiAccess, (req, res) => handleResendInvite(req, res, supabase));
app.post("/admin/portal-invites/:id/revoke", requireUiAccess, (req, res) => handleRevokeInvite(req, res, supabase));

// ─────────────────────────────────────────────────────────────────────────────
// SITE CONTENT MANAGEMENT
// Public:  GET /api/site-content        — fetched by home.html overlay script
// Admin:   GET/PATCH /admin/site-content/:section  — requires UI_SECRET
//          GET /admin/site-editor                   — internal content editor UI
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/site-content", async (_req, res) => {
  const content = await loadSiteContent(supabase);
  res.json(content);
});
app.get("/admin/site-content",            requireUiAccess, (req, res) => handleListSiteContent(req, res, supabase));
app.get("/admin/site-content/:section",   requireUiAccess, (req, res) => handleGetSiteSection(req, res, supabase));
app.patch("/admin/site-content/:section", requireUiAccess, (req, res) => handleUpdateSiteSection(req, res, supabase));
app.get("/admin/site-editor",             requireUiAccess, (_req, res) => res.sendFile(path.join(__uiDir, "site-editor.html")));

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
// PUBLIC LANDING PAGE + COMPLIANCE PAGES — no auth required
// ─────────────────────────────────────────────────────────────────────────────
app.get("/home",        (_req, res) => res.redirect(301, "/"));
app.get("/privacy",     (_req, res) => res.sendFile(path.join(__uiDir, "privacy.html")));
app.get("/terms",       (_req, res) => res.sendFile(path.join(__uiDir, "terms.html")));
app.get("/sms-consent", (_req, res) => res.sendFile(path.join(__uiDir, "sms-consent.html")));
app.get("/sitemap.xml", (_req, res) => {
  res.set("Content-Type", "application/xml");
  res.sendFile(path.join(__uiDir, "sitemap.xml"));
});
app.get("/robots.txt",  (_req, res) => {
  res.set("Content-Type", "text/plain");
  res.send(`User-agent: *\nAllow: /\nDisallow: /portal/\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: https://www.usehighmark.com/sitemap.xml\n`);
});
app.get("/og-image.png", (_req, res) => {
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__uiDir, "og-image.png"));
});

// HEALTH CHECK — Railway uses this to confirm the app is up
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// LIVE DEMO PAGE — Phase 11.9
// Minimal landing page with the embed widget pre-loaded.
// ?client=CLIENT_ID (defaults to "highmark_demo")
// ─────────────────────────────────────────────────────────────────────────────
app.get("/demo", (req, res) => {
  const clientId = String(req.query.client ?? "highmark_demo").replace(/[^a-zA-Z0-9_-]/g, "");
  const client   = resolveClientById(clientId) ?? { name: "Highmark Demo", botName: "Summit" };
  const origin   = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get("host")}`;

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Try ${escHtml(client.botName ?? "Summit")} — Live Demo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f4f8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.hero{text-align:center;max-width:480px}
h1{font-size:28px;font-weight:700;color:#111;margin-bottom:12px;line-height:1.3}
p{font-size:15px;color:#6b7280;line-height:1.7;margin-bottom:8px}
.hint{margin-top:28px;font-size:13px;color:#9ca3af}
.hint span{display:inline-block;animation:bounce 1.2s ease-in-out infinite}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}
.badge{display:inline-block;background:#10b981;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;margin-bottom:16px;letter-spacing:.03em}
</style>
</head>
<body>
<div class="hero">
  <div class="badge">LIVE DEMO</div>
  <h1>👋 Say hi to ${escHtml(client.botName ?? "Summit")}</h1>
  <p>Your AI-powered guest assistant — ask about tours, availability, pricing, or anything else.</p>
  <p style="font-size:13px;color:#9ca3af">No account needed. This is the real thing.</p>
  <div class="hint">Click the chat button to get started <span>↘</span></div>
</div>
<script src="${origin}/embed.js"
  data-client="${escHtml(clientId)}"
  data-url="${origin}"
  data-exit-intent="true">
</script>
</body>
</html>`);
});

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
}

app.get("/", (req, res) => {
  if (req.headers.accept?.includes("text/html")) return res.sendFile(path.join(__uiDir, "home.html"));
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
// INIT CLIENTS — loads DB-backed clients into runtime registry at startup
// ─────────────────────────────────────────────────────────────────────────────
async function initClients(supabaseClient) {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.from("clients").select("*").eq("active", true);
  if (error) {
    console.error("[CLIENTS] DB load failed:", error.message);
    return;
  }
  loadDbClients(data ?? []);
  if ((data ?? []).length > 0) {
    console.log(`[CLIENTS] Loaded ${data.length} DB client(s): ${data.map((r) => r.id).join(", ")}`);
  }
}

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
  initClients(supabase).catch(console.error);
}

// Safety net — log unhandled rejections without crashing the process.
// Individual handlers use .catch() but this prevents any stray promise from
// taking down the server (e.g. Twilio RestException on invalid phone numbers).
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION] Caught — server continuing:", reason?.message ?? reason);
});

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch(console.error);
}

// Export for test.js
export { app, supabase, crmSupabase, twilioClient, anthropic };
