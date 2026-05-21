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

async function fetchOrders(outfitterId, token) {
  // No filter cookie — the default view returns all active (upcoming) orders.
  // Custom filter cookies trigger a 202 redirect; the bare request returns 200.
  const res = await fetch(`${MPWR_BASE}/orders.data`, {
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

async function upsertOrder(order, activityId, db2) {
  const rawPhone = order.customerPhoneNumber;
  const phone    = rawPhone ? normalizePhone(rawPhone) : null;
  const name     = (
    order.customerName ??
    `${order.customerFirstName ?? ''} ${order.customerLastName ?? ''}`.trim()
  ) || null;

  if (!name) return 'skipped:no-name';

  // ── Step 1: upsert customer ─────────────────────────────────────────────────
  let customerId = null;

  if (phone) {
    await db2.from('customers').upsert(
      { name, normalized_phone: phone, company: 'coloradosledrentals' },
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
    } else {
      const { data: n } = await db2.from('customers')
        .insert({ name, company: 'coloradosledrentals' }).select('id').single();
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
  }, { onConflict: 'fareharbor_pk' });

  if (error) throw new Error(error.message);
  return 'upserted';
}

// ── Sync one outfitter location ───────────────────────────────────────────────

async function syncLocation(outfitterId, db2) {
  const token      = getToken();
  const orders     = await fetchOrders(outfitterId, token);
  const activityId = ACTIVITY_BY_OUTFITTER[outfitterId];

  if (!activityId) throw new Error(`No activity mapping for outfitter ${outfitterId}`);

  let upserted = 0, skipped = 0, errors = 0;

  for (const order of orders) {
    if (!order?.shortId) { skipped++; continue; }
    try {
      const r = await upsertOrder(order, activityId, db2);
      r === 'upserted' ? upserted++ : skipped++;
    } catch (err) {
      console.error(`[mpwrSync] ${order.shortId}: ${err.message}`);
      errors++;
    }
  }

  return { outfitterId, total: orders.length, upserted, skipped, errors };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runMpwrSync(db2) {
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
      const r = await syncLocation(loc.id, db2);
      console.log(`[mpwrSync] ${loc.label}: fetched=${r.total} upserted=${r.upserted} skipped=${r.skipped} errors=${r.errors}`);
      results.push({ ...r, label: loc.label });
    } catch (err) {
      console.error(`[mpwrSync] ${loc.label} failed: ${err.message}`);
      results.push({ label: loc.label, error: err.message });
    }
  }

  return results;
}
