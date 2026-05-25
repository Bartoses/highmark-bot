// ─────────────────────────────────────────────────────────────────────────────
// PHASE 9 — Messaging Automation Engine
//
// Full SMS lifecycle for confirmed guests: reminders, cancellation flow,
// rebooking flow. Configurable per client via messaging_config table.
//
// Exports:
//   DEFAULT_TEMPLATES
//     → default message templates (used when no custom template is set)
//   resolveTemplate(config, type, data)
//     → returns final message string (custom or default, with {placeholder} interpolation)
//   scheduleReminders(supabase, booking, sendTo, fromPhone, config, clientId)
//     → schedules 24h and/or same-day reminders after a booking is confirmed
//   detectCancellationIntent(message)
//     → returns true if message signals a desire to cancel a confirmed booking
//   detectRescheduleIntent(message)
//     → returns true if message signals a desire to reschedule a booking
//   handleCancellationMessage(convo, client)
//     → returns bot reply text for a confirmed guest who wants to cancel
//   handleRescheduleMessage(convo, client)
//     → returns bot reply text for a confirmed guest who wants to reschedule
// ─────────────────────────────────────────────────────────────────────────────

import { scheduleMessage } from "./scheduler.js";

// ── Default Templates ─────────────────────────────────────────────────────────
// Placeholders: {name} {activity} {date} {time} {phone} {booking_link}

export const DEFAULT_TEMPLATES = {
  confirmation:      "Hey {name}! You're confirmed for {activity} on {date} at {time}. Save this number for any questions — we'll send a reminder before. See you out there! 🏔",
  // 30-min post-booking nudge: simple recap + open door. Tips moved to same-day
  // reminder so guests get them when they're most actionable.
  booking_followup:  "Hey {name}! Thanks for booking {activity} on {date}. You're all set — we'll send a reminder before. Questions in the meantime? Just reply, we're here.",
  reminder_24h:      "Reminder: Your {activity} is tomorrow at {time}. Looking forward to seeing you! Any questions? Just reply.",
  // Same-day: reminder + the prep tips guests actually need that morning.
  reminder_same_day: "Today's the day! Your {activity} starts at {time}. Quick tips: dress in layers, bring water, and arrive ~15 min early. Questions? Reply anytime!",
  cancellation_rebook: "Want to pick a new date? {booking_link}",
  post_experience:   "Hey {name}! Thanks for riding with Colorado Sled Rentals 🏔 Hope you had a blast on the {activity}. Quick review? {review_url} Already missing the trails? Book again: {website_url}. Know someone who'd love this? Send 'em our way!",
};

// ── Template Resolution ───────────────────────────────────────────────────────

export function resolveTemplate(config, type, data) {
  const custom = config?.custom_templates ?? {};
  const template = custom[type] ?? DEFAULT_TEMPLATES[type] ?? "";

  const firstName = (data.name ?? "there").split(" ")[0];

  return template
    .replace(/\{name\}/g,         firstName)
    .replace(/\{activity\}/g,     data.activity     ?? "your booking")
    .replace(/\{date\}/g,         data.date         ?? "")
    .replace(/\{time\}/g,         data.time         ?? "")
    .replace(/\{phone\}/g,        data.phone        ?? "")
    .replace(/\{booking_link\}/g, data.bookingLink  ?? "")
    .replace(/\{review_url\}/g,   data.reviewUrl    ?? "")
    .replace(/\{website_url\}/g,  data.websiteUrl   ?? "")
    .replace(/\{business\}/g,     data.business     ?? "");
}

// ── Reminder Scheduling ───────────────────────────────────────────────────────
// Called after confirmation is sent. Schedules 24h and/or same-day reminders
// based on per-client messaging_config. Non-fatal — confirmation already sent.

export async function scheduleReminders(supabase, booking, sendTo, fromPhone, config, clientId) {
  if (!config?.enable_reminders) return { scheduled: 0 };
  if (!booking?.availability?.start_at) return { scheduled: 0 };

  const startAt   = new Date(booking.availability.start_at);
  const now       = Date.now();
  const bookingPk = String(booking.pk ?? "");
  const name      = booking.contact?.name ?? "there";
  const activity  = booking.availability?.item?.name ?? "your booking";

  const dateStr = startAt.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
  const timeStr = startAt.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  const tplData = { name, activity, date: dateStr, time: timeStr };
  const scheduled = [];

  // Idempotency: when this is called from a recurring sync (MPWR runs every
  // 30 min), avoid queuing duplicate reminders for the same (booking_pk, type).
  // Cheap pre-check: pull existing scheduled_messages rows for this booking,
  // then skip the corresponding insert below if one already exists.
  const existingTypes = new Set();
  try {
    const { data: existing } = await supabase
      .from("scheduled_messages")
      .select("message_type")
      .in("message_type", ["reminder_24h", "reminder_same_day"])
      .eq("metadata->>booking_pk", String(bookingPk));
    for (const r of existing ?? []) existingTypes.add(r.message_type);
  } catch { /* non-fatal — fall through; worst case we double-schedule */ }

  // 24h reminder — send 24 hours before start_at (if still in the future)
  if (config.reminder_24h !== false && !existingTypes.has("reminder_24h")) {
    const send24h = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
    if (send24h.getTime() > now + 5 * 60 * 1000) {   // at least 5 min away
      try {
        await scheduleMessage(supabase, {
          phone:        sendTo,
          body:         resolveTemplate(config, "reminder_24h", tplData).slice(0, 320),
          message_type: "reminder_24h",
          client_id:    clientId ?? null,
          send_at:      send24h.toISOString(),
          metadata:     { from_phone: fromPhone, booking_pk: bookingPk },
        });
        scheduled.push("24h");
      } catch (err) {
        console.error("[MSG] 24h reminder scheduling failed:", err.message);
      }
    }
  }

  // Same-day reminder — send 2 hours before start_at (if still in the future)
  if (config.reminder_same_day && !existingTypes.has("reminder_same_day")) {
    const sendSameDay = new Date(startAt.getTime() - 2 * 60 * 60 * 1000);
    if (sendSameDay.getTime() > now + 5 * 60 * 1000) {
      try {
        await scheduleMessage(supabase, {
          phone:        sendTo,
          body:         resolveTemplate(config, "reminder_same_day", tplData).slice(0, 320),
          message_type: "reminder_same_day",
          client_id:    clientId ?? null,
          send_at:      sendSameDay.toISOString(),
          metadata:     { from_phone: fromPhone, booking_pk: bookingPk },
        });
        scheduled.push("same_day");
      } catch (err) {
        console.error("[MSG] Same-day reminder scheduling failed:", err.message);
      }
    }
  }

  if (scheduled.length > 0) {
    console.log(`[MSG] Reminders scheduled for booking ${bookingPk}: ${scheduled.join(", ")}`);
  }
  return { scheduled: scheduled.length, types: scheduled };
}

// ── Post-experience follow-up ─────────────────────────────────────────────────
// Schedules ONE SMS at end_at + post_experience_hours_after (default 24h).
// Idempotent: checks scheduled_messages for an existing post_experience row on
// the same booking_pk before inserting. Returns:
//   { scheduled: true,  send_at }                — newly queued
//   { scheduled: false, reason: "..." }          — gated, duplicate, or invalid
// Inputs:
//   booking — { booking_pk, end_at (ISO), phone, name?, activity?, business? }
//   options — { reviewUrl, websiteUrl, fromPhone, hoursAfter, template, clientId }
export async function schedulePostExperienceFollowUp(booking, supabase, options = {}) {
  if (!booking?.booking_pk || !booking?.end_at || !booking?.phone) {
    return { scheduled: false, reason: "missing_required_field" };
  }
  if (!supabase) return { scheduled: false, reason: "no_supabase" };

  const hoursAfter = Number.isFinite(options.hoursAfter) ? options.hoursAfter : 24;
  const sendAt     = new Date(new Date(booking.end_at).getTime() + hoursAfter * 3600 * 1000);
  // Skip if we'd be sending more than 7 days in the past — too stale to be useful.
  const staleMs    = Date.now() - sendAt.getTime();
  if (staleMs > 7 * 86400 * 1000) {
    return { scheduled: false, reason: "too_stale" };
  }

  // Idempotency: have we already scheduled (or sent) a post_experience for this booking?
  try {
    const { data: existing } = await supabase
      .from("scheduled_messages")
      .select("id, status")
      .eq("message_type", "post_experience")
      .eq("metadata->>booking_pk", String(booking.booking_pk))
      .limit(1)
      .maybeSingle();
    if (existing?.id) return { scheduled: false, reason: "already_scheduled", existing_id: existing.id };
  } catch { /* table missing or query error → fall through, scheduleMessage will surface */ }

  const tplCfg = options.template
    ? { custom_templates: { post_experience: options.template } }
    : null;

  const body = resolveTemplate(tplCfg, "post_experience", {
    name:        booking.name        ?? "there",
    activity:    booking.activity    ?? "your adventure",
    reviewUrl:   options.reviewUrl   ?? "",
    websiteUrl:  options.websiteUrl  ?? "",
    business:    booking.business    ?? "us",
  }).slice(0, 320);

  // Send-at must be at least 1 min in the future (otherwise drop send_at to now+1min
  // so the next scheduler tick picks it up immediately for backfill cases).
  const finalSendAt = sendAt.getTime() < Date.now() + 60000
    ? new Date(Date.now() + 60 * 1000).toISOString()
    : sendAt.toISOString();

  try {
    await scheduleMessage(supabase, {
      phone:        booking.phone,
      body,
      message_type: "post_experience",
      client_id:    options.clientId ?? null,
      send_at:      finalSendAt,
      metadata:     {
        from_phone: options.fromPhone ?? null,
        booking_pk: String(booking.booking_pk),
      },
    });
    console.log(`[MSG] post_experience scheduled for booking ${booking.booking_pk} @ ${finalSendAt}`);
    return { scheduled: true, send_at: finalSendAt };
  } catch (err) {
    console.error(`[MSG] post_experience schedule failed for ${booking.booking_pk}: ${err.message}`);
    return { scheduled: false, reason: "scheduler_error", error: err.message };
  }
}

// ── Intent Detection ──────────────────────────────────────────────────────────
// These are checked specifically for confirmed guests (session_type = confirmed_guest).
// Intentionally stricter than general intent detection to avoid false positives.

export function detectCancellationIntent(message) {
  const t = message.toLowerCase().trim();
  // Must contain a cancellation word
  const hasCancelWord = /\b(cancel|can't make it|cannot make it|won't make it|need to cancel|want to cancel|canceling|cancelling|call it off|can not make it)\b/i.test(t);
  // Must not be a negation ("don't cancel", "please don't cancel that")
  const isNegated = /\b(don't cancel|do not cancel|not cancel|never cancel|please keep)\b/i.test(t);
  return hasCancelWord && !isNegated;
}

export function detectRescheduleIntent(message) {
  const t = message.toLowerCase().trim();
  return /\b(reschedule|rescheduling|change (my |the )?(date|time|booking|reservation|appointment)|move (my |the )?(booking|tour|reservation|appointment)|pick (a |an |another )(date|time|day)|different (date|time|day)|postpone|push (it |back|my booking)|another (day|time|date))\b/i.test(t);
}

// ── Conversation Handlers ─────────────────────────────────────────────────────
// Return the bot's reply text for confirmed guests who want to cancel or rebook.
// These are deterministic — no Claude call needed for simple lifecycle responses.

export function handleCancellationMessage(convo, client) {
  const bookingData = convo.bookingData ?? convo.booking_data ?? {};
  const activity = bookingData.activity ?? "your booking";
  const date     = bookingData.date ?? null;
  const phone    = client.supportPhone ?? client.handoffPhone ?? "";

  // Prefer a portal-configured booking link, fall back to first scrape/booking URL
  const bookingLink =
    client.bookingLink ??
    client.bookingLinks?.[0]?.url ??
    client.bookingUrls?.[0] ??
    null;

  let reply = `Sorry to hear that! To cancel your ${activity}${date ? ` on ${date}` : ""}, please call us at ${phone} — we can get that sorted for you quickly.`;

  if (bookingLink) {
    reply += ` Want to rebook for another date? ${bookingLink}`;
  }

  return reply.slice(0, 320);
}

export function handleRescheduleMessage(convo, client) {
  const bookingData = convo.bookingData ?? convo.booking_data ?? {};
  const activity = bookingData.activity ?? "your booking";
  const phone    = client.supportPhone ?? client.handoffPhone ?? "";

  const bookingLink =
    client.bookingLink ??
    client.bookingLinks?.[0]?.url ??
    client.bookingUrls?.[0] ??
    null;

  let reply;
  if (bookingLink) {
    reply = `Happy to help you reschedule your ${activity}! Pick a new date here: ${bookingLink} — or call ${phone} and we will take care of it.`;
  } else {
    reply = `Happy to help you reschedule your ${activity}! Give us a call at ${phone} and we will get you set up for a new date.`;
  }

  return reply.slice(0, 320);
}
