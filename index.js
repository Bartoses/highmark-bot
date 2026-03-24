import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { URLSearchParams } from "url";

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

// In-memory conversation store (per phone number)
// We'll replace this with Supabase later
const conversations = {};

// ─────────────────────────────────────────────
// SYSTEM PROMPT — this is Highmark's brain
// Customize this per client when you onboard them
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the Highmark assistant — a friendly, knowledgeable AI text concierge for outdoor businesses in Steamboat Springs, Colorado.

You help guests with:
- Current snow conditions and what to expect on the mountain
- Activity and tour recommendations based on skill level, group size, and conditions
- Booking information and availability questions
- What to wear, what to bring, and how to prepare
- Directions, parking, and logistics
- Hours of operation and pricing questions
- Local tips that only a Steamboat local would know

Your personality:
- Warm, enthusiastic, and genuinely helpful — like a knowledgeable local friend
- Concise — this is SMS, keep responses under 160 characters when possible, 320 max
- Use line breaks to make texts readable
- Never use markdown, bullet points with dashes, or formatting that looks weird in a text message
- Use plain conversational language
- Occasionally use relevant emojis (❄️ 🎿 🏔 ⛷) but don't overdo it

Steamboat Springs context you know well:
- Steamboat Ski Resort (also called "the mountain") has 169 trails, 18 lifts
- Famous for Champagne Powder — very dry, light snow unique to Steamboat
- Storm Peak is the highest point at 10,568 feet
- Morningside Park is great for intermediate skiers
- Sunshine Express is the most popular high-speed quad
- The Yampa Valley gets an average of 349 inches of snow per year
- Perry-Mansfield is a historic arts area nearby
- Strawberry Park Hot Springs is a 30 min drive — clothing optional after dark, road can be rough in winter
- Old Town Hot Springs is in town, family friendly
- Fish Creek Falls is a popular hike, frozen in winter and stunning
- Howelsen Hill is the oldest ski area in Colorado, right in town — great for locals and night skiing
- Town is walkable, the gondola connects mountain to base village
- US-40 through Rabbit Ears Pass is the main route from Denver — check CDOT for road conditions
- Popular local restaurants: Creekside Cafe, Mambo Italiano, Laundry, The Egg & I for breakfast
- Après spots: Schmiggity's, The Tap House, Bear River Bar & Grill

When you don't know something specific (like real-time snow depth today):
- Be honest that you don't have live data
- Direct them to steamboat.com for current conditions
- Or suggest they call/text the business directly for specifics

When someone wants to book:
- Ask what activity, what date, and how many people
- Tell them you can help them find the right option
- Send them to the booking link or offer to have someone call them

Always end with an open invitation to ask more questions.
Remember: you represent a local Steamboat business. Be proud of this place.`;

// ─────────────────────────────────────────────
// WEBHOOK — Twilio hits this when a text comes in
// ─────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const fromNumber = req.body.From;
  const toNumber = req.body.To;

  console.log(`📱 Incoming from ${fromNumber}: ${incomingMsg}`);

  // Initialize conversation history for this number
  if (!conversations[fromNumber]) {
    conversations[fromNumber] = [];
  }

  // Add user message to history
  conversations[fromNumber].push({
    role: "user",
    content: incomingMsg,
  });

  // Keep only last 10 messages to stay within token limits
  if (conversations[fromNumber].length > 10) {
    conversations[fromNumber] = conversations[fromNumber].slice(-10);
  }

  try {
    // Call Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[fromNumber],
    });

    const replyText = response.content[0].text;
    console.log(`🤖 Reply to ${fromNumber}: ${replyText}`);

    // Add assistant reply to history
    conversations[fromNumber].push({
      role: "assistant",
      content: replyText,
    });

    // Send reply via Twilio
    await twilioClient.messages.create({
      body: replyText,
      from: toNumber,
      to: fromNumber,
    });

    // Respond to Twilio with empty TwiML (we already sent the message)
    res.set("Content-Type", "text/xml");
    res.send("<Response></Response>");
  } catch (error) {
    console.error("❌ Error:", error);

    // Send fallback message so guest isn't left hanging
    await twilioClient.messages.create({
      body: "Hey! We're having a quick technical issue. Call us directly and we'll get you sorted right away. Sorry for the trouble!",
      from: toNumber,
      to: fromNumber,
    });

    res.set("Content-Type", "text/xml");
    res.send("<Response></Response>");
  }
});

// Health check — Railway uses this to confirm app is running
app.get("/", (req, res) => {
  res.json({
    status: "Highmark bot is running ✅",
    number: process.env.TWILIO_PHONE_NUMBER,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏔 Highmark bot running on port ${PORT}`);
});
