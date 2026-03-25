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

import { buildConfirmationText } from "./bookingConfirmations.js";
import { checkOptOut, upsertContact, addTagsToContact, OPT_OUT_KEYWORDS, OPT_IN_KEYWORDS } from "./crm.js";
import { getKnowledgeContext } from "./knowledgeBase.js";

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
  const short = "A".repeat(80);
  const exact = "A".repeat(160);
  const over  = "Hello world this is a test sentence that keeps going and going until it exceeds one hundred and sixty characters total yes it does because I made it long enough on purpose here.";

  enforceLength(short).length === 80 ? pass("Short string unchanged") : fail("Short string changed");
  enforceLength(exact).length === 160 ? pass("Exact 160 unchanged") : fail("Exact 160 changed");

  const truncated = enforceLength(over);
  truncated.length <= 160
    ? pass(`Over-limit truncated to ${truncated.length} chars`)
    : fail("Not truncated", `${truncated.length} chars`);
  truncated.endsWith("…")
    ? pass("Ends with '…'")
    : fail("Missing '…'", truncated.slice(-5));
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
  /rea|rabbit ears|beginner|guided|first|tour|fareharbor/i.test(r2)
    ? pass("Message 2: REA/beginner routing present")
    : fail("Message 2: wrong routing", r2);

  if (supabase) {
    const { data: c2 } = await supabase.from("conversations").select("booking_step").eq("from_number", TEST_PHONE).single();
    c2?.booking_step !== null
      ? pass(`Message 2: booking_step=${c2?.booking_step}`)
      : fail("Message 2: booking_step still null");
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
    ? pass(`Confirmation text: ${text.length} chars`)
    : fail("Confirmation text too long", `${text.length} chars`);
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

  // Integration tests (spawn server)
  console.log("\n[Server] Starting test server on port", TEST_PORT, "...");
  try {
    await startServer();
    console.log("[Server] Ready.\n");
    await test11();
    await test14();
    await test16();
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
