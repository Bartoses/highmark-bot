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
import { dispatchOperatorDigests } from "./operatorBriefing.js";
import { evaluateEventCampaigns } from "./campaignTriggers.js";
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

// Per-phone operator digests are dispatched via dispatchOperatorDigests
// on every cron tick. Each operator_phones row owns its own digest_times +
// timezone, so the dispatcher decides who is due. No global "briefing window"
// is needed any more.
async function sendOperatorBriefings() {
  console.log("[CRON-WORKER] Dispatching per-phone operator digests...");
  const result = await dispatchOperatorDigests(supabase, twilioClient, crmSupabase);
  console.log(`[CRON-WORKER] Digests — sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`);
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

  // Operator digests — every cron tick, per-phone digest_times decides who's due
  await sendOperatorBriefings();

  process.exit(0);
} catch (err) {
  console.error("[CRON-WORKER] Fatal error:", err.message);
  process.exit(1);
}
