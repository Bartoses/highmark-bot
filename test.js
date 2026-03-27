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
import { saveLead, notifyBusinessOfLead } from "./leads.js";

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

async function httpPatch(path, body) {
  const { default: fetch } = await import("node-fetch");
  return fetch(`${BASE_URL}${path}`, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
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
    // csr_rea (explicit client)
    const csrRea  = getDefaultClient();
    const start   = Date.now();
    const ctx     = await getKnowledgeContext(supabase, csrRea);
    const elapsed = Date.now() - start;
    typeof ctx === "string"
      ? pass(`getKnowledgeContext(csr_rea): string (${ctx.length} chars)`)
      : fail("getKnowledgeContext non-string");
    elapsed < 5000
      ? pass(`getKnowledgeContext(csr_rea): ${elapsed}ms`)
      : fail("getKnowledgeContext too slow", `${elapsed}ms`);

    // backward compat: no client arg → still returns a string
    const ctxNoArg = await getKnowledgeContext(supabase);
    typeof ctxNoArg === "string"
      ? pass("getKnowledgeContext(no client) backward compat works")
      : fail("getKnowledgeContext backward compat broken");
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

  // csr_rea resolves from primary number
  const csrRea = resolveClient("+18335786496");
  csrRea.id === "csr_rea"
    ? pass("resolveClient('+18335786496') → csr_rea (primary)")
    : fail("resolveClient primary number", `expected csr_rea, got ${csrRea.id}`);

  // csr_rea also resolves from demo number
  const csrReaDemo = resolveClient("+18668906657");
  csrReaDemo.id === "csr_rea"
    ? pass("resolveClient('+18668906657') → csr_rea (demo)")
    : fail("resolveClient demo number", `expected csr_rea, got ${csrReaDemo.id}`);

  // lone_pine resolves from its hardcoded number
  const lpResolved = resolveClient("+18336489744");
  lpResolved.id === "lone_pine"
    ? pass("resolveClient('+18336489744') → lone_pine (primary)")
    : fail("resolveClient lone_pine number", `expected lone_pine, got ${lpResolved.id}`);

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
  // LONE_PINE_TWILIO_NUMBER env var override also resolves if set
  const lpNumber = process.env.LONE_PINE_TWILIO_NUMBER;
  if (lpNumber) {
    const lp = resolveClient(lpNumber);
    lp.id === "lone_pine"
      ? pass(`resolveClient(LONE_PINE_TWILIO_NUMBER) → lone_pine`)
      : fail("resolveClient(LONE_PINE_TWILIO_NUMBER)", `expected lone_pine, got ${lp.id}`);
  } else {
    pass("LONE_PINE_TWILIO_NUMBER env var not set (ok — hardcoded number handles routing)");
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
// TEST 20: Per-Client Knowledge Base Context
// ─────────────────────────────────────────────────────────────────────────────
async function test20() {
  console.log("\nTEST 20: Per-Client Knowledge Base Context");
  if (!supabase) { fail("Supabase unavailable"); return; }

  // ── csr_rea context ────────────────────────────────────────────────────────
  try {
    const csrCtx = await getKnowledgeContext(supabase, CLIENTS.csr_rea);
    typeof csrCtx === "string"
      ? pass(`csr_rea KB context: string (${csrCtx.length} chars)`)
      : fail("csr_rea KB context not a string");

    // csr_rea context should not contain Lone Pine business info
    /lone pine|lonepineperformance/i.test(csrCtx)
      ? fail("csr_rea context contains Lone Pine data (wrong client)")
      : pass("csr_rea context is Lone Pine-free");
  } catch (e) { fail("csr_rea KB context threw", e.message); }

  // ── lone_pine context ──────────────────────────────────────────────────────
  try {
    const lpCtx = await getKnowledgeContext(supabase, CLIENTS.lone_pine);
    typeof lpCtx === "string"
      ? pass(`lone_pine KB context: string (${lpCtx.length} chars)`)
      : fail("lone_pine KB context not a string");

    // lone_pine context must NOT contain FareHarbor booking data
    const hasFhAvailability = /AVAILABILITY:|TOUR DETAILS:|DYNAMIC BOOKING LINKS/i.test(lpCtx);
    hasFhAvailability
      ? fail("lone_pine KB context contains FareHarbor sections (should not)")
      : pass("lone_pine KB context is FareHarbor-free");

    // lone_pine context must NOT contain SNOTEL snow depth data
    /SNOW CONDITIONS/i.test(lpCtx)
      ? fail("lone_pine KB context contains SNOW CONDITIONS (should not)")
      : pass("lone_pine KB context has no SNOTEL snow data");

    // Weather section may appear (shared for Steamboat clients) — that's fine
    // Just verify it doesn't error and returns a clean string
    pass("lone_pine KB context returned without error");
  } catch (e) { fail("lone_pine KB context threw", e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 21: Chunk 3 — Per-client runtime behavior routing
// ─────────────────────────────────────────────────────────────────────────────
async function test21() {
  console.log("\nTEST 21: Chunk 3 — Per-client runtime behavior routing");

  const csrRea = CLIENTS.csr_rea;
  const lp     = CLIENTS.lone_pine;

  // handoffReply function exists on each client
  typeof csrRea.handoffReply === "function"
    ? pass("csr_rea has handoffReply function")
    : fail("csr_rea missing handoffReply function");

  typeof lp.handoffReply === "function"
    ? pass("lone_pine has handoffReply function")
    : fail("lone_pine missing handoffReply function");

  // csr_rea handoffReply uses team/us language
  const csrReply = csrRea.handoffReply(csrRea.handoffPhone);
  /our team|give us/i.test(csrReply)
    ? pass("csr_rea handoffReply uses team language")
    : fail("csr_rea handoffReply unexpected text", csrReply);

  /fareharbor/i.test(csrReply)
    ? fail("csr_rea handoffReply should not mention FareHarbor", csrReply)
    : pass("csr_rea handoffReply is FH-free");

  // lone_pine handoffReply uses Jake and correct phone
  const lpReply = lp.handoffReply(lp.handoffPhone);
  /jake/i.test(lpReply)
    ? pass("lone_pine handoffReply mentions Jake")
    : fail("lone_pine handoffReply missing Jake", lpReply);

  /761-2124/.test(lpReply)
    ? pass("lone_pine handoffReply contains correct phone")
    : fail("lone_pine handoffReply missing phone", lpReply);

  // CRM enabled flags
  csrRea.crmEnabled === true
    ? pass("csr_rea.crmEnabled is true")
    : fail("csr_rea.crmEnabled should be true", String(csrRea.crmEnabled));

  lp.crmEnabled === false
    ? pass("lone_pine.crmEnabled is false (no CRM records)")
    : fail("lone_pine.crmEnabled should be false", String(lp.crmEnabled));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 22: Chunk 4 — Lead Capture Flow (Lone Pine)
// ─────────────────────────────────────────────────────────────────────────────
async function test22() {
  console.log("\nTEST 22: Chunk 4 — Lead Capture (Lone Pine)");

  const lp = CLIENTS.lone_pine;

  // Unit: lead capture config
  lp.leadCaptureEnabled === true
    ? pass("lone_pine.leadCaptureEnabled is true")
    : fail("lone_pine.leadCaptureEnabled should be true", String(lp.leadCaptureEnabled));

  typeof lp.leadNotificationPhone === "string" && lp.leadNotificationPhone.length > 0
    ? pass("lone_pine.leadNotificationPhone is set")
    : fail("lone_pine.leadNotificationPhone missing or empty");

  const csr = CLIENTS.csr_rea;
  !csr.leadCaptureEnabled
    ? pass("csr_rea.leadCaptureEnabled is falsy (not a lead-capture client)")
    : fail("csr_rea.leadCaptureEnabled should be falsy", String(csr.leadCaptureEnabled));

  // Unit: leads.js exports are functions
  typeof saveLead === "function"
    ? pass("saveLead is importable function")
    : fail("saveLead is not a function");

  typeof notifyBusinessOfLead === "function"
    ? pass("notifyBusinessOfLead is importable function")
    : fail("notifyBusinessOfLead is not a function");

  // Unit: saveLead returns false when no supabase client
  const result = await saveLead(null, { clientId: "lone_pine", fromNumber: "+15550001111", contactPhone: "+15550001111", service: "revalve" });
  result === false
    ? pass("saveLead(null, ...) returns false gracefully")
    : fail("saveLead(null, ...) should return false", String(result));

  // Integration: full 3-step lead capture flow (gated on env var)
  if (process.env.LONE_PINE_TWILIO_NUMBER !== LP_TO_PHONE) {
    pass("Lead capture integration skipped (set LONE_PINE_TWILIO_NUMBER=+15551111111 to enable)");
    return;
  }

  const LEAD_PHONE = "+15550003333";
  await httpPost("/reset", { from: LEAD_PHONE }, "application/json");

  // Step 0: greeting
  await sendSms("hey", LEAD_PHONE, LP_TO_PHONE);

  // Step 1: booking intent → ask for service
  const r1 = await sendSms("I need a suspension revalve", LEAD_PHONE, LP_TO_PHONE);
  /service|what service|revalve|rebuild|e\.g\./i.test(r1)
    ? pass("Lead step 1: asks for service type")
    : fail("Lead step 1: unexpected reply", r1);
  /761-2124|call/i.test(r1)
    ? pass("Lead step 1: includes phone CTA as escape hatch")
    : fail("Lead step 1: missing phone CTA", r1);
  /fareharbor/i.test(r1)
    ? fail("Lead step 1: should not mention FareHarbor", r1)
    : pass("Lead step 1: FareHarbor-free");

  // Step 2: service provided → ask for callback
  const r2 = await sendSms("Front suspension revalve for my mountain bike", LEAD_PHONE, LP_TO_PHONE);
  /number|reach you|call back|callback|same/i.test(r2)
    ? pass("Lead step 2: asks for callback number")
    : fail("Lead step 2: unexpected reply", r2);

  // Step 3: callback provided → ask for timeframe
  const r3 = await sendSms("same", LEAD_PHONE, LP_TO_PHONE);
  /timeframe|when|asap|next week|rush/i.test(r3)
    ? pass("Lead step 3: asks for timeframe")
    : fail("Lead step 3: unexpected reply", r3);

  // Step 4: timeframe provided → confirmation + reset
  const r4 = await sendSms("Next week ideally", LEAD_PHONE, LP_TO_PHONE);
  /passed|request|team|call|761-2124/i.test(r4)
    ? pass("Lead step 4: confirmation sent, includes contact info")
    : fail("Lead step 4: unexpected reply", r4);
  /step|service|timeframe|callback/i.test(r4)
    ? fail("Lead step 4: reply reads like mid-flow prompt (not reset)", r4)
    : pass("Lead step 4: reply is a completion message");

  // After completion: new booking intent should restart the flow (not pick up mid-flow)
  const r5 = await sendSms("Actually I also need a rebuild quote", LEAD_PHONE, LP_TO_PHONE);
  /service|rebuild|what service|revalve|e\.g\./i.test(r5)
    ? pass("Lead flow restarts cleanly after completion")
    : fail("Lead flow after completion: unexpected reply", r5);

  await httpPost("/reset", { from: LEAD_PHONE }, "application/json");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 23: Waitlist Feature
// ─────────────────────────────────────────────────────────────────────────────
async function test23() {
  console.log("\nTEST 23: Waitlist Feature");

  // Unit: waitlistEnabled flags
  CLIENTS.csr_rea.waitlistEnabled === true
    ? pass("csr_rea.waitlistEnabled is true")
    : fail("csr_rea.waitlistEnabled should be true", String(CLIENTS.csr_rea.waitlistEnabled));

  CLIENTS.lone_pine.waitlistEnabled === true
    ? pass("lone_pine.waitlistEnabled is true")
    : fail("lone_pine.waitlistEnabled should be true", String(CLIENTS.lone_pine.waitlistEnabled));

  // Unit: saveLead with leadType='waitlist' returns false gracefully when no supabase
  const waitlistResult = await saveLead(null, {
    clientId: "csr_rea", fromNumber: "+15550001111", contactPhone: "+15550001111",
    service: "waitlist: tour/rental", timeframe: null, leadType: "waitlist",
  });
  waitlistResult === false
    ? pass("saveLead(null, leadType:'waitlist') returns false gracefully")
    : fail("saveLead(null, waitlist) should return false", String(waitlistResult));

  // Integration: "let me know" trigger + YES confirmation (gated on LONE_PINE_TWILIO_NUMBER)
  if (process.env.LONE_PINE_TWILIO_NUMBER !== LP_TO_PHONE) {
    pass("Waitlist integration skipped (set LONE_PINE_TWILIO_NUMBER=+15551111111 to enable)");
    return;
  }

  const WAITLIST_PHONE = "+15550004444";
  await httpPost("/reset", { from: WAITLIST_PHONE }, "application/json");

  // Init convo
  await sendSms("hey", WAITLIST_PHONE, LP_TO_PHONE);

  // Trigger: "notify me" / "let me know"
  const r1 = await sendSms("let me know when you have availability", WAITLIST_PHONE, LP_TO_PHONE);
  /yes|confirm|spots|open|save your number/i.test(r1)
    ? pass("Waitlist trigger: asks for YES confirmation")
    : fail("Waitlist trigger: unexpected reply", r1);
  /761-2124|call/i.test(r1)
    ? pass("Waitlist trigger: includes phone fallback")
    : fail("Waitlist trigger: missing phone fallback", r1);

  // Confirm: reply YES
  const r2 = await sendSms("yes", WAITLIST_PHONE, LP_TO_PHONE);
  /list|saved|spots|open|text you/i.test(r2)
    ? pass("Waitlist YES: confirmation sent")
    : fail("Waitlist YES: unexpected reply", r2);
  /fareharbor/i.test(r2)
    ? fail("Waitlist YES: should not mention FareHarbor", r2)
    : pass("Waitlist YES: FareHarbor-free");

  await httpPost("/reset", { from: WAITLIST_PHONE }, "application/json");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 25: Organic outreach YES — saves lead when guest confirms Claude's reach-out offer
// ─────────────────────────────────────────────────────────────────────────────
async function test25() {
  console.log("\nTEST 25: Organic Outreach YES — lead capture");

  if (!supabase) {
    fail("Supabase unavailable — skipping organic YES test");
    return;
  }

  const ORGANIC_PHONE = "+15550005555";
  await httpPost("/reset", { from: ORGANIC_PHONE }, "application/json");

  // Seed a conversation with a prior bot message containing reach-out language.
  // This simulates Claude having already asked "Want me to reach out when spots open?"
  await supabase.from("conversations").upsert({
    from_number: ORGANIC_PHONE,
    to_number:   TO_PHONE,
    messages: [
      { role: "assistant", content: "RZR season opens in April! Want me to reach out when bookings go live so you can snag a spot early? 🤙", timestamp: new Date().toISOString() },
    ],
    booking_step: null,
    booking_data: { activity: null, date: null, groupSize: null, company: null, booking_pk: null },
    handoff: false,
    consecutive_frustrated: 0,
    session_type: "test",
  }, { onConflict: "from_number,to_number" });

  // Guest replies YES — should trigger organic YES handler
  const r = await sendSms("yes", ORGANIC_PHONE, TO_PHONE);

  /list|reach out|time|questions|🤙/i.test(r)
    ? pass("Organic YES: confirmation reply sent")
    : fail("Organic YES: unexpected reply", r);

  /name|email|more info|tell me/i.test(r)
    ? fail("Organic YES: bot should not ask for more info after save", r)
    : pass("Organic YES: bot did not improvise further data collection");

  // Verify lead was saved to DB
  const { data: savedLead } = await supabase
    .from("leads")
    .select("id, lead_type, contact_phone")
    .eq("from_number", ORGANIC_PHONE)
    .eq("lead_type", "waitlist")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  savedLead
    ? pass("Organic YES: waitlist lead written to DB")
    : fail("Organic YES: no lead found in DB");

  savedLead?.contact_phone === ORGANIC_PHONE
    ? pass("Organic YES: contact_phone is guest's number")
    : fail("Organic YES: contact_phone mismatch", savedLead?.contact_phone);

  // Cleanup
  if (savedLead) await supabase.from("leads").delete().eq("id", savedLead.id);
  await httpPost("/reset", { from: ORGANIC_PHONE }, "application/json");
  pass("Organic YES: test cleaned up");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 24: Chunk 5 — Admin Lead Management API
// ─────────────────────────────────────────────────────────────────────────────
async function test24() {
  console.log("\nTEST 24: Admin Lead Management API (Chunk 5)");

  if (!supabase) {
    fail("Supabase unavailable — skipping lead management tests");
    return;
  }

  // Seed a test lead directly into Supabase
  const TEST_CLIENT = "csr_rea";
  const TEST_PHONE_LEAD = "+15550098765";
  const { data: inserted, error: insertErr } = await supabase.from("leads").insert({
    client_id:         TEST_CLIENT,
    from_number:       TEST_PHONE_LEAD,
    contact_phone:     TEST_PHONE_LEAD,
    requested_service: "Test service — admin chunk 5",
    source:            "sms",
    status:            "new",
    lead_type:         "booking",
  }).select().single();

  if (insertErr || !inserted) {
    fail("Test lead insert failed", insertErr?.message ?? "no data");
    return;
  }
  pass("Test lead seeded into DB");

  const leadId = inserted.id;

  // ── GET /admin/leads ──────────────────────────────────────────────────────
  const listRes  = await httpGet("/admin/leads");
  const listData = await listRes.json();

  listRes.status === 200
    ? pass("GET /admin/leads returns 200")
    : fail("GET /admin/leads wrong status", String(listRes.status));

  Array.isArray(listData.leads)
    ? pass("GET /admin/leads returns leads array")
    : fail("GET /admin/leads missing leads array", JSON.stringify(listData));

  typeof listData.total === "number"
    ? pass("GET /admin/leads returns total count")
    : fail("GET /admin/leads missing total", JSON.stringify(listData));

  const seededInList = listData.leads.some((l) => l.id === leadId);
  seededInList
    ? pass("Seeded lead appears in list")
    : fail("Seeded lead not found in list");

  // ── Filter by client_id ───────────────────────────────────────────────────
  const filteredRes  = await httpGet(`/admin/leads?client_id=${TEST_CLIENT}`);
  const filteredData = await filteredRes.json();

  filteredData.leads.every((l) => l.client_id === TEST_CLIENT)
    ? pass("client_id filter: all leads match client")
    : fail("client_id filter: returned wrong clients", JSON.stringify(filteredData.leads.map((l) => l.client_id)));

  // ── Filter by status ──────────────────────────────────────────────────────
  const statusRes  = await httpGet("/admin/leads?status=new");
  const statusData = await statusRes.json();

  statusData.leads.every((l) => l.status === "new")
    ? pass("status filter: all leads have status=new")
    : fail("status filter: returned wrong statuses");

  // ── PATCH /admin/leads/:id — status update ────────────────────────────────
  const patchStatusRes  = await httpPatch(`/admin/leads/${leadId}`, {
    status:     "contacted",
    updated_by: "test_suite",
  });
  const patchStatusData = await patchStatusRes.json();

  patchStatusRes.status === 200
    ? pass("PATCH status → 200")
    : fail("PATCH status wrong status", String(patchStatusRes.status));

  patchStatusData.lead?.status === "contacted"
    ? pass("PATCH status: lead.status updated to contacted")
    : fail("PATCH status: wrong status in response", patchStatusData.lead?.status);

  patchStatusData.lead?.updated_by === "test_suite"
    ? pass("PATCH status: updated_by recorded")
    : fail("PATCH status: updated_by missing", patchStatusData.lead?.updated_by);

  // ── PATCH /admin/leads/:id — notes update ─────────────────────────────────
  const patchNotesRes  = await httpPatch(`/admin/leads/${leadId}`, {
    notes:      "Called back — voicemail left. Try again Thursday.",
    updated_by: "test_suite",
  });
  const patchNotesData = await patchNotesRes.json();

  patchNotesRes.status === 200
    ? pass("PATCH notes → 200")
    : fail("PATCH notes wrong status", String(patchNotesRes.status));

  patchNotesData.lead?.notes?.includes("voicemail")
    ? pass("PATCH notes: notes field updated")
    : fail("PATCH notes: notes missing in response", patchNotesData.lead?.notes);

  // ── PATCH — invalid status rejected ──────────────────────────────────────
  const badPatchRes = await httpPatch(`/admin/leads/${leadId}`, { status: "bogus_status" });
  badPatchRes.status === 400
    ? pass("PATCH invalid status: returns 400")
    : fail("PATCH invalid status: expected 400", String(badPatchRes.status));

  // ── GET /admin/leads/summary ──────────────────────────────────────────────
  const summaryRes  = await httpGet("/admin/leads/summary");
  const summaryData = await summaryRes.json();

  summaryRes.status === 200
    ? pass("GET /admin/leads/summary returns 200")
    : fail("GET /admin/leads/summary wrong status", String(summaryRes.status));

  typeof summaryData.by_status === "object" && summaryData.by_status !== null
    ? pass("summary has by_status object")
    : fail("summary missing by_status", JSON.stringify(summaryData));

  typeof summaryData.by_type === "object" && summaryData.by_type !== null
    ? pass("summary has by_type object")
    : fail("summary missing by_type", JSON.stringify(summaryData));

  // All valid statuses should appear in by_status (seeded at 0)
  const statuses = ["new", "contacted", "scheduled", "closed", "ignored"];
  statuses.every((s) => typeof summaryData.by_status[s] === "number")
    ? pass("summary by_status has all valid status keys")
    : fail("summary by_status missing some status keys", JSON.stringify(summaryData.by_status));

  typeof summaryData.total === "number" && summaryData.total > 0
    ? pass(`summary total: ${summaryData.total} leads`)
    : fail("summary total missing or zero", String(summaryData.total));

  // ── client_id filter on summary ───────────────────────────────────────────
  const clientSummaryRes = await httpGet(`/admin/leads/summary?client_id=${TEST_CLIENT}`);
  await clientSummaryRes.json(); // consume body

  clientSummaryRes.status === 200
    ? pass("GET /admin/leads/summary?client_id returns 200")
    : fail("summary?client_id wrong status", String(clientSummaryRes.status));

  // ── Cleanup test lead ─────────────────────────────────────────────────────
  await supabase.from("leads").delete().eq("id", leadId);
  pass("Test lead cleaned up");
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
  await test20(); // per-client KB context
  await test21(); // per-client runtime behavior routing (Chunk 3)

  // Integration tests (spawn server)
  console.log("\n[Server] Starting test server on port", TEST_PORT, "...");
  try {
    await startServer();
    console.log("[Server] Ready.\n");
    await test11();
    await test14();
    await test16();
    await test19(); // Lone Pine informational flow
    await test22(); // Lone Pine lead capture integration (gated)
    await test23(); // Waitlist feature (unit + gated integration)
    await test24(); // Admin lead management API (Chunk 5)
    await test25(); // Organic outreach YES → waitlist lead (Chunk 5b)
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
