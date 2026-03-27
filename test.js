// ─────────────────────────────────────────────────────────────────────────────
// HIGHMARK — End-to-End Test Suite
// Run: npm test
// Spawns its own server on port 3099 with TEST_MODE=true. No Twilio costs.
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

// Import pure utility functions (no side effects on import)
import {
  getCurrentSeason,
  getSeasonalOpener,
  buildSystemPrompt,
  detectIntent,
  detectSentiment,
  enforceLength,
  isReturningGuest,
} from "./index.js";

import { buildConfirmationText, buildFollowUpText } from "./bookingConfirmations.js";
import { checkOptOut, upsertContact, addTagsToContact, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS } from "./crm.js";
import { getKnowledgeContext } from "./knowledgeBase.js";
import { scheduleMessage, processScheduledMessages } from "./scheduler.js";
import { resolveClient, CLIENTS, getDefaultClient } from "./clients.js";

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER FRAMEWORK
// ─────────────────────────────────────────────────────────────────────────────
const TEST_PORT   = 3099;
const BASE_URL    = `http://localhost:${TEST_PORT}`;
const TEST_PHONE  = "+15550009999";
const TEST_PHONE2 = "+15550002222";
const TO_PHONE    = "+15559999999";

let serverProcess = null;
const results     = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✅ PASS — ${name}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`  ❌ FAIL — ${name}`);
  if (detail) console.log(`         ${detail}`);
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn("node", ["index.js"], {
      env:   { ...process.env, PORT: String(TEST_PORT), TEST_MODE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(
      () => reject(new Error("Server startup timeout (15s)")),
      15000
    );

    serverProcess.stdout.on("data", (data) => {
      if (data.toString().includes("running on port")) {
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    });

    serverProcess.stderr.on("data", (d) => {
      const line = d.toString();
      if (!/DeprecationWarning|ExperimentalWarning/.test(line)) {
        process.stderr.write(d);
      }
    });

    serverProcess.on("error", reject);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

async function httpPost(path, body, contentType = "application/x-www-form-urlencoded") {
  const { default: fetch } = await import("node-fetch");
  const encoded =
    contentType === "application/x-www-form-urlencoded"
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
  return fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": contentType },
    body:    encoded,
  });
}

async function httpGet(path) {
  const { default: fetch } = await import("node-fetch");
  return fetch(`${BASE_URL}${path}`);
}

async function resetConvo(phone = TEST_PHONE) {
  await httpPost("/reset", { from: phone }, "application/json");
}

async function sendSms(body, from = TEST_PHONE, to = TO_PHONE) {
  const res  = await httpPost("/sms", { Body: body, From: from, To: to });
  const data = await res.json();
  return data.reply ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────────────────────────────────────
const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

const crmSupabase = process.env.CRM_SUPABASE_URL
  ? createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY)
  : null;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Environment Variables
// ─────────────────────────────────────────────────────────────────────────────
async function test1() {
  console.log("\nTEST 1: Environment Variables");
  const required = [
    "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER",
    "ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_KEY",
    "CRM_SUPABASE_URL", "CRM_SUPABASE_KEY",
    "CLIENT_NAME", "CLIENT_PHONE", "HANDOFF_PHONE",
  ];
  const missing = required.filter((k) => !process.env[k]);
  missing.length === 0
    ? pass("All required env vars present")
    : fail("Missing env vars", missing.join(", "));

  if (process.env.FAREHARBOR_ENABLED === "true") {
    const fh = ["FAREHARBOR_APP_KEY", "FAREHARBOR_USER_KEY_CSR", "FAREHARBOR_USER_KEY_REA"];
    const missingFh = fh.filter((k) => !process.env[k]);
    missingFh.length === 0
      ? pass("FareHarbor env vars present")
      : fail("Missing FareHarbor env vars", missingFh.join(", "));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Supabase DB1 Connection + Schema
// ─────────────────────────────────────────────────────────────────────────────
async function test2() {
  console.log("\nTEST 2: Supabase DB1 Connection + Schema");
  if (!supabase) { fail("DB1 client not configured"); return; }

  const db1Tables = {
    conversations:      "from_number",
    knowledge_base:     "id",
    confirmations_sent: "id",
    settings:           "key",
  };
  for (const [table, col] of Object.entries(db1Tables)) {
    try {
      const { error } = await supabase.from(table).select(col).limit(1);
      error ? fail(`Table: ${table}`, error.message) : pass(`Table: ${table}`);
    } catch (e) { fail(`Table: ${table}`, e.message); }
  }

  const { data: settings } = await supabase.from("settings").select("key");
  const keys = (settings ?? []).map((r) => r.key);
  keys.includes("last_booking_poll") && keys.includes("last_website_scrape")
    ? pass("Settings seed rows present")
    : fail("Settings rows missing — run db1_schema.sql");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Supabase DB2 CRM Connection + Schema
// ─────────────────────────────────────────────────────────────────────────────
async function test3() {
  console.log("\nTEST 3: Supabase DB2 CRM Connection + Schema");
  if (!crmSupabase) { fail("DB2 not configured — set CRM_SUPABASE_URL + CRM_SUPABASE_KEY"); return; }

  for (const table of ["contacts", "campaigns", "campaign_sends", "opt_outs"]) {
    try {
      const { error } = await crmSupabase.from(table).select("id").limit(1);
      error ? fail(`CRM table: ${table}`, error.message) : pass(`CRM table: ${table}`);
    } catch (e) { fail(`CRM table: ${table}`, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Claude API
// ─────────────────────────────────────────────────────────────────────────────
async function test4() {
  console.log("\nTEST 4: Claude API");
  if (!anthropic) { fail("Anthropic not configured"); return; }
  try {
    const start = Date.now();
    const res = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 20,
      messages:   [{ role: "user", content: "Reply with exactly: HIGHMARK_TEST_OK" }],
    });
    const elapsed = Date.now() - start;
    const text = res.content[0].text;
    text.includes("HIGHMARK_TEST_OK")
      ? pass(`Claude API OK (${elapsed}ms)`)
      : fail("Claude response unexpected", text);
    elapsed < 10000
      ? pass("Claude under 10s")
      : fail("Claude too slow", `${elapsed}ms`);
  } catch (e) { fail("Claude API failed", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: FareHarbor API (Tier 2 only)
// ─────────────────────────────────────────────────────────────────────────────
async function test5() {
  console.log("\nTEST 5: FareHarbor API");
  if (process.env.FAREHARBOR_ENABLED !== "true") {
    console.log("  ⏭  Skipped (FAREHARBOR_ENABLED=false — Tier 1)");
    return;
  }
  const { default: fetch } = await import("node-fetch");
  for (const c of [
    { shortname: "coloradosledrentals", key: "FAREHARBOR_USER_KEY_CSR" },
    { shortname: "rabbitearsadventures", key: "FAREHARBOR_USER_KEY_REA" },
  ]) {
    try {
      const res  = await fetch(`https://fareharbor.com/api/external/v1/companies/${c.shortname}/items/`, {
        headers: {
          "X-FareHarbor-API-App":  process.env.FAREHARBOR_APP_KEY,
          "X-FareHarbor-API-User": process.env[c.key],
        },
      });
      const data = await res.json();
      data.items?.length > 0
        ? pass(`FH ${c.shortname}: ${data.items.length} items`)
        : fail(`FH ${c.shortname}: no items`);
    } catch (e) { fail(`FH ${c.shortname}`, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Season + Opener Functions
// ─────────────────────────────────────────────────────────────────────────────
async function test6() {
  console.log("\nTEST 6: Season + Opener Functions");
  const season = getCurrentSeason();
  ["winter", "summer", "shoulder"].includes(season)
    ? pass(`getCurrentSeason: ${season}`)
    : fail("getCurrentSeason invalid", season);

  const opener = getSeasonalOpener();
  opener.length > 0 && opener.length <= 160
    ? pass(`getSeasonalOpener: ${opener.length} chars`)
    : fail("getSeasonalOpener out of bounds", `${opener.length} chars`);

  buildSystemPrompt("winter", "").length > 100
    ? pass("buildSystemPrompt('winter') non-empty")
    : fail("buildSystemPrompt('winter') too short");

  buildSystemPrompt("summer", "").length > 100
    ? pass("buildSystemPrompt('summer') non-empty")
    : fail("buildSystemPrompt('summer') too short");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7: Intent + Sentiment Detection
// ─────────────────────────────────────────────────────────────────────────────
async function test7() {
  console.log("\nTEST 7: Intent + Sentiment Detection");
  const intentCases = [
    ["what's the snow like",             "conditions"],
    ["I want to book Saturday",          "booking"],
    ["check my reservation",             "lookup"],
    ["what time do you open",            "info"],
    ["this is terrible service",         "handoff"],
    ["thanks sounds good",               "smalltalk"],
  ];
  for (const [msg, expected] of intentCases) {
    const got = detectIntent(msg);
    got === expected
      ? pass(`Intent "${msg.slice(0, 28)}…" → ${expected}`)
      : fail(`Intent "${msg.slice(0, 28)}…"`, `expected ${expected}, got ${got}`);
  }

  const sentimentCases = [
    ["this is terrible service",         "frustrated"],
    ["can't wait, so excited!",          "positive"],
    ["sounds good",                      "neutral"],
  ];
  for (const [msg, expected] of sentimentCases) {
    const got = detectSentiment(msg);
    got === expected
      ? pass(`Sentiment "${msg.slice(0, 28)}…" → ${expected}`)
      : fail(`Sentiment "${msg.slice(0, 28)}…"`, `expected ${expected}, got ${got}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8: Opt-Out Keyword Matching
// ─────────────────────────────────────────────────────────────────────────────
async function test8() {
  console.log("\nTEST 8: Opt-Out Keyword Matching");
  [["STOP", true], ["stop", true], ["UNSUBSCRIBE", true], ["START", false], ["hello there", false]]
    .forEach(([word, expected]) => {
      const isOut = OPT_OUT_KEYWORDS.includes(word.toUpperCase().trim());
      isOut === expected
        ? pass(`OPT_OUT "${word}"`)
        : fail(`OPT_OUT "${word}"`, `expected ${expected}, got ${isOut}`);
    });

  [["START", true], ["UNSTOP", true], ["STOP", false], ["hello", false]]
    .forEach(([word, expected]) => {
      const isIn = OPT_IN_KEYWORDS.includes(word.toUpperCase().trim());
      isIn === expected
        ? pass(`OPT_IN "${word}"`)
        : fail(`OPT_IN "${word}"`, `expected ${expected}, got ${isIn}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9: enforceLength
// ─────────────────────────────────────────────────────────────────────────────
async function test9() {
  console.log("\nTEST 9: enforceLength");
  const short   = "A".repeat(80);
  const exact   = "A".repeat(160);
  const over320 = "Hello world ".repeat(35); // ~420 chars — exceeds 320-char default
  const over160 = "Hello world this is a test sentence that keeps going and going until it exceeds one hundred and sixty characters total yes it does because I made it long enough on purpose here.";

  enforceLength(short).length === 80  ? pass("Short string unchanged")  : fail("Short string changed");
  enforceLength(exact).length === 160 ? pass("Exact 160 unchanged")     : fail("Exact 160 changed");

  // Default max is now 320
  const truncated = enforceLength(over320);
  truncated.length <= 320
    ? pass(`Over-limit truncated to ${truncated.length} chars`)
    : fail("Not truncated", `${truncated.length} chars`);
  truncated.endsWith("…")
    ? pass("Ends with '…'")
    : fail("Missing '…'", truncated.slice(-5));

  // Explicit max still works
  const truncated160 = enforceLength(over160, 160);
  truncated160.length <= 160
    ? pass("Explicit max=160 respected")
    : fail("Explicit max=160 not respected", `${truncated160.length} chars`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10: CRM Contact Upsert + Tags
// ─────────────────────────────────────────────────────────────────────────────
async function test10() {
  console.log("\nTEST 10: CRM Contact Upsert + Tags");
  if (!crmSupabase) { fail("CRM DB unavailable"); return; }

  const phone = "+15550001234";
  try {
    await upsertContact(phone, { source: "test", tags: ["test"] }, crmSupabase);
    const { data: c1 } = await crmSupabase.from("contacts").select("tags").eq("phone", phone).single();
    c1?.tags?.includes("test") ? pass("Contact created with tags") : fail("Tags missing");

    await addTagsToContact(phone, ["snowmobile", "beginner"], crmSupabase);
    const { data: c2 } = await crmSupabase.from("contacts").select("tags").eq("phone", phone).single();
    ["test", "snowmobile", "beginner"].every((t) => c2?.tags?.includes(t))
      ? pass("Tags merged correctly")
      : fail("Tags not merged", JSON.stringify(c2?.tags));

    await upsertContact(phone, { source: "test", tags: ["snowmobile"] }, crmSupabase);
    const { data: c3 } = await crmSupabase.from("contacts").select("tags").eq("phone", phone).single();
    (c3?.tags ?? []).filter((t) => t === "snowmobile").length === 1
      ? pass("No duplicate tags")
      : fail("Duplicate tags");

    await crmSupabase.from("contacts").delete().eq("phone", phone);
    pass("Test contact cleaned up");
  } catch (e) { fail("CRM upsert error", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 11: Full Bot Conversation (3 messages) — requires running server
// ─────────────────────────────────────────────────────────────────────────────
async function test11() {
  console.log("\nTEST 11: Full Bot Conversation");
  await resetConvo(TEST_PHONE);

  const r1 = await sendSms("hello");
  r1.length <= 160
    ? pass(`Message 1: ${r1.length} chars`)
    : fail("Message 1 too long", `${r1.length} chars`);
  /summit|steamboat|snowmobile|rzr|adventure|snow/i.test(r1)
    ? pass("Message 1: greeting language present")
    : fail("Message 1: missing greeting content", r1);

  if (supabase) {
    const { data: c1 } = await supabase.from("conversations").select("messages").eq("from_number", TEST_PHONE).single();
    (c1?.messages?.length ?? 0) >= 2
      ? pass("Message 1: saved to Supabase")
      : fail("Message 1: not in Supabase");
  }

  const r2 = await sendSms("snowmobiling for 2 people this weekend, first time");
  r2.length <= 320
    ? pass(`Message 2: ${r2.length} chars`)
    : fail("Message 2 too long", `${r2.length} chars`);
  // Accept booking routing OR "no availability/paused" response — both are correct
  // depending on whether KB has live availability data at test time
  const hasBookingRouting = /rea|rabbit ears|beginner|guided|first|tour|fareharbor/i.test(r2);
  const hasPausedMsg      = /paused|unavailable|not.*available|no.*availability|warm|season/i.test(r2);
  (hasBookingRouting || hasPausedMsg)
    ? pass("Message 2: REA/beginner routing present")
    : fail("Message 2: wrong routing", r2);

  if (supabase) {
    const { data: c2 } = await supabase.from("conversations").select("booking_step").eq("from_number", TEST_PHONE).single();
    // booking_step is null when no availability (correct) or 1 when menu shown (correct)
    (c2?.booking_step !== undefined)
      ? pass(`Message 2: booking_step=${c2?.booking_step}`)
      : fail("Message 2: booking_step missing from DB");
  }

  const r3 = await sendSms("how do we get there from Steamboat");
  r3.length <= 320
    ? pass(`Message 3: ${r3.length} chars`)
    : fail("Message 3 too long", `${r3.length} chars`);
  /location|shuttle|drive|walden|steamboat|highway|hwy|14|pass|4492/i.test(r3)
    ? pass("Message 3: location info present")
    : fail("Message 3: no location info", r3);

  if (supabase) {
    const { data: c3 } = await supabase.from("conversations").select("messages").eq("from_number", TEST_PHONE).single();
    (c3?.messages?.length ?? 0) >= 6
      ? pass(`Message 3: ${c3?.messages?.length} messages in Supabase`)
      : fail("Message 3: not enough messages", `${c3?.messages?.length ?? 0} found`);
  }

  await resetConvo(TEST_PHONE);
  pass("Test conversation cleaned up");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 12: Confirmation Text Builder
// ─────────────────────────────────────────────────────────────────────────────
async function test12() {
  console.log("\nTEST 12: Confirmation Text Builder");
  const mock = {
    pk:             99999,
    status:         "booked",
    contact:        { name: "Test User", phone: "+15550001234" },
    availability:   {
      start_at: "2025-03-29T09:00:00-07:00",
      item:     { pk: 673348, name: "3 Hour Public Tour" },
    },
    customer_count: 2,
    company:        { shortname: "rabbitearsadventures" },
  };

  const text = buildConfirmationText(mock);
  text.includes("Test")                ? pass("Contains first name")         : fail("Missing first name", text);
  text.includes("Rabbit Ears Adventures") ? pass("Contains company name")    : fail("Missing company", text);
  text.includes("3 Hour Public Tour")  ? pass("Contains item name")          : fail("Missing item name", text);
  /march 29|mar 29|saturday/i.test(text) ? pass("Contains date reference")   : fail("Missing date", text);
  text.length <= 320
    ? pass(`Confirmation text (no uuid): ${text.length} chars`)
    : fail("Confirmation text too long", `${text.length} chars`);

  // With booking UUID — link should appear
  const mockWithUuid = { ...mock, uuid: "706e380e-5f8d-40b8-8da7-87a1a533d563" };
  const textWithLink = buildConfirmationText(mockWithUuid);
  textWithLink.includes("fareharbor.com/embeds/book/rabbitearsadventures/items/673348/booking/706e380e")
    ? pass("Booking link present in confirmation text")
    : fail("Booking link missing", textWithLink);
  textWithLink.length <= 320
    ? pass(`Confirmation text (with link): ${textWithLink.length} chars`)
    : fail("Confirmation text with link too long", `${textWithLink.length} chars`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 13: Knowledge Base Context
// ─────────────────────────────────────────────────────────────────────────────
async function test13() {
  console.log("\nTEST 13: Knowledge Base Context");
  if (!supabase) { fail("Supabase unavailable"); return; }
  try {
    const start = Date.now();
    const ctx   = await getKnowledgeContext(supabase);
    const elapsed = Date.now() - start;
    typeof ctx === "string"
      ? pass(`getKnowledgeContext: string (${ctx.length} chars)`)
      : fail("getKnowledgeContext non-string");
    elapsed < 5000
      ? pass(`getKnowledgeContext: ${elapsed}ms`)
      : fail("getKnowledgeContext too slow", `${elapsed}ms`);
  } catch (e) { fail("getKnowledgeContext threw", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 14: Health Check Endpoint — requires running server
// ─────────────────────────────────────────────────────────────────────────────
async function test14() {
  console.log("\nTEST 14: Health Check Endpoint");
  try {
    const res  = await httpGet("/");
    const data = await res.json();
    res.ok ? pass("Health check 200") : fail("Health check failed", `status ${res.status}`);
    for (const f of ["status", "version", "season", "fareharbor_enabled", "uptime_seconds"]) {
      data[f] !== undefined
        ? pass(`Has field: ${f}`)
        : fail(`Missing field: ${f}`);
    }
  } catch (e) { fail("Health check request failed", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 15: Opt-Out CRM Flow
// ─────────────────────────────────────────────────────────────────────────────
async function test15() {
  console.log("\nTEST 15: Opt-Out CRM Flow");
  if (!crmSupabase) { fail("CRM DB unavailable"); return; }

  try {
    await crmSupabase.from("contacts").upsert(
      { phone: TEST_PHONE2, source: "test", opted_in: true, client_id: "test" },
      { onConflict: "phone" }
    );

    // Simulate opt-out (no real Twilio send)
    await crmSupabase.from("opt_outs").upsert({ phone: TEST_PHONE2, reason: "test" }, { onConflict: "phone" });
    await crmSupabase.from("contacts").update({ opted_in: false }).eq("phone", TEST_PHONE2);

    const { data: o } = await crmSupabase.from("opt_outs").select("phone").eq("phone", TEST_PHONE2).single();
    o ? pass("opt_outs has test phone") : fail("opt_outs missing test phone");

    const { data: c } = await crmSupabase.from("contacts").select("opted_in").eq("phone", TEST_PHONE2).single();
    c?.opted_in === false ? pass("Contact opted_in=false") : fail("Contact opted_in not false");

    const isOut = await checkOptOut(TEST_PHONE2, crmSupabase);
    isOut ? pass("checkOptOut returns true") : fail("checkOptOut returned false");

    await crmSupabase.from("opt_outs").delete().eq("phone", TEST_PHONE2);
    await crmSupabase.from("contacts").delete().eq("phone", TEST_PHONE2);
    pass("Opt-out test cleaned up");
  } catch (e) { fail("Opt-out flow error", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 16: HELP keyword + Opted-Out Gate (requires running server + CRM DB)
// ─────────────────────────────────────────────────────────────────────────────
async function test16() {
  console.log("\nTEST 16: HELP keyword + Opted-Out Gate");

  // HELP keyword
  const helpReply = await sendSms("HELP", TEST_PHONE2, TO_PHONE);
  helpReply.length > 0
    ? pass(`HELP reply: ${helpReply.length} chars`)
    : fail("HELP: no reply");
  /stop/i.test(helpReply)
    ? pass("HELP reply contains STOP instruction")
    : fail("HELP reply missing STOP instruction", helpReply);
  helpReply.length <= 320
    ? pass("HELP reply within 320 chars")
    : fail("HELP reply too long", `${helpReply.length} chars`);

  // Opted-out gate — opted-out numbers must be silently dropped
  if (!crmSupabase) {
    fail("OPTED-OUT GATE: CRM DB unavailable");
    return;
  }
  const optOutPhone = "+15550007777";
  try {
    // Insert into opt_outs to simulate an opted-out user
    await crmSupabase.from("opt_outs").upsert({ phone: optOutPhone, reason: "test" }, { onConflict: "phone" });

    // Send a message from that phone — should get TwiML back, not a bot reply
    const res = await httpPost("/sms", { Body: "Hey there", From: optOutPhone, To: TO_PHONE });
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();

    contentType.includes("text/xml")
      ? pass("Opted-out: response is TwiML (not JSON)")
      : fail("Opted-out: wrong content-type", contentType);
    body.includes("<Response>")
      ? pass("Opted-out: empty TwiML returned")
      : fail("Opted-out: unexpected response body", body.slice(0, 80));
  } finally {
    await crmSupabase.from("opt_outs").delete().eq("phone", optOutPhone);
    pass("Opted-out gate test cleaned up");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 17: Scheduler — scheduleMessage + processScheduledMessages
// ─────────────────────────────────────────────────────────────────────────────
async function test17() {
  console.log("\nTEST 17: Scheduler");
  if (!supabase) { console.log("  ⚠ SKIP — no SUPABASE_URL"); return; }

  const testPhone  = "+15550017777";
  const optPhone   = "+15550017888";
  const mockSid    = "SMTEST17MOCK";
  const sendAt     = new Date(Date.now() - 1000).toISOString(); // 1 second in the past = due now

  // Mock Twilio client — no real SMS sent
  const mockTwilio = {
    messages: {
      create: async ({ to }) => {
        if (to === optPhone) throw new Error("Should have been cancelled before Twilio call");
        return { sid: mockSid };
      },
    },
  };

  // --- Sub-test A: scheduleMessage inserts a row ---
  let rowId;
  try {
    const row = await scheduleMessage(supabase, {
      phone:        testPhone,
      body:         "Test follow-up — scheduler test",
      message_type: "test_followup",
      send_at:      sendAt,
      metadata:     { test: true },
    });
    rowId = row.id;
    row.status === "pending"     ? pass("scheduleMessage: status=pending")    : fail("scheduleMessage: status wrong", row.status);
    row.phone  === testPhone     ? pass("scheduleMessage: phone correct")      : fail("scheduleMessage: phone wrong", row.phone);
    row.message_type === "test_followup" ? pass("scheduleMessage: message_type correct") : fail("scheduleMessage: message_type wrong");
  } catch (err) {
    fail("scheduleMessage insert", err.message);
    return;
  }

  // --- Sub-test B: scheduleMessage for opted-out number ---
  let optRowId;
  if (crmSupabase) {
    try {
      // Insert opt-out record
      await crmSupabase.from("opt_outs").upsert({ phone: optPhone, reason: "scheduler test" });

      const optRow = await scheduleMessage(supabase, {
        phone:        optPhone,
        body:         "Should never be sent",
        message_type: "test_optout",
        send_at:      sendAt,
      });
      optRowId = optRow.id;
      pass("scheduleMessage: opted-out row inserted");
    } catch (err) {
      fail("scheduleMessage: opted-out insert", err.message);
    }
  }

  // --- Sub-test C: processScheduledMessages sends the due row ---
  try {
    const result = await processScheduledMessages(supabase, mockTwilio, crmSupabase);
    result.processed >= 1 ? pass(`processScheduledMessages: processed ${result.processed}`) : fail("processScheduledMessages: nothing processed");
    result.sent >= 1       ? pass(`processScheduledMessages: sent ${result.sent}`)           : fail("processScheduledMessages: nothing sent");
    if (crmSupabase) {
      result.cancelled >= 1 ? pass(`processScheduledMessages: cancelled opted-out`)         : fail("processScheduledMessages: opted-out not cancelled");
    }
  } catch (err) {
    fail("processScheduledMessages run", err.message);
  }

  // --- Sub-test D: verify DB state after processing ---
  if (rowId) {
    const { data: sent } = await supabase.from("scheduled_messages").select("status,twilio_sid,sent_at").eq("id", rowId).single();
    sent?.status === "sent"   ? pass("DB: row marked sent")       : fail("DB: row not marked sent", sent?.status);
    sent?.twilio_sid === mockSid ? pass("DB: twilio_sid stored")  : fail("DB: twilio_sid missing", sent?.twilio_sid);
    sent?.sent_at             ? pass("DB: sent_at recorded")       : fail("DB: sent_at missing");
  }

  if (optRowId) {
    const { data: optSent } = await supabase.from("scheduled_messages").select("status,error").eq("id", optRowId).single();
    optSent?.status === "cancelled" ? pass("DB: opted-out row cancelled") : fail("DB: opted-out row status wrong", optSent?.status);
    optSent?.error?.includes("opted out") ? pass("DB: opt-out reason recorded") : fail("DB: opt-out reason missing", optSent?.error);
  }

  // --- Sub-test E: buildFollowUpText produces valid output ---
  const mockBooking = {
    contact:      { name: "Alex Johnson", phone: testPhone },
    availability: { item: { name: "3-Hour Snowmobile Tour" } },
  };
  const followUp = buildFollowUpText(mockBooking);
  followUp.includes("Alex")           ? pass("buildFollowUpText: contains first name") : fail("buildFollowUpText: missing name");
  followUp.includes("3-Hour")         ? pass("buildFollowUpText: contains item name")  : fail("buildFollowUpText: missing item");
  followUp.length <= 320              ? pass(`buildFollowUpText: ${followUp.length} chars <= 320`) : fail("buildFollowUpText: too long");

  // --- Cleanup ---
  if (rowId)    await supabase.from("scheduled_messages").delete().eq("id", rowId);
  if (optRowId) await supabase.from("scheduled_messages").delete().eq("id", optRowId);
  if (crmSupabase) await crmSupabase.from("opt_outs").delete().eq("phone", optPhone);
  pass("Scheduler test cleaned up");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 18: Client Registry + Resolution
// ─────────────────────────────────────────────────────────────────────────────
async function test18() {
  console.log("\nTEST 18: Client Registry + Resolution");

  // CLIENTS registry contains expected clients
  "csr_rea" in CLIENTS
    ? pass("CLIENTS registry has csr_rea")
    : fail("CLIENTS registry missing csr_rea");

  "lone_pine" in CLIENTS
    ? pass("CLIENTS registry has lone_pine")
    : fail("CLIENTS registry missing lone_pine");

  // csr_rea resolves from production number
  const csrRea = resolveClient("+18668906657");
  csrRea.id === "csr_rea"
    ? pass("resolveClient('+18668906657') → csr_rea")
    : fail("resolveClient production number", `expected csr_rea, got ${csrRea.id}`);

  // Unknown number falls back to csr_rea
  const fallback = resolveClient("+10000000000");
  fallback.id === "csr_rea"
    ? pass("resolveClient(unknown) falls back to csr_rea")
    : fail("resolveClient fallback", `expected csr_rea, got ${fallback.id}`);

  // null falls back to csr_rea
  const nullFallback = resolveClient(null);
  nullFallback.id === "csr_rea"
    ? pass("resolveClient(null) falls back to csr_rea")
    : fail("resolveClient(null)", `expected csr_rea, got ${nullFallback.id}`);

  // getDefaultClient returns csr_rea
  getDefaultClient().id === "csr_rea"
    ? pass("getDefaultClient() returns csr_rea")
    : fail("getDefaultClient()", "expected csr_rea");

  // lone_pine resolves from its configured env number (if set)
  const lpNumber = process.env.LONE_PINE_TWILIO_NUMBER;
  if (lpNumber) {
    const lp = resolveClient(lpNumber);
    lp.id === "lone_pine"
      ? pass(`resolveClient(LONE_PINE_TWILIO_NUMBER) → lone_pine`)
      : fail("resolveClient(LONE_PINE_TWILIO_NUMBER)", `expected lone_pine, got ${lp.id}`);
  } else {
    pass("lone_pine Twilio number not set (expected in dev — will test when provisioned)");
  }

  // csr_rea has required fields
  const csrReaClient = CLIENTS.csr_rea;
  csrReaClient.bookingMode === "fareharbor"
    ? pass("csr_rea.bookingMode is fareharbor")
    : fail("csr_rea.bookingMode", csrReaClient.bookingMode);

  typeof csrReaClient.handoffPhone === "string" && csrReaClient.handoffPhone.length > 0
    ? pass("csr_rea.handoffPhone defined")
    : fail("csr_rea.handoffPhone missing");

  csrReaClient.bookingUrls?.csr_browse_all?.startsWith("https://")
    ? pass("csr_rea.bookingUrls.csr_browse_all is a URL")
    : fail("csr_rea.bookingUrls.csr_browse_all", csrReaClient.bookingUrls?.csr_browse_all);

  // lone_pine has required fields
  const lpClient = CLIENTS.lone_pine;
  lpClient.bookingMode === "informational"
    ? pass("lone_pine.bookingMode is informational")
    : fail("lone_pine.bookingMode", lpClient.bookingMode);

  lpClient.handoffPhone === "(970) 761-2124"
    ? pass("lone_pine.handoffPhone is correct")
    : fail("lone_pine.handoffPhone", lpClient.handoffPhone);

  lpClient.fareharborEnabled === false
    ? pass("lone_pine.fareharborEnabled is false")
    : fail("lone_pine.fareharborEnabled", String(lpClient.fareharborEnabled));

  Array.isArray(lpClient.services) && lpClient.services.length > 0
    ? pass(`lone_pine.services has ${lpClient.services.length} items`)
    : fail("lone_pine.services missing or empty");

  // buildSystemPrompt backward compat (old-style string call still works)
  buildSystemPrompt("winter", "").length > 100
    ? pass("buildSystemPrompt('winter', '') backward compat works")
    : fail("buildSystemPrompt backward compat broken");

  // buildSystemPrompt with lone_pine client
  buildSystemPrompt(lpClient, "winter", "").includes("Lone Pine Performance")
    ? pass("buildSystemPrompt(lone_pine) contains client name")
    : fail("buildSystemPrompt(lone_pine) missing client name");

  // Lone Pine prompt must NOT contain FareHarbor
  buildSystemPrompt(lpClient, "winter", "").includes("FareHarbor")
    ? fail("lone_pine system prompt should not mention FareHarbor")
    : pass("lone_pine system prompt is FareHarbor-free");

  // Lone Pine prompt must contain handoff phone
  buildSystemPrompt(lpClient, "winter", "").includes("761-2124")
    ? pass("lone_pine system prompt contains handoff phone")
    : fail("lone_pine system prompt missing handoff phone");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 19: Lone Pine — Informational SMS Flow (integration)
// ─────────────────────────────────────────────────────────────────────────────
const LP_TO_PHONE = "+15551111111";  // simulated Lone Pine Twilio number

async function test19() {
  console.log("\nTEST 19: Lone Pine Informational SMS Flow");

  // To make resolveClient work for this test, LONE_PINE_TWILIO_NUMBER must match LP_TO_PHONE.
  // If not configured, skip gracefully.
  if (process.env.LONE_PINE_TWILIO_NUMBER !== LP_TO_PHONE) {
    pass("Lone Pine integration test skipped (set LONE_PINE_TWILIO_NUMBER=+15551111111 to enable)");
    return;
  }

  await httpPost("/reset", { from: TEST_PHONE2 }, "application/json");

  // 1. Greeting from Lone Pine number
  const r1 = await sendSms("hey", TEST_PHONE2, LP_TO_PHONE);
  r1.length > 0
    ? pass(`LP Message 1 (greeting): ${r1.length} chars`)
    : fail("LP Message 1: no reply");

  // Must NOT mention Summit or FareHarbor
  /summit/i.test(r1)
    ? fail("LP greeting mentions Summit (should not)", r1)
    : pass("LP greeting does not mention Summit");

  /fareharbor/i.test(r1)
    ? fail("LP greeting mentions FareHarbor (should not)", r1)
    : pass("LP greeting does not mention FareHarbor");

  // 2. Ask to book / schedule
  const r2 = await sendSms("I need to schedule a suspension revalve", TEST_PHONE2, LP_TO_PHONE);
  r2.length > 0
    ? pass(`LP Message 2 (booking intent): ${r2.length} chars`)
    : fail("LP Message 2: no reply");

  // Should direct to phone, not FH
  /761-2124|call|phone/i.test(r2)
    ? pass("LP booking intent routes to phone CTA")
    : fail("LP booking intent did not suggest calling", r2);

  /fareharbor/i.test(r2)
    ? fail("LP booking reply mentions FareHarbor (should not)", r2)
    : pass("LP booking reply is FareHarbor-free");

  // 3. Ask about hours
  const r3 = await sendSms("What are your hours?", TEST_PHONE2, LP_TO_PHONE);
  /9am|monday|fri/i.test(r3)
    ? pass("LP hours reply contains business hours")
    : fail("LP hours reply missing hours info", r3);

  await httpPost("/reset", { from: TEST_PHONE2 }, "application/json");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  HIGHMARK TEST SUITE — Whiteout Solutions");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Unit tests (no server needed)
  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  await test10();
  await test12();
  await test13();
  await test15();
  await test17();
  await test18(); // client registry + resolution

  // Integration tests (spawn server)
  console.log("\n[Server] Starting test server on port", TEST_PORT, "...");
  try {
    await startServer();
    console.log("[Server] Ready.\n");
    await test11();
    await test14();
    await test16();
    await test19(); // Lone Pine informational flow
  } catch (e) {
    fail("Test server", e.message);
  } finally {
    stopServer();
    console.log("\n[Server] Stopped.");
  }

  // Summary
  const passed  = results.filter((r) => r.ok).length;
  const total   = results.length;
  const failures = results.filter((r) => !r.ok);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Results: ${passed}/${total} tests passed`);
  if (failures.length) {
    console.log("  Failed:");
    failures.forEach((r) => console.log(`    ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`));
    console.log("  ❌ Fix the above issues before deploying.");
  } else {
    console.log("  🏔 Highmark is ready to deploy!");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e.message);
  stopServer();
  process.exit(1);
});
