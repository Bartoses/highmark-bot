// ─────────────────────────────────────────────────────────────────────────────
// CRON WORKER — standalone entry point for Railway cron service
//
// This file is the start command for a separate Railway cron service.
// It runs processScheduledMessages, logs the result, and exits.
// The main highmark-bot web server is NOT started.
//
// Railway cron service setup:
//   Start command: node cron-worker.js
//   Schedule:      */5 * * * *   (every 5 minutes)
//   Env vars:      same as main service (share variable group or copy)
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import { processScheduledMessages } from "./scheduler.js";
import { generateDailyBriefing } from "./operatorBriefing.js";
import { evaluateEventCampaigns } from "./campaignTriggers.js";
import { getAllClients } from "./clients.js";
import { runMpwrSync } from "./mpwrSync.js";

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SUPABASE_URL",
  "SUPABASE_KEY",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[CRON-WORKER] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const crmSupabase  = process.env.CRM_SUPABASE_URL
  ? createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY)
  : null;

console.log(`[CRON-WORKER] Starting at ${new Date().toISOString()}`);

// ─── MPWR sync window — run at :00 and :30 of each hour ─────────────────────
function isMpwrSyncWindow() {
  const min = new Date().getUTCMinutes();
  return min < 5 || (min >= 30 && min < 35);
}

// ─── Morning briefing check (7:00 AM MT = 13:00 UTC in MDT / 14:00 UTC in MST) ──
// Railway cron runs every 5 min — check if we're in the 7am MT briefing window.
function isBriefingWindow() {
  const now     = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  // Accept 13:00–13:04 UTC (MDT) or 14:00–14:04 UTC (MST) to cover both offsets
  return (utcHour === 13 || utcHour === 14) && utcMin < 5;
}

async function sendOperatorBriefings() {
  console.log("[CRON-WORKER] Running morning operator briefings...");
  let clients = [];
  try {
    // Prefer DB-backed clients list (all active, with owner_phone)
    const { data } = await supabase
      .from("clients")
      .select("*")
      .not("owner_phone", "is", null);
    clients = data ?? [];
  } catch {
    // Fallback to static clients if DB query fails
    clients = Object.values(getAllClients()).filter((c) => c.ownerPhone ?? c.owner_phone);
  }

  let sent = 0;
  let skipped = 0;
  for (const client of clients) {
    try {
      const result = await generateDailyBriefing(client, supabase, twilioClient, crmSupabase);
      if (result.success) sent++;
      else skipped++;
    } catch (err) {
      console.error(`[BRIEFING] Failed for ${client.id ?? client.slug}:`, err.message);
      skipped++;
    }
  }
  console.log(`[CRON-WORKER] Briefings — sent=${sent} skipped=${skipped}`);
}

try {
  // Always process scheduled messages
  const result = await processScheduledMessages(supabase, twilioClient, crmSupabase);
  console.log(`[CRON-WORKER] Done — processed=${result.processed} sent=${result.sent} cancelled=${result.cancelled} failed=${result.failed}`);

  // Smart event campaigns — evaluate on every cron tick
  await evaluateEventCampaigns(supabase, crmSupabase);

  // MPWR booking sync — runs at :00 and :30 of each hour
  if (crmSupabase && isMpwrSyncWindow()) {
    await runMpwrSync(crmSupabase);
  }

  // Morning briefing — only runs in the 7am MT window
  if (isBriefingWindow()) {
    await sendOperatorBriefings();
  }

  process.exit(0);
} catch (err) {
  console.error("[CRON-WORKER] Fatal error:", err.message);
  process.exit(1);
}
