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

try {
  const result = await processScheduledMessages(supabase, twilioClient, crmSupabase);
  console.log(`[CRON-WORKER] Done — processed=${result.processed} sent=${result.sent} cancelled=${result.cancelled} failed=${result.failed}`);
  process.exit(0);
} catch (err) {
  console.error("[CRON-WORKER] Fatal error:", err.message);
  process.exit(1);
}
