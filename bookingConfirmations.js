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
import cron from "node-cron";

const FAREHARBOR_BASE = "https://fareharbor.com/api/external/v1";

// CLIENT_CONFIG
const HANDOFF_PHONE = process.env.HANDOFF_PHONE || "(970) 439-1707";

// CONFIRMATIONS_ENABLED=false keeps the webhook/polling running but redirects
// all texts to CONFIRMATIONS_TEST_PHONE so you can verify the format before
// going live. Flip to true when you're ready to text real guests.
const CONFIRMATIONS_ENABLED   = process.env.CONFIRMATIONS_ENABLED !== "false"; // default ON
const CONFIRMATIONS_TEST_PHONE = process.env.CONFIRMATIONS_TEST_PHONE || "";

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

  const text = `Hey ${firstName}! Your ${itemName} with ${company} is confirmed for ${dateStr} at ${timeStr} 🏔 Reply here with any questions!`;

  // Cap at 320 chars
  return text.length <= 320 ? text : text.slice(0, 317) + "...";
}

export function buildCancellationText(booking) {
  const firstName = (booking.contact?.name ?? "there").split(" ")[0];
  const itemName  = booking.availability?.item?.name ?? "your tour";

  const startAt = new Date(booking.availability?.start_at ?? Date.now());
  const dateStr = startAt.toLocaleDateString("en-US", {
    month: "long",
    day:   "numeric",
  });

  const text = `Hey ${firstName}, your ${itemName} on ${dateStr} has been cancelled. Questions? Reply here or call ${HANDOFF_PHONE}.`;
  return text.length <= 200 ? text : text.slice(0, 197) + "...";
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

  await supabase.from("conversations").upsert(
    {
      from_number:   guestPhone,
      to_number:     toNumber ?? process.env.TWILIO_PHONE_NUMBER,
      session_type:  "confirmed_guest",
      booking_step:  3,
      booking_data:  bookingData,
      handoff:       false,
      messages:      [
        {
          role:      "assistant",
          content:   confirmationText,
          timestamp: new Date().toISOString(),
          intent:    "booking",
          sentiment: "positive",
        },
      ],
      updated_at: new Date().toISOString(),
    },
    { onConflict: "from_number,to_number" }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS A SINGLE BOOKING EVENT
// ─────────────────────────────────────────────────────────────────────────────
async function processBookingEvent(booking, source, twilioClient, supabase, crmSupabase) {
  const status     = booking.status;
  const guestPhone = booking.contact?.phone;
  const bookingPk  = String(booking.pk);
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!guestPhone) {
    console.warn(`[CONFIRM] Booking ${bookingPk} has no guest phone — skipping.`);
    return;
  }

  // Determine send target — test mode redirects to your phone, never guests
  const testMode  = !CONFIRMATIONS_ENABLED || process.env.TEST_MODE === "true";
  const sendTo    = testMode && CONFIRMATIONS_TEST_PHONE ? CONFIRMATIONS_TEST_PHONE : guestPhone;

  if (testMode) {
    console.log(`[CONFIRM] TEST MODE — redirecting ${bookingPk} from ${guestPhone} → ${sendTo}`);
  }

  // Handle cancellation
  if (status === "cancelled") {
    const cancelText = buildCancellationText(booking);
    try {
      await twilioClient.messages.create({ body: cancelText, from: fromNumber, to: sendTo });
      console.log(`[CONFIRM] Cancellation sent to ${sendTo} for booking ${bookingPk}`);
    } catch (err) {
      console.error(`[CONFIRM] Cancellation send failed:`, err.message);
    }
    return;
  }

  // Only process confirmed bookings
  if (status !== "booked") return;

  // Idempotency check — skip if already confirmed
  const { data: existing } = await supabase
    .from("confirmations_sent")
    .select("id")
    .eq("booking_pk", bookingPk)
    .single();

  if (existing) {
    console.log(`[CONFIRM] Booking ${bookingPk} already confirmed — skipping.`);
    return;
  }

  const confirmText = buildConfirmationText(booking);

  // Send confirmation
  try {
    await twilioClient.messages.create({ body: confirmText, from: fromNumber, to: sendTo });
    console.log(`[CONFIRM] Confirmation sent to ${sendTo} for booking ${bookingPk}${testMode ? " [TEST MODE]" : ""}`);
  } catch (err) {
    console.error(`[CONFIRM] Confirmation send failed:`, err.message);
    return;
  }

  // Log to confirmations_sent
  await supabase.from("confirmations_sent").insert({
    booking_pk:  bookingPk,
    guest_phone: guestPhone,
    guest_name:  booking.contact?.name ?? null,
    company:     booking.company?.shortname ?? "unknown",
    item_name:   booking.availability?.item?.name ?? "tour",
    start_at:    booking.availability?.start_at ?? new Date().toISOString(),
    source,
  });

  // Pre-seed conversation so Summit has context when guest replies
  await preSeedConversation(booking, confirmText, supabase, fromNumber);

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
async function pollNewBookings(twilioClient, supabase, crmSupabase) {
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
        const newBookings = (bookings ?? []).filter(
          (b) => new Date(b.created_at ?? 0) > new Date(lastPoll)
        );

        for (const b of newBookings) {
          await processBookingEvent(b, "poll", twilioClient, supabase, crmSupabase);
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
  app.post("/fareharbor/webhook", (req, res) => {
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
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initBookingConfirmations(app, twilioClient, supabase, crmSupabase) {
  registerWebhookRoute(app, twilioClient, supabase, crmSupabase);

  // Poll every 30 minutes as a fallback (Tier 2 only)
  if (process.env.FAREHARBOR_ENABLED === "true") {
    cron.schedule("*/30 * * * *", () => {
      pollNewBookings(twilioClient, supabase, crmSupabase);
    });
  }

  console.log("[CONFIRM] Booking confirmations initialized.");
}
