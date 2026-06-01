// mpwrSync.js — MPWR (Polaris Adventures) booking sync
//
// Fetches upcoming + recent bookings from CSR Kremmling and Steamboat Springs
// and upserts them into DB2 (customers + bookings tables) so that daily_manifest
// is always the authoritative source of truth. Idempotent — safe to run repeatedly.
//
// Auth: JWT Bearer token from MPWR_TOKEN env var (24h validity).
//   - Set MPWR_TOKEN in Railway env vars.
//   - To refresh: log into mpwr-hq.poladv.com → DevTools → Application → Cookies
//     → copy __xauth cookie value (the "Bearer eyJ..." part) → update MPWR_TOKEN
//     in Railway (omit the leading "Bearer ").
//   - The cron worker logs a warning when the token is within 2 hours of expiry.
//
// Endpoint: GET https://mpwr-hq.poladv.com/orders.data (React Router v7 data route)
// Response: turbo-stream encoded JSON — decoded by decodeTurboStream() below.

import { normalizePhone } from './phoneUtils.js';
import { upsertContact }  from './crm.js';

const MPWR_BASE = 'https://mpwr-hq.poladv.com';

// DB2 activity UUIDs — verified against public.activities in aiiguzslqiemksrvfvwk
const ACTIVITY_BY_OUTFITTER = {
  541: 'c028dc5b-e2ed-40ec-a209-4ef06a1d15ab', // Kremmling RZR
  58:  '45c66b1e-9c5d-4116-b4f7-3cafe3ad9e8c', // Steamboat RZR
};

const STATUS_MAP = {
  Upcoming:      'booked',
  CompletedRide: 'completed',
  Cancelled:     'cancelled',
  NoShow:        'no_show',
};

// Map MPWR productTitle prefix → DB2 location string.
// Order matters — most specific prefixes first. Fallback uses the outfitter label.
const LOCATION_PREFIXES = [
  { match: /^rabbit ears/i, location: 'rabbit_ears' },
  { match: /^north routt/i, location: 'north_routt' },
  { match: /^kremmling/i,   location: 'kremmling'   },
  { match: /^steamboat/i,   location: 'steamboat'   },
  { match: /^ava kremmling/i, location: 'kremmling' },
];

// Derive a DB2 `bookings.location` value from the MPWR productTitle.
// Returns null when no prefix matches — caller may fall back to outfitter label.
export function deriveLocationFromTitle(productTitle) {
  if (!productTitle) return null;
  const trimmed = String(productTitle).trim();
  for (const { match, location } of LOCATION_PREFIXES) {
    if (match.test(trimmed)) return location;
  }
  return null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Returns the stored JWT and warns if it's within 2 hours of expiry.
// Token is stored in MPWR_TOKEN env var (just the JWT, no "Bearer " prefix).
// To refresh: log into mpwr-hq.poladv.com, open DevTools → Application → Cookies,
// copy the __xauth value (strip the leading "Bearer "), update Railway env var.
function getToken() {
  const token = process.env.MPWR_TOKEN;
  if (!token) throw new Error('MPWR_TOKEN not set — paste JWT from __xauth cookie into Railway env vars');

  // Decode JWT exp claim (no signature verification needed — we trust our own env var)
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const expiresIn = payload.exp * 1000 - Date.now();
    if (expiresIn < 0) {
      throw new Error(`MPWR_TOKEN expired ${Math.round(-expiresIn / 3600000)}h ago — refresh it in Railway env vars`);
    }
    if (expiresIn < 2 * 3600 * 1000) {
      console.warn(`[mpwrSync] ⚠️  MPWR_TOKEN expires in ${Math.round(expiresIn / 60000)} min — update Railway env var soon`);
    }
  } catch (err) {
    if (err.message.startsWith('MPWR_TOKEN')) throw err;
    // JWT decode failed — token might still work, proceed
  }

  return token;
}

// ── React Router v7 turbo-stream decoder ─────────────────────────────────────
// The /orders.data response is a compact reference-encoded JSON array.
// Format:
//   - arr[0] is the root element
//   - Objects use {"_N": V} where arr[N] is the key name and V is a reference index
//   - Arrays contain reference indices (each element is an index into arr)
//   - -5 represents null; negative numbers represent null
//   - Primitive values (strings, numbers, booleans) are stored as arr[N] and
//     accessed via their index — when arr[N] is a primitive, decode returns it directly

function decodeTurboStream(raw) {
  const arr = JSON.parse(raw);

  // decode: convert an arr element (already looked up) into a JS value
  function decode(elem) {
    if (elem === -5 || elem === null || elem === undefined) return null;
    if (typeof elem === 'boolean' || typeof elem === 'string' || typeof elem === 'number') return elem;
    if (Array.isArray(elem)) return elem.map(deref);
    // Object with _N: V format — V is always a reference index
    const out = {};
    for (const [k, v] of Object.entries(elem)) {
      if (!k.startsWith('_')) continue;
      const keyName = arr[parseInt(k.slice(1), 10)];
      if (typeof keyName === 'string') out[keyName] = deref(v);
    }
    return out;
  }

  // deref: resolve an index into its decoded value
  function deref(idx) {
    if (idx === null || idx === undefined || (typeof idx === 'number' && idx < 0)) return null;
    if (typeof idx !== 'number') return null;
    return decode(arr[idx]);
  }

  return decode(arr[0]);
}

// ── Date / time helpers ───────────────────────────────────────────────────────

// Mountain Time UTC offset: MDT (UTC-6) from 2nd Sun March → 1st Sun November,
// MST (UTC-7) otherwise. Accurate enough for rental booking dates.
function mtOffset(dateStr) {
  const d     = new Date(dateStr + 'T12:00:00Z');
  const year  = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 2,  8));  // ~Mar 8
  const end   = new Date(Date.UTC(year, 10, 1));  // ~Nov 1
  return d >= start && d < end ? '-06:00' : '-07:00';
}

function toUtcIso(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00${mtOffset(dateStr)}`).toISOString();
}

function buildArrivalDisplay(dateStr, startTime, endTime) {
  const d    = new Date(dateStr + 'T12:00:00Z');
  const date = d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const fmt = t => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };
  return `${fmt(startTime)} - ${fmt(endTime)} on ${date}`;
}

// ── Fetch orders from MPWR ────────────────────────────────────────────────────

// MPWR's /orders.data defaults to ~7 days ahead. To include bookings further
// out, pass `?dateRange={"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}`
// (JSON value, URL-encoded once) — same shape the web UI's "Next 30 days"
// preset emits. We pull 90 days forward to cover the booking pipeline.
const FETCH_DAYS_AHEAD = 90;

export function buildDateRangeParam(daysAhead = FETCH_DAYS_AHEAD) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const end   = new Date(); end.setDate(end.getDate() + daysAhead);
  return encodeURIComponent(JSON.stringify({ startDate: fmt(today), endDate: fmt(end) }));
}

// Per-order detail endpoint — exposes reservation.vehicles[] + assetFamilies[]
// so we can resolve the actual asset family name booked (e.g. "RZR PRO S4").
// Streaming response: main JSON array, optionally followed by `Pn:[[…]]` chunks
// of deferred data we don't need. Strip those before parsing.
async function fetchOrderDetail(shortId, outfitterId, token) {
  const url = `${MPWR_BASE}/orders/${shortId}.data`;
  const res = await fetch(url, {
    headers: {
      'Accept':  '*/*',
      'Cookie':  `__xauth=Bearer ${token}; __outfitter_session=${outfitterId}`,
      'Referer': `${MPWR_BASE}/orders/${shortId}`,
    },
  });
  if (!res.ok) throw new Error(`MPWR detail ${shortId} returned ${res.status}`);
  const raw = await res.text();
  const main = raw.split(/\nP\d+:/)[0];

  // The detail response has self-referential objects; use a memoizing decoder.
  const arr  = JSON.parse(main);
  const memo = new Map();
  function deref(i) {
    if (i == null || (typeof i === 'number' && i < 0)) return null;
    if (typeof i !== 'number') return null;
    if (memo.has(i)) return memo.get(i);
    const placeholder = {};
    memo.set(i, placeholder);
    const v = decode(arr[i]);
    memo.set(i, v);
    return v;
  }
  function decode(elem) {
    if (elem === -5 || elem == null) return null;
    if (typeof elem !== 'object') return elem;
    if (Array.isArray(elem)) return elem.map(deref);
    const out = {};
    for (const [k, v] of Object.entries(elem)) {
      if (!k.startsWith('_')) continue;
      const keyName = arr[parseInt(k.slice(1), 10)];
      if (typeof keyName === 'string') out[keyName] = deref(v);
    }
    return out;
  }
  return deref(0)?.['routes/_authenticated/_customer-orders/orders.$orderShortId/_layout']?.data ?? null;
}

// Resolve the booked vehicle asset-family name from order detail.
// Returns a single string (the dominant family) or null if unresolved.
// When multiple distinct families are booked (rare), returns the most common.
export function resolveVehicleFromDetail(detail) {
  const vehicles      = detail?.reservation?.vehicles ?? [];
  const assetFamilies = detail?.assetFamilies ?? [];
  if (!vehicles.length || !assetFamilies.length) return null;
  const familyById = new Map(assetFamilies.map(f => [f?.id, f?.name]).filter(([id]) => id));
  const counts     = new Map();
  for (const v of vehicles) {
    const name = familyById.get(v?.assetFamilyId);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (!counts.size) return null;
  // Pick most common; ties broken alphabetically for determinism.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// Resolve the booking-contact email + affiliate from order detail.
// MPWR stores the guest email on detail.riders[] — the primary rider is the one
// whose customerId matches the order's customerId (multi-rider bookings include
// passengers with no email). The email is captured even when it belongs to a
// lodging company / reseller (e.g. Moving Mountains booking on a guest's behalf).
//
// detail.affiliates[] is the outfitter's full affiliate registry. When the guest
// email matches one of those entries, the booking came in through that affiliate,
// so we surface its name as bookings.affiliate. Returns { email, affiliate }.
export function extractGuestContact(detail, order = {}) {
  const riders = detail?.riders ?? [];
  const custId = order?.customerId ?? detail?.order?.customerId ?? null;

  const primary =
    (custId && riders.find(r => r?.customerId === custId)) ||
    riders.find(r => r?.email) ||
    riders[0] ||
    null;

  const email = primary?.email?.trim() || null;

  let affiliate = null;
  if (email) {
    const match = (detail?.affiliates ?? []).find(
      a => (a?.email ?? '').trim().toLowerCase() === email.toLowerCase()
    );
    // Normalize to the FareHarbor-style affiliate slug (lowercase, alphanumeric
    // only) so MPWR- and FH-sourced bookings collapse to one value in reporting:
    // "Moving Mountains" → "movingmountains".
    if (match?.name) {
      const slug = match.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      affiliate = slug || null;
    }
  }

  return { email, affiliate };
}

async function fetchOrders(outfitterId, token, daysAhead = FETCH_DAYS_AHEAD) {
  const url = `${MPWR_BASE}/orders.data?dateRange=${buildDateRangeParam(daysAhead)}`;
  const res = await fetch(url, {
    headers: {
      'Accept':          '*/*',
      'Cookie':          `__xauth=Bearer ${token}; __outfitter_session=${outfitterId}`,
      'Referer':         `${MPWR_BASE}/orders`,
      'Sec-Fetch-Mode':  'cors',
      'Sec-Fetch-Site':  'same-origin',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MPWR orders fetch ${res.status} for outfitter ${outfitterId}: ${text.slice(0, 200)}`);
  }

  const raw     = await res.text();
  const decoded = decodeTurboStream(raw);

  // Navigate: root → route key → data → tableServerState → rows
  const routeKey = 'routes/_authenticated/_customer-orders/orders/index';
  const rows     = decoded?.[routeKey]?.data?.tableServerState?.rows;

  if (!Array.isArray(rows)) {
    console.warn(`[mpwrSync] No rows decoded for outfitter ${outfitterId} (rowCount may be 0)`);
    return [];
  }

  return rows;
}

// ── Upsert one order into DB2 ─────────────────────────────────────────────────

async function upsertOrder(order, activityId, db2, { db1, twilioClient, locationLabel, outfitterId, token } = {}) {
  const rawPhone = order.customerPhoneNumber;
  const phone    = rawPhone ? normalizePhone(rawPhone) : null;
  const name     = (
    order.customerName ??
    `${order.customerFirstName ?? ''} ${order.customerLastName ?? ''}`.trim()
  ) || null;

  if (!name) return 'skipped:no-name';

  // Derive location from the productTitle prefix; fall back to outfitter label.
  // E.g. "Rabbit Ears UTV Rentals | …" → 'rabbit_ears', distinct from the
  // outfitter (58 → Steamboat). productTitle missing → outfitter fallback.
  const productTitle = order.productTitle ?? null;
  const location     = deriveLocationFromTitle(productTitle) ?? (locationLabel ?? '').toLowerCase() ?? null;

  // Resolve booked vehicle by fetching the order detail and matching
  // reservation.vehicles[].assetFamilyId against assetFamilies[]. Best-effort —
  // a detail failure shouldn't block the booking upsert.
  let vehicle    = null;
  let guestEmail = null;
  let affiliate  = null;
  if (outfitterId && token) {
    try {
      const detail = await fetchOrderDetail(order.shortId, outfitterId, token);
      vehicle = resolveVehicleFromDetail(detail);
      const contact = extractGuestContact(detail, order);
      guestEmail = contact.email;
      affiliate  = contact.affiliate;
    } catch (err) {
      console.warn(`[mpwrSync] detail fetch failed for ${order.shortId}: ${err.message}`);
    }
  }

  // ── Step 1: upsert customer ─────────────────────────────────────────────────
  let customerId = null;

  // email is included only when present so an emailless re-sync never nulls a
  // previously-captured address. Captured even when it's a lodging/reseller email.
  const emailField = guestEmail ? { email: guestEmail } : {};

  if (phone) {
    await db2.from('customers').upsert(
      { name, normalized_phone: phone, company: 'coloradosledrentals', ...emailField },
      { onConflict: 'normalized_phone' }
    );
    const { data: c } = await db2.from('customers')
      .select('id').eq('normalized_phone', phone).single();
    customerId = c?.id ?? null;

  } else {
    // No phone — match by name + null phone; insert if absent
    const { data: c } = await db2.from('customers').select('id')
      .eq('name', name).is('normalized_phone', null).maybeSingle();
    if (c) {
      customerId = c.id;
      if (guestEmail) await db2.from('customers').update(emailField).eq('id', c.id);
    } else {
      const { data: n } = await db2.from('customers')
        .insert({ name, company: 'coloradosledrentals', ...emailField }).select('id').single();
      customerId = n?.id ?? null;
    }
  }

  if (!customerId) return 'skipped:no-customer-id';

  // ── Step 2: upsert booking ──────────────────────────────────────────────────
  const beginDate = order.beginDate;
  const endDate   = order.endDate   ?? beginDate;
  const startTime = order.ridingStartTime ?? '09:00';
  const endTime   = order.ridingEndTime   ?? '17:00';
  const total     = order.invoice?.total  ?? 0;
  // amountPaid is null for future bookings paid in full at booking time —
  // use total as paid when null (MPWR collects full payment at booking)
  const paid      = order.invoice?.amountPaid ?? total;

  const { error } = await db2.from('bookings').upsert({
    fareharbor_pk:       order.shortId,
    customer_id:         customerId,
    activity_id:         activityId,
    start_at:            toUtcIso(beginDate, startTime),
    end_at:              toUtcIso(endDate,   endTime),
    status:              STATUS_MAP[order.reservationStatus] ?? 'booked',
    customer_count:      order.reservationVehiclesCount ?? 1,
    receipt_total_cents: total,
    amount_paid_cents:   paid,
    total_cents:         total,
    total_paid_cents:    paid,
    arrival_time:        toUtcIso(beginDate, startTime),
    arrival_display:     buildArrivalDisplay(beginDate, startTime, endTime),
    company:             'coloradosledrentals',
    location,
    product_title:       productTitle,
    vehicle,
    affiliate,
  }, { onConflict: 'fareharbor_pk' });

  if (error) throw new Error(error.message);

  // Sweep BOT- placeholder for the same booking, if one exists.
  // BOT- rows are synthetic PKs written by handleImportBooking when an SMS-forwarded
  // notification arrives before the real CO- PK syncs. They carry $0 / placeholder
  // data; the CO- row we just wrote is authoritative. handleImportBooking skips
  // writing a BOT- when a real twin already exists — this sweeps the reverse case.
  const startAt = toUtcIso(beginDate, startTime);
  const { data: stalePlaceholder } = await db2.from('bookings')
    .select('fareharbor_pk')
    .eq('customer_id', customerId)
    .eq('start_at', startAt)
    .like('fareharbor_pk', 'BOT-%')
    .maybeSingle();
  if (stalePlaceholder?.fareharbor_pk) {
    const { error: delErr } = await db2.from('bookings')
      .delete().eq('fareharbor_pk', stalePlaceholder.fareharbor_pk);
    if (delErr) console.warn(`[mpwrSync] could not delete BOT- twin ${stalePlaceholder.fareharbor_pk}: ${delErr.message}`);
    else console.log(`[mpwrSync] swept BOT- twin ${stalePlaceholder.fareharbor_pk} (real ${order.shortId} arrived)`);
  }

  // Mirror to DB2 contacts (CRM) so MPWR bookings are reachable by campaigns,
  // segments, and the operator portal — same pattern as operator_import + sms.
  // Skipped silently when phone is missing (upsertContact requires a phone key).
  if (phone) {
    const status   = order.reservationStatus;
    const isBooked = (STATUS_MAP[status] ?? 'booked') === 'booked';
    const tags     = ['rzr', (locationLabel ?? '').toLowerCase()].filter(Boolean);
    if (isBooked) tags.push('booked');
    try {
      await upsertContact(phone, {
        firstName:         order.customerFirstName ?? null,
        lastName:          order.customerLastName  ?? null,
        source:            'mpwr_sync',
        tags,
        incrementBookings: false, // upsert is idempotent per sync cycle — don't double-count
      }, db2);
    } catch (err) {
      console.warn(`[mpwrSync] contact mirror failed for ${order.shortId}: ${err.message}`);
    }
  }

  // Fire confirmation text (idempotent, gated by per-client toggle).
  // Status "booked" only — cancellations / completed don't trigger.
  if (db1 && twilioClient && phone && (STATUS_MAP[order.reservationStatus] ?? 'booked') === 'booked') {
    try {
      await sendPolarisConfirmationIfNeeded({
        bookingPk:     order.shortId,
        guestPhone:    phone,
        guestName:     name,
        locationLabel: locationLabel ?? null,
        beginDate,
        startTime,
        endTime,
        db1,
        twilioClient,
      });
    } catch (err) {
      console.warn(`[mpwrSync] confirmation send failed for ${order.shortId}: ${err.message}`);
    }
  }

  // Schedule pre-experience reminders (24h + same-day) for MPWR bookings,
  // gated by messaging_config.enable_reminders. The FareHarbor webhook path
  // wires these via bookingConfirmations.js; MPWR didn't until now, so RZR
  // bookings (~all of CSR/REA) got zero pre-arrival texts. scheduleReminders
  // is idempotent (checks scheduled_messages by booking_pk+type), so calling
  // it on every 30-min sync tick is safe — no duplicates.
  if (db1 && phone && (STATUS_MAP[order.reservationStatus] ?? 'booked') === 'booked') {
    try {
      const { data: cfg } = await db1
        .from('messaging_config')
        .select('enable_reminders, reminder_24h, reminder_same_day, custom_templates')
        .eq('client_id', 'csr_rea')
        .maybeSingle();
      if (cfg?.enable_reminders) {
        const { scheduleReminders } = await import('./messagingEngine.js');
        const mockBooking = {
          pk:      order.shortId,
          contact: { name },
          availability: {
            start_at: toUtcIso(beginDate, startTime),
            item:     { name: order.productTitle ?? 'your booking' },
          },
        };
        await scheduleReminders(
          db1,
          mockBooking,
          phone,
          process.env.CSR_REA_TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER || null,
          cfg,
          'csr_rea',
        );
      }
    } catch (err) {
      console.warn(`[mpwrSync] reminder scheduling failed for ${order.shortId}: ${err.message}`);
    }
  }

  // Schedule the post-experience follow-up (idempotent — skipped if already
  // queued). Gated by messaging_config.enable_post_experience_followup for
  // csr_rea so it can be toggled per client without code changes.
  if (db1 && phone && (STATUS_MAP[order.reservationStatus] ?? 'booked') !== 'cancelled') {
    try {
      const { data: cfg } = await db1
        .from('messaging_config')
        .select('enable_post_experience_followup, post_experience_hours_after, review_url, website_url, custom_templates')
        .eq('client_id', 'csr_rea')
        .maybeSingle();
      if (cfg?.enable_post_experience_followup) {
        const { schedulePostExperienceFollowUp } = await import('./messagingEngine.js');
        await schedulePostExperienceFollowUp({
          booking_pk: order.shortId,
          end_at:     toUtcIso(endDate, endTime),
          phone,
          name,
          activity:   order.productTitle ?? 'your adventure',
        }, db1, {
          hoursAfter: cfg.post_experience_hours_after ?? 24,
          template:   cfg.custom_templates?.post_experience ?? null,
          reviewUrl:  cfg.review_url  ?? '',
          websiteUrl: cfg.website_url ?? '',
          fromPhone:  process.env.CSR_REA_TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER || null,
          clientId:   'csr_rea',
        });
      }
    } catch (err) {
      console.warn(`[mpwrSync] post-experience schedule failed for ${order.shortId}: ${err.message}`);
    }
  }

  return 'upserted';
}

// ── Polaris confirmation text ────────────────────────────────────────────────
// Mirrors the FH confirmation flow:
//   1. Check messaging_config.enable_confirmation_texts for csr_rea (Polaris
//      bookings always belong to coloradosledrentals/csr_rea).
//   2. Skip if confirmations_sent already has a row for this booking_pk.
//   3. Build a Polaris-flavored text and send via Twilio.
//   4. Insert into confirmations_sent with source='mpwr'.
//
// Test mode: CONFIRMATIONS_ENABLED=false or TEST_MODE=true redirects to
// CONFIRMATIONS_TEST_PHONE if set; otherwise the send is skipped entirely.
// ─────────────────────────────────────────────────────────────────────────────
async function sendPolarisConfirmationIfNeeded({
  bookingPk, guestPhone, guestName, locationLabel,
  beginDate, startTime, endTime, db1, twilioClient,
}) {
  const clientId = 'csr_rea';

  // Per-client gate via messaging_config (default OFF for safety until owner enables).
  let confirmEnabled = false;
  try {
    const { data: cfg } = await db1
      .from('messaging_config')
      .select('enable_confirmation_texts')
      .eq('client_id', clientId)
      .maybeSingle();
    confirmEnabled = cfg ? !!cfg.enable_confirmation_texts : false;
  } catch { /* table missing → leave default OFF */ }

  if (!confirmEnabled) return;

  // Idempotency check — skip if confirmation already sent
  const { data: existing } = await db1
    .from('confirmations_sent')
    .select('id')
    .eq('booking_pk', bookingPk)
    .maybeSingle();
  if (existing) return;

  // Test mode — redirect or skip
  const testMode = process.env.CONFIRMATIONS_ENABLED === 'false' || process.env.TEST_MODE === 'true';
  const testTo   = process.env.CONFIRMATIONS_TEST_PHONE || null;
  if (testMode && !testTo) {
    console.log(`[mpwrSync] [TEST MODE] Would send Polaris confirmation for ${bookingPk} to ${guestPhone}`);
    return;
  }
  const sendTo = testMode ? testTo : guestPhone;

  // From-number resolution — prefer CSR_REA_TWILIO_NUMBER; fall back to global Twilio number.
  const fromNumber = process.env.CSR_REA_TWILIO_NUMBER || process.env.TWILIO_PHONE_NUMBER || null;
  if (!fromNumber) {
    console.warn(`[mpwrSync] No outbound Twilio number — skipping confirmation for ${bookingPk}`);
    return;
  }

  const text = buildPolarisConfirmationText({
    guestName, locationLabel, beginDate, startTime, endTime, bookingPk,
  });

  try {
    await twilioClient.messages.create({ body: text, from: fromNumber, to: sendTo });
    console.log(`[mpwrSync] Polaris confirmation sent to ${sendTo} for ${bookingPk}${testMode ? ' [TEST MODE]' : ''}`);
  } catch (err) {
    throw new Error(`Twilio send failed: ${err.message}`);
  }

  // Record send so we don't double-text
  await db1.from('confirmations_sent').upsert(
    {
      booking_pk:           bookingPk,
      guest_phone:          guestPhone,
      guest_name:           guestName,
      company:              'coloradosledrentals',
      item_name:            locationLabel ? `RZR ${locationLabel}` : 'RZR adventure',
      start_at:             toUtcIso(beginDate, startTime),
      confirmation_sent_at: new Date().toISOString(),
      source:               'mpwr',
      cancellation_sent:    false,
    },
    { onConflict: 'booking_pk' }
  );
}

export function buildPolarisConfirmationText({ guestName, locationLabel, beginDate, startTime, endTime, bookingPk }) {
  const firstName = (guestName ?? 'there').split(' ')[0];
  const loc       = locationLabel ?? 'Steamboat';
  // Build a friendly date string from beginDate (YYYY-MM-DD)
  let dateStr = beginDate;
  try {
    const [y, m, d] = String(beginDate).split('-').map(Number);
    if (y && m && d) {
      dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
  } catch { /* leave as-is */ }
  const timeRange = startTime && endTime ? ` from ${formatTime12(startTime)}–${formatTime12(endTime)}` : '';

  const body = `Hey ${firstName}! Your ${loc} RZR ride with Colorado Sled Rentals is confirmed for ${dateStr}${timeRange} 🏔`;
  const suffix = ` Confirmation: ${bookingPk}. Reply here with any questions!`;
  const text = body + suffix;
  return text.length <= 320 ? text : text.slice(0, 317) + '...';
}

function formatTime12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

// ── Sync one outfitter location ───────────────────────────────────────────────

async function syncLocation(outfitterId, db2, opts = {}) {
  const token      = getToken();
  const orders     = await fetchOrders(outfitterId, token);
  const activityId = ACTIVITY_BY_OUTFITTER[outfitterId];

  if (!activityId) throw new Error(`No activity mapping for outfitter ${outfitterId}`);

  let upserted = 0, skipped = 0, errors = 0;

  for (const order of orders) {
    if (!order?.shortId) { skipped++; continue; }
    try {
      const r = await upsertOrder(order, activityId, db2, { ...opts, outfitterId, token });
      r === 'upserted' ? upserted++ : skipped++;
    } catch (err) {
      console.error(`[mpwrSync] ${order.shortId}: ${err.message}`);
      errors++;
    }
  }

  return { outfitterId, total: orders.length, upserted, skipped, errors };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runMpwrSync(db2, { db1 = null, twilioClient = null } = {}) {
  if (!process.env.MPWR_TOKEN) {
    console.log('[mpwrSync] Skipping — MPWR_TOKEN not set');
    return null;
  }

  const locations = [
    { id: Number(process.env.MPWR_OUTFITTER_KREMMLING), label: 'Kremmling' },
    { id: Number(process.env.MPWR_OUTFITTER_STEAMBOAT), label: 'Steamboat' },
  ].filter(l => l.id && !isNaN(l.id));

  if (!locations.length) {
    console.warn('[mpwrSync] No outfitter IDs configured');
    return null;
  }

  const results = [];
  for (const loc of locations) {
    try {
      const r = await syncLocation(loc.id, db2, { db1, twilioClient, locationLabel: loc.label });
      console.log(`[mpwrSync] ${loc.label}: fetched=${r.total} upserted=${r.upserted} skipped=${r.skipped} errors=${r.errors}`);
      results.push({ ...r, label: loc.label });
    } catch (err) {
      console.error(`[mpwrSync] ${loc.label} failed: ${err.message}`);
      results.push({ label: loc.label, error: err.message });
    }
  }

  return results;
}
