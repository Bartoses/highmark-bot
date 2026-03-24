import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG
// Search "CLIENT_CONFIG" to find every value to update when onboarding a new
// business. These are the only things you should need to change per client.
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_NAME = "Whiteout Solutions";             // CLIENT_CONFIG
const BOOKING_LINK  = "[BOOKING_LINK]";                 // CLIENT_CONFIG: replace with actual URL
const BOT_SERVICES  = "tours, rentals, and activities"; // CLIENT_CONFIG: what this business offers

// ─────────────────────────────────────────────────────────────────────────────
// SUMMIT — SYSTEM PROMPT
// Summit is the bot's name and persona. Keep Summit consistent across clients;
// only the CLIENT_CONFIG values above change per business.
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Summit — the SMS concierge for ${BUSINESS_NAME} in Steamboat Springs, Colorado.

You're a knowledgeable Steamboat local: part ski bum, part insider guide. Casual, warm, genuinely helpful. You text like a friend who knows everything about Steamboat — not like a customer service bot.

━━━ SMS LENGTH — follow these rules exactly ━━━
- First reply of a new conversation: max 320 characters (2 texts)
- All follow-up replies: max 160 characters (1 text)
- Only go longer if the guest explicitly asks for more detail
- Cut ruthlessly. Skip filler like "Great question!" or "Of course!" — just answer
- No markdown, dashes, bullet points, or asterisks. Plain text only.
- Emojis ok but use sparingly: snow crystal, skis, mountain, snowboarder, pine tree

━━━ YOUR SERVICES ━━━
You represent ${BUSINESS_NAME}, offering ${BOT_SERVICES}.
Tie recommendations back to what ${BUSINESS_NAME} offers when it's natural.

━━━ BOOKING FLOW ━━━
When someone wants to book, follow this exact 3-step flow — one text per step:
  Step 1: Ask what activity they want to do
  Step 2: Ask what date and how many people
  Step 3: Confirm details and send the booking link
Keep each step to one casual sentence. Don't rush ahead.

━━━ HANDOFF ━━━
If someone asks something you truly can't answer — very specific pricing, complaints,
custom group requests, special accommodations — respond with exactly:
"Let me get ${BUSINESS_NAME} to reach out directly — what's the best time to call you?"
Do not guess or make up specific prices or availability.

━━━ STEAMBOAT KNOWLEDGE ━━━

Seasonal conditions (typical):
- Nov–Dec: Early season. Lower mountain open, limited terrain, great deals. Can be thin.
- Jan–Mar: Peak winter. Champagne Powder at its best. Best snow, coldest temps.
- April: Spring skiing. Warm, soft snow, long days, usually still great coverage.
- May–Oct: Summer and fall. Hiking, biking, fishing, wildflowers peak in July.

Steamboat Ski Resort:
- 169 trails, 18 lifts, 3,000 acres, summit at 10,568 ft (Storm Peak)
- Champagne Powder: Steamboat's trademark — ultra-dry, low-density snow unique to the Yampa Valley
- Yampa Valley averages 349 inches of snow per year
- Beginner trails: Preview, Yoo Hoo, Rudi's Run
- Intermediate: Morningside Park, Why Not, Rainbow
- Advanced: Chute 1, Twilight, Shadows
- Expert and glades: Christmas Tree Bowl, Pony Express, Mail Chute
- Most popular lift: Sunshine Express high-speed quad
- Gondola connects base village to mid-mountain (free)

Backcountry near Steamboat:
- Flattops Wilderness: expansive high plateau, deep snowpack, popular with splitboarders and skiers
- Buffalo Pass: 30 min from town, incredible tree skiing and snowshoeing
- Rabbit Ears Pass: closest backcountry zone to town, also the #1 snowmobile area in the region

Snowmobiling:
- Rabbit Ears Pass is the main hub — hundreds of miles of groomed trails
- Also popular: Lynx Pass, Buffalo Pass (more advanced terrain)

Other winter activities:
- Howelsen Hill: oldest ski area in Colorado, right in town — night skiing, Nordic, ski jumps
- Strawberry Park Hot Springs: 30 min drive, rustic, clothing optional after dark, 4WD recommended in winter
- Old Town Hot Springs: in town, family friendly, open daily
- Fish Creek Falls: 1-mile hike to a 283-ft waterfall, frozen and stunning in winter
- Sleigh rides, dog sledding, and snowshoeing available locally

Summer and fall activities:
- Emerald Mountain: trail network right in town, excellent mountain biking and running
- Fish Creek Falls trail: great hike spring through fall
- Yampa River: fly fishing, rafting, stand-up paddleboarding
- Steamboat Lake State Park: 45 min north, kayaking, paddleboarding, camping

Dining:
- Breakfast: Creekside Cafe, The Egg and I
- Lunch and casual: Salt and Lime (Mexican, local favorite), Carl's Tavern (burgers, great bar)
- Dinner: Cafe Diva (upscale, date night), Ore House (steaks, old-school Steamboat), Rex's American Grill, Mambo Italiano, The Laundry
- Apres: Schmiggity's, The Tap House, Bear River Bar and Grill

Logistics:
- Rabbit Ears Pass (US-40) is the main route from Denver — about 3 hours, check CDOT for road conditions
- Steamboat Springs Airport (HDN) has seasonal direct flights
- Free bus system (SST) runs frequently in season
- Town is walkable

Events:
- Winter Carnival (February): 100+ year tradition, street events, ski jumping off Howelsen Hill
- Steamboat Ski Town USA: on-mountain competitions and events throughout ski season
- Strings Music Festival (summer): nationally recognized outdoor concert series
- Hot Air Balloon Rodeo (July): one of the largest balloon events in the US
- Yampa Valley Crane Festival (fall): birding event along the Yampa River

When you don't have live data (current snow depth, today's wait times):
- Be honest, don't make it up
- Point to steamboat.com for live conditions
- Offer to have ${BUSINESS_NAME} follow up directly`;

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION STORE — keyed by phone number, in-memory for now
// TODO: migrate to Supabase (each conversation object maps cleanly to a row)
//
// Shape per number:
// {
//   messages:    [{ role, content, timestamp, intent, sentiment }],
//   bookingStep: null | "ask_activity" | "ask_date_group" | "confirm" | "followup_sent",
//   bookingData: { activity: null, date: null, groupSize: null },
//   handoff:     false   — set true when guest requests human contact
// }
// ─────────────────────────────────────────────────────────────────────────────
const conversations = {};

function initConversation() {
  return {
    messages: [],
    bookingStep: null,
    bookingData: { activity: null, date: null, groupSize: null },
    handoff: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFIERS — lightweight keyword-based, no extra API call
// TODO: replace with Claude-based classification when piping to Supabase
// ─────────────────────────────────────────────────────────────────────────────

function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/book|reserv|sign.?up|schedul/i.test(t))                       return "booking";
  if (/snow|powder|condition|grooming|report|depth|weather/i.test(t)) return "conditions";
  if (/price|cost|how much|rate|fee|charge/i.test(t))                return "pricing";
  if (/where|direction|park|location|address|hours|open|close/i.test(t)) return "logistics";
  return "info";
}

function classifySentiment(text) {
  const t = text.toLowerCase();
  if (/thank|awesome|great|perfect|love|amazing|appreciate|stoked|sick|rad/i.test(t)) return "positive";
  if (/wrong|problem|issue|cancel|refund|angry|disappoint|frustrat|terrible|worst|sucks/i.test(t)) return "frustrated";
  return "neutral";
}

// Returns true if the guest is asking for a human or escalating
function needsHandoff(text) {
  return /speak.*(human|person|manager|someone|rep)|call me back|complaint|refund|cancel.*booking/i.test(
    text.toLowerCase()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER — structured JSON to console; pipe to Supabase later
// ─────────────────────────────────────────────────────────────────────────────
function logMessage({ from, role, content, intent, sentiment }) {
  console.log(
    JSON.stringify({
      ts:        new Date().toISOString(),
      from,
      role,
      intent,
      sentiment,
      content,
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING FOLLOW-UP — fires 30 min after booking link is sent
// TODO: replace setTimeout with a Supabase-backed scheduled job so this
//       survives Railway restarts. For POC, setTimeout is fine.
// ─────────────────────────────────────────────────────────────────────────────
function scheduleBookingFollowUp(fromNumber, toNumber) {
  const THIRTY_MINUTES = 30 * 60 * 1000;

  setTimeout(async () => {
    const convo = conversations[fromNumber];
    if (!convo || convo.bookingStep !== "confirm") return; // already resolved

    const followUpText = `Hey! Did you get a chance to finish your booking? Lmk if you hit any snags.`;

    try {
      await twilioClient.messages.create({
        body: followUpText,
        from: toNumber,
        to:   fromNumber,
      });
      convo.bookingStep = "followup_sent";
      console.log(`📬 Follow-up sent to ${fromNumber}`);
    } catch (err) {
      console.error("Follow-up send failed:", err.message);
    }
  }, THIRTY_MINUTES);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CALL — strips metadata fields before sending messages to the API
// ─────────────────────────────────────────────────────────────────────────────
async function getClaudeReply(convo, extraInstruction) {
  // Claude only receives role + content; timestamp/intent/sentiment are ours
  const messages = convo.messages.map(({ role, content }) => ({ role, content }));

  const system = extraInstruction
    ? `${SYSTEM_PROMPT}\n\nCURRENT CONTEXT: ${extraInstruction}`
    : SYSTEM_PROMPT;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 300,
    system,
    messages,
  });

  return response.content[0].text;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS WEBHOOK — Twilio calls this on every inbound text
// ─────────────────────────────────────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const fromNumber  = req.body.From;
  const toNumber    = req.body.To;

  // Bail on empty/malformed requests
  if (!incomingMsg || !fromNumber) {
    res.set("Content-Type", "text/xml");
    return res.send("<Response></Response>");
  }

  const isFirstMessage = !conversations[fromNumber];
  if (isFirstMessage) conversations[fromNumber] = initConversation();

  const convo     = conversations[fromNumber];
  const intent    = classifyIntent(incomingMsg);
  const sentiment = classifySentiment(incomingMsg);

  // Log and store the incoming message
  logMessage({ from: fromNumber, role: "user", content: incomingMsg, intent, sentiment });
  convo.messages.push({
    role:      "user",
    content:   incomingMsg,
    timestamp: new Date().toISOString(),
    intent,
    sentiment,
  });

  // Keep last 20 messages (~10 exchanges) to stay within token limits
  if (convo.messages.length > 20) {
    convo.messages = convo.messages.slice(-20);
  }

  let replyText;

  try {
    // ── 1. FIRST MESSAGE: fixed greeting, no Claude call needed ──────────────
    if (isFirstMessage) {
      replyText = `Hey! I'm Summit your Steamboat concierge. Ask me about snow, activities, or booking — I got you.`;
    }

    // ── 2. HANDOFF: guest needs a human ──────────────────────────────────────
    else if (needsHandoff(incomingMsg) && !convo.handoff) {
      convo.handoff = true;
      console.log(`HANDOFF requested — from: ${fromNumber}`);
      replyText = `Let me get ${BUSINESS_NAME} to reach out directly — what's the best time to call you?`;
    }

    // ── 3. BOOKING FLOW — state machine ──────────────────────────────────────

    // Trigger: guest expresses booking intent and we're not already mid-flow
    else if (intent === "booking" && convo.bookingStep === null) {
      convo.bookingStep = "ask_activity";
      replyText = await getClaudeReply(
        convo,
        "The guest wants to book. Ask them what activity they're looking to do. One casual sentence, 160 chars max."
      );
    }

    // Step 1 → 2: received activity, now ask for date + group size
    else if (convo.bookingStep === "ask_activity") {
      convo.bookingData.activity = incomingMsg;
      convo.bookingStep          = "ask_date_group";
      replyText = await getClaudeReply(
        convo,
        `Guest wants to do: "${incomingMsg}". Ask for their preferred date and group size. One casual sentence, 160 chars max.`
      );
    }

    // Step 2 → 3: received date/group, confirm and send booking link
    else if (convo.bookingStep === "ask_date_group") {
      convo.bookingData.date     = incomingMsg; // raw input, parse later if needed
      convo.bookingStep          = "confirm";
      replyText = `Perfect! Here's your link to book ${convo.bookingData.activity}: ${BOOKING_LINK} — let me know if you need anything else!`;
      scheduleBookingFollowUp(fromNumber, toNumber);
    }

    // ── 4. DEFAULT: Claude handles everything else ────────────────────────────
    else {
      replyText = await getClaudeReply(convo, null);
    }

    // Log and store the outgoing reply
    logMessage({ from: fromNumber, role: "assistant", content: replyText, intent, sentiment: "neutral" });
    convo.messages.push({
      role:      "assistant",
      content:   replyText,
      timestamp: new Date().toISOString(),
      intent,
      sentiment: "neutral",
    });

    // Send via Twilio
    await twilioClient.messages.create({
      body: replyText,
      from: toNumber,
      to:   fromNumber,
    });

  } catch (error) {
    console.error("Error handling SMS:", error);

    // Fallback so the guest is never left hanging
    try {
      await twilioClient.messages.create({
        body: "Having a quick tech issue — try again in a sec or call us directly. Sorry!",
        from: toNumber,
        to:   fromNumber,
      });
    } catch (sendErr) {
      console.error("Fallback send also failed:", sendErr.message);
    }
  }

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK — Railway uses this to confirm the app is up
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:   "Summit is running",
    business: BUSINESS_NAME,          // CLIENT_CONFIG
    number:   process.env.TWILIO_PHONE_NUMBER,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Summit (${BUSINESS_NAME}) running on port ${PORT}`);
});
