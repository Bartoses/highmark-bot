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
  reminder_24h:     "Reminder: Your {activity} is tomorrow at {time}. Looking forward to seeing you! Any questions? Just reply.",
  reminder_same_day:"Today's the day! Your {activity} starts at {time}. See you out there! Questions? Reply anytime.",
  cancellation_rebook: "Want to pick a new date? {booking_link}",
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
    .replace(/\{booking_link\}/g, data.bookingLink  ?? "");
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

  // 24h reminder — send 24 hours before start_at (if still in the future)
  if (config.reminder_24h !== false) {
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
  if (config.reminder_same_day) {
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
