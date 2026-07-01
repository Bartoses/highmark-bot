// ─────────────────────────────────────────────────────────────────────────────
// BOOKING CONFIRMATIONS — Webhook receiver + polling + confirmation texts
//
// FAREHARBOR WEBHOOK SETUP (one-time per client):
//   1. Log into FareHarbor dashboard for each account (CSR + REA)
//   2. Settings → Integrations → Webhooks
//   3. Add webhook URL: https://YOUR-RAILWAY-URL/fareharbor/webhook
//   4. Select events: booking.created, booking.cancelled
//   5. Save and verify test ping → check Railway logs for "FareHarbor webhook received"
// ─────────────────────────────────────────────────────────────────────────────
import fetch from "node-fetch";
import { timingSafeEqual } from "crypto";
import { scheduleMessage } from "./scheduler.js";
import { getAllClients } from "./clients.js";
import { scheduleReminders, preSeedConfirmedGuestConversation, trackAutomatedMessage } from "./messagingEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK AUTH (P0-2) — authenticate the FareHarbor webhook with a shared secret
// FareHarbor doesn't HMAC-sign webhooks, so we gate on a secret carried in the
// configured callback URL path (/fareharbor/webhook/:token), a ?token= query, or
// an x-webhook-secret header. Pure helpers below are unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

// Constant-time compare; true only when both non-empty, same length, and equal.
export function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Allow/deny decision for an inbound FareHarbor webhook.
//   no expected secret configured → allow (back-compat) with reason "unconfigured"
//   expected set + provided matches → allow
//   otherwise → deny (missing_secret | invalid_secret)
export function evaluateFareharborWebhook({ expected = null, provided = null } = {}) {
  if (!expected) return { allow: true, reason: "unconfigured" };
  if (secretsMatch(provided, expected)) return { allow: true, reason: "valid_secret" };
  return { allow: false, reason: provided ? "invalid_secret" : "missing_secret" };
}

const FAREHARBOR_BASE = "https://fareharbor.com/api/external/v1";

// CLIENT_CONFIG
const HANDOFF_PHONE = process.env.HANDOFF_PHONE || "(970) 439-1707";

// CONFIRMATIONS_ENABLED=false keeps the webhook/polling running but redirects
// all texts to CONFIRMATIONS_TEST_PHONE so you can verify the format before
// going live. Flip to true when you're ready to text real guests.
const CONFIRMATIONS_ENABLED   = process.env.CONFIRMATIONS_ENABLED !== "false"; // default ON
const CONFIRMATIONS_TEST_PHONE = process.env.CONFIRMATIONS_TEST_PHONE || "";

// ─────────────────────────────────────────────────────────────────────────────
// PER-CLIENT MESSAGING CONFIG
// Reads messaging_config table for per-client SMS toggles.
// Falls back to CONFIRMATIONS_ENABLED env var if no row exists (backward compat).
// ─────────────────────────────────────────────────────────────────────────────
export async function getMessagingConfig(clientId, supabase) {
  if (!supabase || !clientId) return null;
  try {
    const { data, error } = await supabase
      .from("messaging_config")
      .select("enable_confirmation_texts, enable_reminders, reminder_hours_before, enable_cancellations, enable_rebooking")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) return null; // table missing or query error — fall back to env var
    return data ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

// CLIENT_CONFIG — confirmation text template
export function buildConfirmationText(booking) {
  const company =
    booking.company?.shortname === "rabbitearsadventures"
      ? "Rabbit Ears Adventures"
      : "Colorado Sled Rentals";

  const firstName = (booking.contact?.name ?? "there").split(" ")[0];
  const itemName  = booking.availability?.item?.name ?? "your tour";

  const startAt   = new Date(booking.availability?.start_at ?? Date.now());
  const dateStr   = startAt.toLocaleDateString("en-US", {
    weekday: "long",
    month:   "long",
    day:     "numeric",
  });
  const timeStr   = startAt.toLocaleTimeString("en-US", {
    hour:   "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const shortname = booking.company?.shortname;
  const itemPk    = booking.availability?.item?.pk;
  const bookingUuid = booking.uuid;
  const bookingLink = shortname && itemPk && bookingUuid
    ? `https://fareharbor.com/embeds/book/${shortname}/items/${itemPk}/booking/${bookingUuid}/`
    : null;

  const body = `Hey ${firstName}! Your ${itemName} with ${company} is confirmed for ${dateStr} at ${timeStr} 🏔`;
  const suffix = bookingLink
    ? ` View booking: ${bookingLink} Reply with any questions!`
    : ` Reply here with any questions!`;

  const text = body + suffix;

  // Never truncate mid-URL — if over 320 chars, drop the suffix and keep the URL intact
  if (text.length <= 320) return text;
  if (bookingLink) {
    // Try without the trailing "Reply" line — URL always survives
    const compact = `${body} ${bookingLink}`;
    return compact.length <= 320 ? compact : body.slice(0, 317) + "...";
  }
  return text.slice(0, 317) + "...";
}

export function buildFollowUpText(booking) {
  const firstName = (booking.contact?.name ?? "there").split(" ")[0];
  const itemName  = booking.availability?.item?.name ?? "your tour";
  const text = `Hey ${firstName}! All set for ${itemName}? Any last-minute questions before your adventure? We're here — just reply!`;
  return text.length <= 320 ? text : text.slice(0, 317) + "...";
}

export function buildCancellationText(booking, bookingLink) {
  const firstName = (booking.contact?.name ?? "there").split(" ")[0];
  const itemName  = booking.availability?.item?.name ?? "your tour";

  const startAt = new Date(booking.availability?.start_at ?? Date.now());
  const dateStr = startAt.toLocaleDateString("en-US", {
    month: "long",
    day:   "numeric",
  });

  const base   = `Hey ${firstName}, your ${itemName} on ${dateStr} has been cancelled. Questions? Reply here or call ${HANDOFF_PHONE}.`;
  const rebook = bookingLink ? ` Want to rebook? ${bookingLink}` : "";
  const text   = base + rebook;
  return text.length <= 320 ? text : text.slice(0, 317) + "...";
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SEED CONVERSATION
// Inserts a row in conversations so Summit knows the guest's context when
// they reply to the confirmation text.
// ─────────────────────────────────────────────────────────────────────────────
async function preSeedConversation(booking, confirmationText, supabase, toNumber) {
  const guestPhone = booking.contact?.phone;
  if (!guestPhone) return;

  const company =
    booking.company?.shortname === "rabbitearsadventures" ? "rea" : "csr";

  const startAt = new Date(booking.availability?.start_at ?? Date.now());
  const dateStr = startAt.toLocaleDateString("en-US", {
    weekday: "long",
    month:   "long",
    day:     "numeric",
  });

  const bookingData = {
    activity:   booking.availability?.item?.name ?? null,
    date:       dateStr,
    groupSize:  booking.customer_count ?? null,
    company,
    booking_pk: String(booking.pk),
  };

  await preSeedConfirmedGuestConversation(supabase, {
    guestPhone,
    toNumber,
    confirmationText,
    bookingData,
  });
}

// Normalize FareHarbor phone numbers to E.164 format (+1XXXXXXXXXX for US)
// FH sometimes returns 10-digit numbers without country code.
function normalizePhone(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone; // already normalized or international
}

// Resolve a client by FareHarbor company shortname.
// Searches all clients (static + DB-backed) for one that owns the given FH company.
function resolveClientByFHCompany(shortname) {
  if (!shortname) return null;
  for (const client of Object.values(getAllClients())) {
    const companies = client.fareharborCompanies ?? [];
    if (companies.some((c) => c.shortname === shortname)) return client;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS A SINGLE BOOKING EVENT
// ─────────────────────────────────────────────────────────────────────────────
async function processBookingEvent(booking, source, twilioClient, supabase, crmSupabase) {
  const status     = booking.status;
  const guestPhone = normalizePhone(booking.contact?.phone);
  const bookingPk  = String(booking.pk);

  // Resolve which client owns this booking's FH company → use their outbound phone
  const fhClient   = resolveClientByFHCompany(booking.company?.shortname);
  const fromNumber = fhClient?.outboundPhone ?? process.env.TWILIO_PHONE_NUMBER;

  if (!guestPhone) {
    console.warn(`[CONFIRM] Booking ${bookingPk} has no guest phone — skipping.`);
    return;
  }

  // Per-client messaging config — overrides global env var when row exists
  const msgConfig = await getMessagingConfig(fhClient?.id, supabase);

  // Determine send target — test mode redirects to your phone, never guests
  const testMode  = !CONFIRMATIONS_ENABLED || process.env.TEST_MODE === "true";
  const sendTo    = testMode && CONFIRMATIONS_TEST_PHONE ? CONFIRMATIONS_TEST_PHONE : guestPhone;

  if (testMode) {
    console.log(`[CONFIRM] TEST MODE — redirecting ${bookingPk} from ${guestPhone} → ${sendTo}`);
  }

  // Handle cancellation
  if (status === "cancelled") {
    // Idempotency — skip if cancellation already sent
    const { data: cancelExisting } = await supabase
      .from("confirmations_sent")
      .select("id, cancellation_sent")
      .eq("booking_pk", bookingPk)
      .single();

    if (cancelExisting?.cancellation_sent) {
      console.log(`[CONFIRM] Cancellation already sent for booking ${bookingPk} — skipping.`);
      return;
    }

    // Per-client gate: if msgConfig row exists, respect enable_cancellations (default true)
    const cancelEnabled = msgConfig ? msgConfig.enable_cancellations : true;
    if (!cancelEnabled) {
      console.log(`[CONFIRM] Cancellations disabled for ${fhClient?.id ?? "unknown"} — skipping booking ${bookingPk}`);
      return;
    }

    // Include rebooking link in cancellation text if rebooking is enabled
    const rebookLink = (msgConfig?.enable_rebooking && fhClient?.bookingUrls?.[0]) ? fhClient.bookingUrls[0] : null;
    const cancelText = buildCancellationText(booking, rebookLink);
    try {
      await twilioClient.messages.create({ body: cancelText, from: fromNumber, to: sendTo });
      console.log(`[CONFIRM] Cancellation sent to ${sendTo} for booking ${bookingPk}`);
    } catch (err) {
      console.error(`[CONFIRM] Cancellation send failed:`, err.message);
      return;
    }

    // Non-fatal — reflect the cancellation text into the guest's conversation
    // thread (if one exists) so staff reviewing it in the portal see it.
    trackAutomatedMessage(supabase, {
      phone: sendTo, toNumber: fromNumber, body: cancelText, messageType: "cancellation",
    }).catch(err => console.warn(`[CONFIRM] conversation tracking failed for ${bookingPk}: ${err.message}`));

    // Mark cancellation sent (upsert in case no prior confirmation row exists)
    await supabase.from("confirmations_sent").upsert(
      {
        booking_pk:        bookingPk,
        guest_phone:       guestPhone,
        guest_name:        booking.contact?.name ?? null,
        company:           booking.company?.shortname ?? "unknown",
        item_name:         booking.availability?.item?.name ?? "tour",
        start_at:          booking.availability?.start_at ?? new Date().toISOString(),
        source,
        cancellation_sent: true,
      },
      { onConflict: "booking_pk" }
    );
    return;
  }

  // Only process confirmed bookings
  if (status !== "booked") return;

  // Per-client gate: if msgConfig row exists, respect enable_confirmation_texts (default true)
  const confirmEnabled = msgConfig ? msgConfig.enable_confirmation_texts : true;
  if (!confirmEnabled) {
    console.log(`[CONFIRM] Confirmation texts disabled for ${fhClient?.id ?? "unknown"} — skipping booking ${bookingPk}`);
    return;
  }

  // P0-2: atomic idempotency CLAIM before sending. Insert the row first; the
  // UNIQUE(booking_pk) constraint means only one caller wins — the webhook and
  // the 30-min poll can no longer both send a confirmation for the same booking.
  // (Old code did select-then-send-then-insert, leaving a duplicate-send window.)
  const { error: claimErr } = await supabase.from("confirmations_sent").insert({
    booking_pk:  bookingPk,
    guest_phone: guestPhone,
    guest_name:  booking.contact?.name ?? null,
    company:     booking.company?.shortname ?? "unknown",
    item_name:   booking.availability?.item?.name ?? "tour",
    start_at:    booking.availability?.start_at ?? new Date().toISOString(),
    source,
  });
  if (claimErr) {
    if (claimErr.code === "23505" || /duplicate|unique/i.test(claimErr.message ?? "")) {
      console.log(`[CONFIRM] Booking ${bookingPk} already claimed/confirmed — skipping.`);
    } else {
      // Couldn't claim → can't guarantee at-most-once → don't send.
      console.error(`[CONFIRM] Idempotency claim failed for ${bookingPk}:`, claimErr.message);
    }
    return;
  }

  const confirmText = buildConfirmationText(booking);

  // Send confirmation. On failure, roll back the claim so the poll can retry
  // (preserves at-least-once for transient Twilio errors without duplicate texts).
  try {
    await twilioClient.messages.create({ body: confirmText, from: fromNumber, to: sendTo });
    console.log(`[CONFIRM] Confirmation sent to ${sendTo} for booking ${bookingPk}${testMode ? " [TEST MODE]" : ""}`);
  } catch (err) {
    console.error(`[CONFIRM] Confirmation send failed:`, err.message);
    await supabase.from("confirmations_sent").delete().eq("booking_pk", bookingPk)
      .then(() => console.log(`[CONFIRM] Rolled back claim for ${bookingPk} (send failed) — will retry`))
      .catch((e) => console.error(`[CONFIRM] Claim rollback failed for ${bookingPk}:`, e.message));
    return;
  }

  // Pre-seed conversation so Summit has context when guest replies
  await preSeedConversation(booking, confirmText, supabase, fromNumber);

  // Schedule reminders (24h + same-day) if enabled in messaging_config
  if (msgConfig?.enable_reminders) {
    scheduleReminders(supabase, booking, sendTo, fromNumber, msgConfig, fhClient?.id ?? null)
      .catch(err => console.error("[CONFIRM] Reminder scheduling error:", err.message));
  }

  // Schedule 30-minute follow-up via durable scheduler (survives Railway restarts)
  try {
    const followUpAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await scheduleMessage(supabase, {
      phone:        sendTo,
      body:         buildFollowUpText(booking),
      message_type: "booking_followup",
      client_id:    fhClient?.id ?? null,
      send_at:      followUpAt,
      metadata:     {
        from_phone:  fromNumber,
        booking_pk:  bookingPk,
        guest_phone: guestPhone,
        test_mode:   testMode,
      },
    });
  } catch (err) {
    // Non-fatal — confirmation already sent, follow-up scheduling failure shouldn't crash
    console.error("[CONFIRM] Follow-up scheduling failed:", err.message);
  }

  // Upsert guest to CRM
  if (crmSupabase) {
    const firstName = (booking.contact?.name ?? "").split(" ")[0];
    const lastName  = (booking.contact?.name ?? "").split(" ").slice(1).join(" ");
    try {
      await crmSupabase.from("contacts").upsert(
        {
          phone:          guestPhone,
          first_name:     firstName || null,
          last_name:      lastName  || null,
          source:         "fareharbor_booking",
          tags:           ["booked"],
          last_activity:  new Date().toISOString(),
          total_bookings: 1,
          client_id:      process.env.CLIENT_ID || "csr_rea",
          opted_in:       true,
        },
        { onConflict: "phone" }
      );
    } catch (err) {
      console.error("[CONFIRM] CRM upsert failed:", err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING — fallback if webhooks miss bookings
// ─────────────────────────────────────────────────────────────────────────────
// P0-3: true when the current worker tick falls in a FareHarbor poll window.
// Original schedule was node-cron "*/30 * * * *" (top + half of each hour);
// the worker ticks every 5 min, so match the :00 and :30 ticks (UTC).
export function isFareHarborPollDue(date = new Date()) {
  const m = date.getUTCMinutes();
  return m < 5 || (m >= 30 && m < 35);
}

export async function pollNewBookings(twilioClient, supabase, crmSupabase) {
  if (process.env.FAREHARBOR_ENABLED !== "true") return;

  const companies = [
    { shortname: "coloradosledrentals", userKeyEnv: "FAREHARBOR_USER_KEY_CSR" },
    { shortname: "rabbitearsadventures", userKeyEnv: "FAREHARBOR_USER_KEY_REA" },
  ];

  try {
    const { data: pollRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "last_booking_poll")
      .single();

    const lastPoll = pollRow?.value ?? "1970-01-01T00:00:00Z";

    for (const company of companies) {
      try {
        const url = `${FAREHARBOR_BASE}/companies/${company.shortname}/bookings/`;
        const res = await fetch(url, {
          headers: {
            "X-FareHarbor-API-App":  process.env.FAREHARBOR_APP_KEY,
            "X-FareHarbor-API-User": process.env[company.userKeyEnv],
          },
        });
        if (!res.ok) continue;

        const { bookings } = await res.json();
        const allBookings = bookings ?? [];

        // New confirmed bookings since last poll
        const newBookings = allBookings.filter(
          (b) => new Date(b.created_at ?? 0) > new Date(lastPoll)
        );
        for (const b of newBookings) {
          await processBookingEvent(b, "poll", twilioClient, supabase, crmSupabase);
        }

        // Missed cancellations — find confirmed bookings that are now cancelled
        // but haven't had a cancellation text sent yet
        const cancelledPks = allBookings
          .filter((b) => b.status === "cancelled")
          .map((b) => String(b.pk));

        if (cancelledPks.length > 0) {
          const { data: pendingCancels } = await supabase
            .from("confirmations_sent")
            .select("booking_pk")
            .in("booking_pk", cancelledPks)
            .eq("cancellation_sent", false);

          for (const row of pendingCancels ?? []) {
            const booking = allBookings.find((b) => String(b.pk) === row.booking_pk);
            if (booking) {
              await processBookingEvent(booking, "poll", twilioClient, supabase, crmSupabase);
            }
          }
        }
      } catch (err) {
        console.error(`[CONFIRM] Poll failed for ${company.shortname}:`, err.message);
      }
    }

    // Update last_booking_poll
    await supabase
      .from("settings")
      .upsert({ key: "last_booking_poll", value: new Date().toISOString() });
  } catch (err) {
    console.error("[CONFIRM] Polling error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK ROUTE
// ─────────────────────────────────────────────────────────────────────────────
export function registerWebhookRoute(app, twilioClient, supabase, crmSupabase) {
  const handleWebhook = (req, res) => {
    // P0-2: authenticate before doing anything. Secret may arrive via path param,
    // ?token= query, or x-webhook-secret header (FH config flexibility).
    const provided = req.params?.token ?? req.query?.token ?? req.get("x-webhook-secret") ?? req.get("x-fareharbor-secret");
    const expected = process.env.FAREHARBOR_WEBHOOK_SECRET ?? null;
    const decision = evaluateFareharborWebhook({ expected, provided });

    if (!decision.allow) {
      console.warn(`[CONFIRM] Rejected FareHarbor webhook (${decision.reason}) ip=${req.ip}`);
      return res.sendStatus(403);
    }
    if (decision.reason === "unconfigured") {
      console.warn("[CONFIRM] FAREHARBOR_WEBHOOK_SECRET unset — webhook is UNAUTHENTICATED. Set it (and append the secret to the FareHarbor callback URL) to enable P0-2 auth.");
    }

    // Respond immediately so FareHarbor doesn't retry
    res.sendStatus(200);

    const booking = req.body?.booking;
    if (!booking) {
      console.warn("[CONFIRM] Webhook received with no booking payload.");
      return;
    }

    console.log(`[CONFIRM] FareHarbor webhook received — booking ${booking.pk}, status: ${booking.status}`);

    // Process async, don't block the response
    processBookingEvent(booking, "webhook", twilioClient, supabase, crmSupabase).catch(
      (err) => console.error("[CONFIRM] Webhook processing error:", err.message)
    );
  };

  // Two shapes so the secret can live in the configured callback URL path
  // (most robust — FH always forwards the path) or via query/header.
  app.post("/fareharbor/webhook", handleWebhook);
  app.post("/fareharbor/webhook/:token", handleWebhook);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initBookingConfirmations(app, twilioClient, supabase, crmSupabase) {
  // Web process owns only the webhook ROUTE. The fallback poll (P0-3) moved to
  // the cron worker — running it here would fire on every web instance and send
  // duplicate confirmation texts under horizontal scaling.
  registerWebhookRoute(app, twilioClient, supabase, crmSupabase);
  console.log("[CONFIRM] Booking confirmations initialized (webhook route only; poll runs in cron worker).");
}
