// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER — Durable scheduled SMS system backed by Supabase
//
// Replaces setTimeout-based delayed sends. Survives Railway restarts.
//
// Usage:
//   scheduleMessage(supabase, { phone, body, message_type, send_at, ... })
//   processScheduledMessages(supabase, twilioClient, crmSupabase)
//
// Invocation:
//   Railway cron → POST /cron/scheduled-messages every minute
//   (set CRON_SECRET env var and pass as x-cron-secret header for security)
//
// Statuses:
//   pending    → waiting to be sent
//   processing → claimed by a worker run, being sent right now
//   sent       → successfully delivered to Twilio
//   failed     → exhausted max_attempts
//   cancelled  → opted-out number or explicitly cancelled
//
// Retry backoff: attempt 1 fails → retry in 5 min
//                attempt 2 fails → retry in 15 min
//                attempt 3 fails → mark failed
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000]; // per-retry delay
const STALE_LOCK_MS   = 5 * 60 * 1000;                    // reclaim stale locks after 5 min
const BATCH_SIZE      = 10;                                // max rows per worker run

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE A MESSAGE
// Inserts a row into scheduled_messages. Returns the created row.
// supabase — DB1 client
// ─────────────────────────────────────────────────────────────────────────────
export async function scheduleMessage(supabase, {
  phone,
  body,
  message_type,
  send_at,
  client_id       = process.env.CLIENT_ID || "csr_rea",
  conversation_id = null,
  max_attempts    = 3,
  metadata        = {},
}) {
  const { data, error } = await supabase
    .from("scheduled_messages")
    .insert({
      phone,
      body,
      message_type,
      send_at,
      client_id,
      conversation_id,
      max_attempts,
      metadata,
    })
    .select()
    .single();

  if (error) throw new Error(`[SCHEDULER] scheduleMessage failed: ${error.message}`);

  console.log(`[SCHEDULER] Scheduled ${message_type} to ${phone} at ${send_at} (id=${data.id})`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS SCHEDULED MESSAGES
// Called every minute by the Railway cron via POST /cron/scheduled-messages.
// Returns { processed, sent, cancelled, failed }
//
// Concurrency safety (v1):
//   Rows are claimed with .eq("status","pending") so two simultaneous worker
//   runs can't double-send the same message — the second sees 0 rows since the
//   first already flipped them to "processing".
//   Stale locks (crashed workers) are reclaimed after STALE_LOCK_MS.
//   For stronger guarantees, replace with a Postgres advisory lock or RPC.
// ─────────────────────────────────────────────────────────────────────────────
export async function processScheduledMessages(supabase, twilioClient, crmSupabase) {
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const counts     = { processed: 0, sent: 0, cancelled: 0, failed: 0 };
  const now        = new Date().toISOString();

  // 1. Reclaim rows stuck in 'processing' — handles crashed worker runs
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const { count: reclaimedCount } = await supabase
    .from("scheduled_messages")
    .update({ status: "pending", locked_at: null, updated_at: now })
    .eq("status", "processing")
    .lt("locked_at", staleThreshold)
    .select("id", { count: "exact", head: true });

  if (reclaimedCount > 0) {
    console.log(`[SCHEDULER] Reclaimed ${reclaimedCount} stale lock(s)`);
  }

  // 2. Atomically claim a batch of due pending rows
  //    The .eq("status","pending") is the optimistic lock — concurrent workers
  //    see 0 rows for already-claimed messages.
  const { data: claimed, error: claimErr } = await supabase
    .from("scheduled_messages")
    .update({ status: "processing", locked_at: now, updated_at: now })
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at")
    .limit(BATCH_SIZE)
    .select();

  if (claimErr) {
    console.error("[SCHEDULER] Claim error:", claimErr.message);
    return counts;
  }

  if (!claimed?.length) return counts;

  counts.processed = claimed.length;
  console.log(`[SCHEDULER] Claimed ${claimed.length} message(s)`);

  // 3. Process each claimed message
  for (const msg of claimed) {
    await processSingleMessage(msg, supabase, twilioClient, crmSupabase, fromNumber, counts);
  }

  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS A SINGLE MESSAGE (internal)
// ─────────────────────────────────────────────────────────────────────────────
async function processSingleMessage(msg, supabase, twilioClient, crmSupabase, fromNumber, counts) {
  const now      = new Date().toISOString();
  const attempts = msg.attempts + 1;

  // Check opt-out before sending
  if (crmSupabase) {
    try {
      const { data: optOut } = await crmSupabase
        .from("opt_outs")
        .select("id")
        .eq("phone", msg.phone)
        .maybeSingle();

      if (optOut) {
        console.log(`[SCHEDULER] ${msg.id} — cancelled: ${msg.phone} opted out`);
        await supabase.from("scheduled_messages").update({
          status:     "cancelled",
          error:      "Phone number is opted out (TCPA)",
          updated_at: now,
        }).eq("id", msg.id);
        counts.cancelled++;
        return;
      }
    } catch (err) {
      // Non-fatal: log and proceed — don't block sends over a CRM lookup failure
      console.warn(`[SCHEDULER] Opt-out check failed for ${msg.id} — proceeding:`, err.message);
    }
  }

  // Send via Twilio
  try {
    const result = await twilioClient.messages.create({
      body: msg.body,
      from: fromNumber,
      to:   msg.phone,
    });

    console.log(`[SCHEDULER] Sent ${msg.message_type} to ${msg.phone} (sid=${result.sid}, id=${msg.id})`);

    await supabase.from("scheduled_messages").update({
      status:     "sent",
      twilio_sid: result.sid,
      sent_at:    now,
      attempts,
      updated_at: now,
    }).eq("id", msg.id);

    counts.sent++;
  } catch (err) {
    console.error(`[SCHEDULER] Send failed for ${msg.id} attempt ${attempts}/${msg.max_attempts}: ${err.message}`);

    if (attempts >= msg.max_attempts) {
      // Exhausted retries
      await supabase.from("scheduled_messages").update({
        status:     "failed",
        error:      err.message,
        attempts,
        updated_at: now,
      }).eq("id", msg.id);
      counts.failed++;
      console.log(`[SCHEDULER] ${msg.id} — marked failed after ${attempts} attempt(s)`);
    } else {
      // Back off and retry
      const delayMs     = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1);
      const retryAt     = new Date(Date.now() + delayMs).toISOString();
      await supabase.from("scheduled_messages").update({
        status:     "pending",
        locked_at:  null,
        send_at:    retryAt,
        error:      err.message,
        attempts,
        updated_at: now,
      }).eq("id", msg.id);
      console.log(`[SCHEDULER] ${msg.id} — retry ${attempts + 1}/${msg.max_attempts} at ${retryAt}`);
    }
  }
}
