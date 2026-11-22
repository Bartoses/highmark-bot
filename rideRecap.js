// ─────────────────────────────────────────────────────────────────────────────
// RIDE RECAP — the same-evening "thanks for riding" email for CSR + Rabbit Ears Adventures
// (sprint: docs/sprints/sprint-ride-recap.md)
//
// Once a day (recap_settings.send_hour, client timezone) the cron worker runs runDueRideRecaps():
//   1. finished FareHarbor bookings in DB2 `bookings` (status 'booked', end_at between the start of
//      [today − lookback_days] and now) whose item matches an active `recap_tours` row;
//   2. one email per guest per ride day (duplicate rows, several bookings in one order and
//      several orders the same day collapse into one), never to an address already in `recap_log`
//      or unsubscribed/suppressed anywhere (emailSuppression — the legacy "Unsubscribe" sheet was
//      imported there), bad/missing email → `recap_review`;
//   3. renders the branded HTML + plain text here (pure) and QUEUES it in `email_sends` as a
//      transport='gmail', category='recap' row. Delivery is the Apps Script `drainQueue` (every 10
//      min → /email/pull → GmailApp as info@ → /email/report). Nothing here sends anything.
//
// The bot can't read Google Drive, so the hero photo is left to the Apps Script: the HTML carries
// <!--PHOTO_SLOT--> and <!--PHOTO_ONLY-->…<!--/PHOTO_ONLY--> (print offer) markers and the row carries
// photo_hint (rideMedia.buildPhotoHint). See docs/apps-script/Code.gs hmSendOne_.
//
// Safety: recap_settings.dry_run (default TRUE) sends every recap to test_to with "[TEST]" in the
// subject; TEST_MODE=true writes nothing at all (plan only).
// ─────────────────────────────────────────────────────────────────────────────
import { buildPhotoHint } from "./rideMedia.js";
import { escapeHtml, buildUnsubscribeUrl } from "./emailTemplates.js";
import { loadSuppressionSets, normEmail, isEmailAddress, escapeLike } from "./emailSuppression.js";
import { resolveBaseUrl } from "./emailSender.js";

export const RECAP_TYPES = ["rea", "backcountry", "rental"];
export const RECAP_FEATURES = ["review", "share", "prints", "merch", "newsletter"];
export const RECAP_CATEGORY = "recap";

export const DEFAULT_RECAP_SETTINGS = Object.freeze({
  enabled: true, send_hour: 18, timezone: "America/Denver", dry_run: true, test_to: "sean@coloradosledrentals.com",
  features: [...RECAP_FEATURES], friend_code: "FRIEND10", friend_percent: 10, reward_code: null,
  weather_lat: null, weather_lon: null, weather_points: [], lookback_days: 1, last_run_on: null,
});

export const RECAP_LINKS = Object.freeze({
  // Sean, 2026-11-22: one Google review link for both brands.
  review: { csr: "https://g.page/r/CfQGQSBK_KsOEAg/review", rea: "https://g.page/r/CfQGQSBK_KsOEAg/review" },
  book: {
    rea: "https://fareharbor.com/embeds/book/rabbitearsadventures/?ref=followupemail&full-items=yes&flow=1491038",
    guided: "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes&flow=1262220",
    csr: "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes",
  },
  newsletter: "https://coloradosledrentals.com/newsletter-signup/",
  merch: "https://coloradosledrentals.com/",
  infoEmail: "info@coloradosledrentals.com",
});

export const RECAP_BRANDS = Object.freeze({
  rea: {
    key: "rea", name: "Rabbit Ears Adventures", dark: "#0E131B", dark2: "#161D27", btn: "#F99E16", btnTxt: "#0E131B", acc: "#00B4E6",
    soft: "#F2FAFD", muted: "#3F4A57", head: "'Bebas Neue',Impact,Arial,sans-serif", up: "uppercase", headBg: "#0E131B", logoH: 32,
    logo: "https://static.wixstatic.com/media/cd57db_5feb2c095c6d4ecabd4ef46c6868f8c9~mv2.png",
    footer: ["Rabbit Ears Adventures · 4492 Hwy 14, Walden, CO 80480", "A Colorado Sled Rentals company"],
  },
  csr: {
    key: "csr", name: "Colorado Sled Rentals", dark: "#06121F", dark2: "#0B2D4F", btn: "#1670C2", btnTxt: "#FFFFFF", acc: "#D9A24E",
    soft: "#F3F9FC", muted: "#41505F", head: "Roboto,Arial,sans-serif", up: "none", headBg: "#FFFFFF", logoH: 40,
    logo: "https://coloradosledrentals.com/wp-content/uploads/sites/5969/2022/11/logo-csr.png",
    footer: ["Colorado Sled Rentals · 2151 Downhill Drive, Steamboat Springs, CO 80487"],
  },
});
export const RECAP_PHONE = "(970) 439-1707";
export const RECAP_SOCIAL = "@coloradosledrentals";

const TYPE_RANK = { backcountry: 3, rea: 2, rental: 1 };
const COPY = {
  rea: {
    place: "tour", subject: "Your Rabbit Ears tour recap", nextTitle: "Come back for sunset",
    nextBody: "The 3-Hour Sunset Ride shows the mountains in a whole new light.", nextCta: "Book a sunset ride",
    hoursLabel: "on the snow",
  },
  backcountry: {
    place: "backcountry day", subject: "Your backcountry day, recapped", nextTitle: "Chase the next storm",
    nextBody: "Big storm days fill up first. Book your next backcountry day early.", nextCta: "Book your next ride",
    hoursLabel: "on the snow",
  },
  rental: {
    place: "rental", subject: "Thanks for riding with CSR", nextTitle: "Want a guide next time?",
    nextBody: "Ride the deep stuff with a local guide, or bring the family to Rabbit Ears Adventures.", nextCta: "See guided tours",
    hoursLabel: "on your sleds",
  },
};

// ── settings + tours ─────────────────────────────────────────────────────────
export function normalizeRecapSettings(row = {}) {
  const s = { ...DEFAULT_RECAP_SETTINGS, ...Object.fromEntries(Object.entries(row ?? {}).filter(([, v]) => v !== null && v !== undefined)) };
  const hour = Number(s.send_hour);
  s.send_hour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_RECAP_SETTINGS.send_hour;
  s.features = (Array.isArray(s.features) ? s.features : String(s.features).split(","))
    .map(f => String(f).trim().toLowerCase()).filter(f => RECAP_FEATURES.includes(f));
  s.dry_run = s.dry_run !== false;                                   // anything but an explicit false = dry run
  s.enabled = s.enabled !== false;
  s.friend_percent = Number(s.friend_percent) > 0 ? Number(s.friend_percent) : DEFAULT_RECAP_SETTINGS.friend_percent;
  s.friend_code = String(s.friend_code || DEFAULT_RECAP_SETTINGS.friend_code).trim();
  s.reward_code = row?.reward_code ? String(row.reward_code).trim() || null : null;
  s.test_to = normEmail(s.test_to) || DEFAULT_RECAP_SETTINGS.test_to;
  s.lookback_days = Math.max(0, Math.min(7, Number.isFinite(Number(s.lookback_days)) ? Math.floor(Number(s.lookback_days)) : 1));
  const lat = Number(row?.weather_lat), lon = Number(row?.weather_lon);
  s.weather_lat = row?.weather_lat != null && Number.isFinite(lat) ? lat : null;
  s.weather_lon = row?.weather_lon != null && Number.isFinite(lon) ? lon : null;
  s.weather_points = (Array.isArray(row?.weather_points) ? row.weather_points : [])
    .map(p => ({ name: p?.name ? String(p.name) : null, type: p?.type ? String(p.type) : null, match: p?.match ? String(p.match) : null, lat: Number(p?.lat), lon: Number(p?.lon) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return s;
}

// First active row whose `match` appears in the item name (case-insensitive). Higher `priority` wins, then the longer
// (more specific) match. type 'skip' = never emailed (e.g. RZR, which also contains "Polaris"). No match = no email.
export function matchTour(itemName, tours) {
  const name = String(itemName ?? "").toLowerCase();
  if (!name) return null;
  const hits = (tours ?? []).filter(t => t && t.active !== false && t.match && name.includes(String(t.match).toLowerCase()))
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(b.match).length - String(a.match).length);
  const t = hits[0];
  if (!t || !RECAP_TYPES.includes(t.type)) return null;
  return { ...t, label: String(t.label || t.match).trim(), stops: Array.isArray(t.stops) ? t.stops.filter(x => String(x ?? "").trim()) : [] };
}

// ── time (client timezone) ───────────────────────────────────────────────────
function zonedParts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
export const localDate = (date, tz = "America/Denver") => { const p = zonedParts(date, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
export const localHour = (date, tz = "America/Denver") => zonedParts(date, tz).h;

// The UTC instant of local midnight on `ymd` (DST-safe).
export function zonedMidnight(ymd, tz = "America/Denver") {
  const [y, m, d] = ymd.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess = Date.UTC(y, m - 1, d) - (asUtc - guess);
  }
  return new Date(guess);
}
export function addDays(ymd, n) { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// Due = the local clock has reached send_hour and the job hasn't run on this local date yet. Re-read every tick, so editing
// send_hour in the table reschedules the job without a deploy.
export function isRecapDue(settingsRow, now = new Date()) {
  const s = normalizeRecapSettings(settingsRow);
  if (!s.enabled) return false;
  return localHour(now, s.timezone) >= s.send_hour && String(s.last_run_on ?? "") !== localDate(now, s.timezone);
}

export function recapWindow(settings, now = new Date()) {
  const s = normalizeRecapSettings(settings);
  return { from: zonedMidnight(addDays(localDate(now, s.timezone), -s.lookback_days), s.timezone), to: new Date(now) };
}

// Winter season label for "one reward per guest per season": Jul–Jun, e.g. 2026-11-22 → "2026-27".
export function recapSeason(date, tz = "America/Denver") {
  const [y, m] = localDate(date, tz).split("-").map(Number);
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// ── booking facts (DB2 bookings row, FareHarbor raw_payload) ─────────────────
// Column map confirmed against DB2 on 2026-11-22: item/contact/order/ref/promo/opt-in only exist inside raw_payload
// (webhook shape {booking:{…}} or the older unwrapped bulk-load shape). guide_name is a real column (empty so far).
export function bookingFacts(row) {
  const b = row?.raw_payload?.booking ?? row?.raw_payload ?? {};
  const pk = String(row?.fareharbor_pk ?? (b.pk != null ? `#${b.pk}` : ""));
  const promo = (b.custom_field_values ?? []).find(f => /promo code/i.test(f?.name ?? f?.custom_field?.name ?? ""));
  return {
    pk, bookingId: pk.replace(/^#/, ""),
    company: row?.company ?? b.company?.shortname ?? null,
    item: b.availability?.item?.name ?? row?.product_title ?? null,
    startAt: row?.start_at ?? b.availability?.start_at ?? null,
    endAt: row?.end_at ?? b.availability?.end_at ?? null,
    status: row?.status ?? b.status ?? null,
    name: String(b.contact?.name ?? "").trim(),
    email: normEmail(b.contact?.email),
    phone: b.contact?.normalized_phone ?? b.contact?.phone ?? null,
    pax: Number(row?.customer_count ?? b.customer_count) || 0,
    guide: String(row?.guide_name ?? "").trim(),
    ref: String(b.online_booking_references ?? "").trim() || null,
    promoCode: String(promo?.display_value ?? promo?.value ?? "").trim() || null,
    emailOptIn: b.contact?.is_subscribed_for_email_updates === true,
    orderId: b.order?.display_id ?? null,
    rebookedFrom: b.rebooked_from ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

const JUNK_NAMES = new Set(["guest", "customer", "test", "none", "unknown", "na", "n/a", "mr", "mrs", "ms", "dr", "rider", "walk", "walkin", "x"]);
export function cleanFirstName(name) {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z][A-Za-z'\-]{1,20}$/.test(first) || JUNK_NAMES.has(first.toLowerCase())) return "";
  if (/^[A-Z]\.?$/.test(first)) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function hoursLabel(startAt, endAt) {
  if (!startAt || !endAt) return "";
  const h = (new Date(endAt) - new Date(startAt)) / 36e5;
  if (!(h > 0) || !Number.isFinite(h)) return "";
  if (h >= 7) return "Full day";
  const r = Math.round(h * 2) / 2 || 0.5;
  return `${r} ${r === 1 ? "hr" : "hrs"}`;
}

// ── eligibility (pure) ───────────────────────────────────────────────────────
// bookings: DB2 rows. logged: Set of fareharbor_pk already in recap_log. suppressed: Set of addresses never to email.
// → { recaps:[{ key, email, tour, primary, bookings, pax }], review:[{ booking_id, email, reason }], skipped:[{ booking_id, reason }] }
export function planRecaps({ bookings, tours, logged = new Set(), suppressed = new Set(), now = new Date(), tz = "America/Denver" }) {
  const byPk = new Map();
  for (const row of bookings ?? []) {
    const f = bookingFacts(row);
    if (!f.pk.startsWith("#")) continue;                              // MPWR/Polaris rows (RZR) — not FareHarbor, no recap
    const prev = byPk.get(f.pk);
    if (!prev || String(f.updatedAt ?? "") > String(prev.updatedAt ?? "")) byPk.set(f.pk, f);   // duplicate rows → one booking
  }
  const review = [], skipped = [], groups = new Map();
  const nowMs = new Date(now).getTime();
  for (const f of byPk.values()) {
    // 'rebooked' = the old half of a FareHarbor rebooking (the new booking carries rebooked_from and status 'booked').
    if (f.status !== "booked") { skipped.push({ booking_id: f.pk, reason: f.status || "no_status" }); continue; }
    const tour = matchTour(f.item, tours);
    if (!tour) { skipped.push({ booking_id: f.pk, reason: "not_a_recap_item" }); continue; }
    if (!f.endAt || new Date(f.endAt).getTime() > nowMs) { skipped.push({ booking_id: f.pk, reason: "not_finished" }); continue; }
    if (logged.has(f.pk)) { skipped.push({ booking_id: f.pk, reason: "already_sent" }); continue; }
    if (!f.email) { review.push({ booking_id: f.pk, email: null, reason: "no_email" }); continue; }
    if (!isEmailAddress(f.email)) { review.push({ booking_id: f.pk, email: f.email, reason: "invalid_email" }); continue; }
    if (suppressed.has(f.email)) { skipped.push({ booking_id: f.pk, reason: "unsubscribed" }); continue; }
    const key = `${f.email}|${localDate(f.startAt ?? f.endAt, tz)}`;   // one recap per guest per ride day
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ f, tour });
  }
  const recaps = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => (TYPE_RANK[b.tour.type] - TYPE_RANK[a.tour.type]) || String(a.f.startAt).localeCompare(String(b.f.startAt)) || a.f.pk.localeCompare(b.f.pk));
    const { f: primary, tour } = list[0];
    const pax = list.filter(x => x.tour.type === tour.type).reduce((n, x) => n + (x.f.pax || 0), 0);
    recaps.push({ key, email: primary.email, tour, primary, bookings: list.map(x => x.f), pax });
  }
  recaps.sort((a, b) => a.primary.pk.localeCompare(b.primary.pk));
  return { recaps, review, skipped };
}

// ── trip details: ONE input for everything ride-specific ─────────────────────
// Today: recap_tours + the booking. Next sprint: a Guide Ride Log row (rideLog) overrides any field without touching the template.
// photo: null = unknown (the Apps Script looks in Drive), false = known none (no slot, no print offer), "<drive file id>" = that photo.
export function buildTripDetails({ booking, tour, rideLog = null }) {
  const base = {
    guide: booking?.guide || "", stops: tour?.stops ?? [], miles: tour?.miles ?? null, high_point_ft: tour?.high_point_ft ?? null,
    highlight: null, photo: null,
  };
  if (!rideLog) return base;
  const out = { ...base };
  for (const k of Object.keys(base)) if (rideLog[k] !== undefined && rideLog[k] !== null && rideLog[k] !== "") out[k] = rideLog[k];
  return out;
}

// ── weather (Open-Meteo, free, no key) ───────────────────────────────────────
export function weatherLabels(daily) {
  const code = Number(daily?.weathercode?.[0] ?? daily?.weather_code?.[0]);
  const hi = Number(daily?.temperature_2m_max?.[0]);
  const snow = Number(daily?.snowfall_sum?.[0]);
  if (!Number.isFinite(code) || !Number.isFinite(hi)) return null;
  const sky = code === 0 ? "Bluebird" : code <= 3 ? "Partly cloudy" : (code >= 71 && code <= 86) ? "Snowing" : "Cloudy";
  const out = [];
  if (Number.isFinite(snow) && snow > 0) out.push(["SNOW", `${Math.max(1, Math.round(snow))} in`]);
  out.push(["HIGH", `${Math.round(hi)}°F`]);
  out.push(["SKY", sky]);
  return out;
}

// Where to take the weather for a ride: the first recap_settings.weather_points entry whose `type` (if set) equals the recap
// type and whose `match` (if set) appears in the item name — e.g. REA ranch for tours, Columbine for backcountry, the
// Kremmling shop for "… • Kremmling" rentals, the Steamboat shop for other rentals. Else weather_lat/weather_lon. Else none.
export function weatherPointFor({ item, type }, settings) {
  const s = normalizeRecapSettings(settings);
  const name = String(item ?? "").toLowerCase();
  const hit = s.weather_points.find(p => (!p.type || p.type === type) && (!p.match || name.includes(p.match.toLowerCase())));
  if (hit) return { lat: hit.lat, lon: hit.lon, name: hit.name };
  return s.weather_lat != null && s.weather_lon != null ? { lat: s.weather_lat, lon: s.weather_lon, name: null } : null;
}

export async function fetchRecapWeather({ lat, lon, date, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (lat == null || lon == null || !date || !fetchImpl) return null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=snowfall_sum,temperature_2m_max,weathercode` +
      `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America%2FDenver&start_date=${date}&end_date=${date}`;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetchImpl(u, ctl ? { signal: ctl.signal } : undefined).finally(() => t && clearTimeout(t));
    if (!res?.ok) return null;
    return weatherLabels((await res.json())?.daily);
  } catch { return null; }                                            // never block a send on weather
}

// ── links ────────────────────────────────────────────────────────────────────
// Every http(s) link: utm_source=ride_recap&utm_medium=email&utm_campaign=<type>&utm_content=<button>.
// friendRef: replaces FareHarbor's ref=followupemail with ref=friend-<booking id> (the shared referral link).
export function trackLink(base, { type, content, friendRef = null }) {
  const u = new URL(base);
  if (friendRef) u.searchParams.set("ref", `friend-${friendRef}`);
  u.searchParams.set("utm_source", "ride_recap");
  u.searchParams.set("utm_medium", "email");
  u.searchParams.set("utm_campaign", type);
  u.searchParams.set("utm_content", content);
  return u.toString();
}
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const thousands = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ── recap data (pure) ────────────────────────────────────────────────────────
// booking: bookingFacts(). trip: buildTripDetails(). settings: normalizeRecapSettings(). weather: weatherLabels() | null.
export function buildRecapData({ booking, tour, trip, settings, weather = null, pax = null, unsubscribeUrl = null }) {
  const s = normalizeRecapSettings(settings);
  const type = tour.type;
  const brand = RECAP_BRANDS[type === "rea" ? "rea" : "csr"];
  const copy = COPY[type];
  const first = cleanFirstName(booking.name);
  const guide = String(trip?.guide ?? "").trim();
  const start = booking.startAt ?? booking.endAt;
  const ymd = start ? localDate(start, s.timezone) : null;
  const [yy, mm, dd] = ymd ? ymd.split("-").map(Number) : [];
  const dow = ymd ? DOW[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()] : "";
  const kicker = [ymd ? `${dow} · ${MON[mm - 1]} ${dd}` : "", tour.label.toUpperCase()].filter(Boolean).join(" · ");
  const riders = Number(pax ?? booking.pax) || 0;

  const stats = [];
  if (Number(trip?.miles) > 0) stats.push([`${Number(trip.miles)} mi`, `on the ${tour.label}`]);
  if (Number(trip?.high_point_ft) > 0) stats.push([`${thousands(trip.high_point_ft)} ft`, "highest point"]);
  const hrs = hoursLabel(booking.startAt, booking.endAt);
  if (hrs) stats.push([hrs, copy.hoursLabel]);
  if (riders > 0) stats.push([String(riders), riders === 1 ? "rider" : "riders in your group"]);

  const withGuide = guide ? ` with guide ${guide}` : "";
  const h1 = {
    rea: first ? `${first}, that’s a memory in the making.` : "Thanks for riding with us.",
    backcountry: first ? `${first}, you went deep into the backcountry.` : "Thanks for riding with us.",
    rental: first ? `${first}, thanks for riding with CSR.` : "Thanks for riding with us.",
  }[type];
  const sub = {
    rea: `Your ${tour.label} through North Routt’s meadows and forest trails${withGuide}.`,
    backcountry: `A day off the groomers${withGuide}.`,
    rental: "Brand-new Polaris sleds and a day on your own terms.",
  }[type];
  const dateShort = ymd ? `${String(mm).padStart(2, "0")}.${String(dd).padStart(2, "0")}.${String(yy).slice(2)}` : "";
  return {
    type, brand, copy, first, guide, kicker, h1, sub, stats: stats.slice(0, 4),
    stops: type === "rea" ? (trip?.stops ?? []).map(x => String(x).trim()).filter(Boolean) : [],
    highlight: String(trip?.highlight ?? "").trim(),
    weather: Array.isArray(weather) && weather.length ? weather : null,
    photo: trip?.photo === false ? false : (trip?.photo || null),
    features: s.features, friendCode: s.friend_code, friendPercent: s.friend_percent,
    bookingId: booking.bookingId, label: tour.label,
    merchLine: [tour.label, dateShort, Number(trip?.miles) > 0 ? `${Number(trip.miles)} mi` : ""].filter(Boolean).join(" · "),
    reviewUrl: RECAP_LINKS.review[brand.key],
    nextUrl: type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.guided,
    shareUrl: type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.csr,
    unsubscribeUrl,
    subject: copy.subject + (first ? `, ${first}` : ""),
  };
}

// ── HTML (table-based, inline styles, no flex/grid, max-width 600) ───────────
export function renderRideRecap(d) {
  const C = d.brand, rea = C.key === "rea", type = d.type, e = escapeHtml;
  const has = (f) => d.features.includes(f);
  const link = (base, content, friend = false) => trackLink(base, { type, content, friendRef: friend ? d.bookingId : null });
  const btn = (text, href, primary = true) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-radius:12px;background:${primary ? C.btn : "#FFFFFF"};${primary ? "" : `border:2px solid ${C.dark2};`}">` +
    `<a href="${attr(href)}" style="display:block;padding:15px 18px;font:700 16px/20px Arial,Helvetica,sans-serif;color:${primary ? C.btnTxt : C.dark2};text-decoration:none">${text}</a></td></tr></table>`;
  const h2 = (t, color = C.dark2) => `<div style="font:${rea ? "400 28px" : "700 24px"}/1.1 ${C.head};text-transform:${C.up};color:${color};margin:0 0 10px">${t}</div>`;
  const p = (t, color = C.muted) => `<div style="font:16px/1.5 Arial,Helvetica,sans-serif;color:${color};margin:0 0 14px">${t}</div>`;
  const block = (inner) => `<tr><td style="padding:24px 20px 0">${inner}</td></tr>`;
  const card = (inner, bg = "#FFFFFF", border = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px;border-radius:16px;background:${bg};${border ? `border:${border};` : ""}">${inner}</td></tr></table>`;

  let rows = "";
  // header logo
  rows += `<tr><td style="background:${C.headBg};padding:14px 20px;border-bottom:1px solid #DFE9F0"><img src="${attr(C.logo)}" height="${C.logoH}" alt="${e(C.name)}" style="display:block;border:0;height:${C.logoH}px;width:auto"></td></tr>`;
  // hero: kicker, headline, subline, photo slot (filled by the Apps Script from Drive, or removed)
  rows += `<tr><td style="background:${C.dark};padding:28px 20px 24px;color:#FFFFFF">` +
    `<div style="font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc}">${e(d.kicker)}</div>` +
    `<div style="font:${rea ? "400 44px" : "700 30px"}/1.05 ${C.head};text-transform:${C.up};margin:10px 0;color:#FFFFFF">${e(d.h1)}</div>` +
    `<div style="font:16px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3">${e(d.sub)}</div>` +
    (d.highlight ? `<div style="font:italic 15px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3;margin-top:10px">“${e(d.highlight)}”</div>` : "") +
    (d.photo === false ? "" : "<!--PHOTO_SLOT-->") +
    `</td></tr>`;
  // stats 2×2
  if (d.stats.length) {
    let s = "";
    for (let i = 0; i < d.stats.length; i += 2) {
      s += "<tr>" + [d.stats[i], d.stats[i + 1]].map(x => x
        ? `<td width="50%" valign="top" style="padding:5px"><div style="background:${C.soft};border:1px solid #DFE9F0;border-radius:12px;padding:14px 16px"><div style="font:${rea ? "400 30px" : "700 26px"}/1 ${C.head};color:${C.dark2}">${e(x[0])}</div><div style="font:13px/1.3 Arial,Helvetica,sans-serif;color:${C.muted};margin-top:4px">${e(x[1])}</div></div></td>`
        : `<td width="50%" style="padding:5px"></td>`).join("") + "</tr>";
    }
    rows += `<tr><td style="padding:18px 15px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${s}</table></td></tr>`;
  }
  // stops (REA)
  if (d.stops.length) {
    rows += block(`<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.muted};margin-bottom:8px">STOPS ON YOUR LOOP</div>` +
      d.stops.map((s, i) => `<div style="font:16px/1.6 Arial,Helvetica,sans-serif;color:${C.dark2}"><b>${i + 1}.</b> ${e(s)}</div>`).join(""));
  }
  // weather labels
  if (d.weather) {
    rows += `<tr><td style="padding:12px 20px 0;font:14px Arial,Helvetica,sans-serif;color:${C.muted}">` +
      d.weather.map(w => `<span style="display:inline-block;background:${C.dark2};color:#FFFFFF;border-radius:999px;padding:7px 12px;margin:0 6px 6px 0"><span style="font-size:11px;color:#9FB3C8;font-weight:700">${e(w[0])}</span> <b>${e(w[1])}</b></span>`).join("") +
      `</td></tr>`;
  }
  // review — EVERY guest sees both the review button and "tell us directly" (no review gating)
  if (has("review")) {
    const feedback = `mailto:${RECAP_LINKS.infoEmail}?subject=${encodeURIComponent(`Feedback on my ride (#${d.bookingId})`)}`;
    rows += block(card(`<div style="font-size:20px;color:#F5B301;letter-spacing:2px;margin-bottom:8px">★★★★★</div>` + h2(`How was your ${e(d.copy.place)}?`) +
      p("If you had a great time, a quick Google review helps our small local team more than anything. It takes about a minute.") +
      btn("Leave a Google review", link(d.reviewUrl, "google-review")) +
      `<div style="text-align:center;padding:12px 0 0"><a href="${attr(feedback)}" style="font:700 15px Arial,Helvetica,sans-serif;color:#1670C2">Something not right? Tell us directly</a></div>`,
    "#FFFFFF", `2px solid ${C.dark2}`));
  }
  // share / referral
  if (has("share")) {
    const pct = d.friendPercent, code = e(d.friendCode);
    const smsBody = `You have to try ${C.name}! Use code ${d.friendCode} for ${pct}% off: ${link(d.shareUrl, "share-sms", true)}`;
    const mailSubj = `${pct}% off ${C.name}`;
    const mailBody = `I just rode with ${C.name} and loved it. Use code ${d.friendCode} at checkout for ${pct}% off: ${link(d.shareUrl, "share-email", true)}`;
    rows += block(card(`<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc};margin-bottom:8px">GIVE ${pct}%, GET ${pct}%</div>` +
      h2("Bring a friend next time", "#FFFFFF") +
      p(`Friends save ${pct}% with this code at checkout. When they ride, you get ${pct}% off your next booking.`, "#C9D6E3") +
      `<div style="border:2px dashed ${C.acc};border-radius:12px;text-align:center;font:700 24px 'Courier New',Courier,monospace;letter-spacing:3px;color:#FFFFFF;padding:12px 0;margin-bottom:14px">${code}</div>` +
      btn("Text it to a friend", `sms:?&body=${encodeURIComponent(smsBody)}`) +
      `<div style="height:10px;line-height:10px;font-size:10px">&nbsp;</div>` +
      btn("Email it to a friend", `mailto:?subject=${encodeURIComponent(mailSubj)}&body=${encodeURIComponent(mailBody)}`, false),
    C.dark));
  }
  // take it home: prints only when the Apps Script finds a photo; merch if enabled
  if (has("prints") && d.photo !== false) {
    rows += "<!--PHOTO_ONLY-->" + block(h2("Keep the moment") +
      p("Your framed tour photo is 2 for $25. The digital copy is in this email — save it to your phone.") +
      btn("Order more prints", link(RECAP_LINKS.book.csr, "order-prints"), false)) + "<!--/PHOTO_ONLY-->";
  }
  if (has("merch")) {
    rows += block(h2("Wear the memory") + p(`A hoodie printed with ${e(d.merchLine)}. Made to order.`) +
      btn("Shop hoodies, hats &amp; stickers", link(RECAP_LINKS.merch, "merch"), false));
  }
  // next ride
  rows += block(card(h2(e(d.copy.nextTitle)) + p(e(d.copy.nextBody)) + btn(e(d.copy.nextCta), link(d.nextUrl, "book-next")), C.soft, "1px solid #DFE9F0"));
  // newsletter
  if (has("newsletter")) {
    rows += block(`<div style="font:700 17px Arial,Helvetica,sans-serif;color:${C.dark2};margin-bottom:6px">Get first dibs on powder days</div>` +
      p("Storm alerts, new adventures and seasonal deals.") + btn("Join the newsletter", link(RECAP_LINKS.newsletter, "newsletter"), false));
  }
  // footer — CAN-SPAM: physical address + a working unsubscribe link
  const unsub = d.unsubscribeUrl || `mailto:${RECAP_LINKS.infoEmail}?subject=Unsubscribe`;
  rows += `<tr><td style="padding:28px 20px;font:13px/1.6 Arial,Helvetica,sans-serif;color:${C.muted};text-align:center">` +
    C.footer.map(e).join("<br>") + `<br>${RECAP_PHONE} · ${RECAP_SOCIAL}<br>` +
    `<a href="${attr(unsub)}" data-notrack style="color:#1670C2">Unsubscribe</a></td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${e(d.subject)}</title>` +
    `<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&amp;family=Roboto:wght@400;700&amp;display=swap" rel="stylesheet"></head>` +
    `<body style="margin:0;padding:0;background:#EEF2F5"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF2F5"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF">${rows}</table></td></tr></table></body></html>`;

  return { subject: d.subject, html, text: renderRideRecapText(d), fromName: C.name, brand: C.key, type };
}

export function renderRideRecapText(d) {
  const C = d.brand, has = (f) => d.features.includes(f), link = (b, c, f = false) => trackLink(b, { type: d.type, content: c, friendRef: f ? d.bookingId : null });
  const out = [d.kicker, "", d.h1, d.sub];
  if (d.highlight) out.push(`“${d.highlight}”`);
  if (d.stats.length) out.push("", d.stats.map(s => `${s[0]} ${s[1]}`).join(" · "));
  if (d.stops.length) out.push("", "Stops on your loop:", ...d.stops.map((s, i) => `${i + 1}. ${s}`));
  if (d.weather) out.push("", d.weather.map(w => `${w[0]} ${w[1]}`).join(" · "));
  if (has("review")) out.push("", `How was your ${d.copy.place}? Leave us a Google review: ${link(d.reviewUrl, "google-review")}`,
    `Something not right? Tell us directly: ${RECAP_LINKS.infoEmail}`);
  if (has("share")) out.push("", `Give ${d.friendPercent}%, get ${d.friendPercent}%: friends save ${d.friendPercent}% with code ${d.friendCode}: ${link(d.shareUrl, "share-email", true)}`);
  if (has("merch")) out.push("", `Wear the memory — a hoodie printed with ${d.merchLine}: ${link(RECAP_LINKS.merch, "merch")}`);
  out.push("", `${d.copy.nextTitle}. ${d.copy.nextBody} ${link(d.nextUrl, "book-next")}`);
  if (has("newsletter")) out.push("", `Get first dibs on powder days: ${link(RECAP_LINKS.newsletter, "newsletter")}`);
  out.push("", "—", ...C.footer, `${RECAP_PHONE} · ${RECAP_SOCIAL}`, `Unsubscribe: ${d.unsubscribeUrl || `email ${RECAP_LINKS.infoEmail} with the subject "Unsubscribe"`}`);
  return out.join("\n");
}

// What the Apps Script (Code.gs hmSendOne_) does to the markers — for previews/snapshots and tests.
export function applyPhotoMarkers(html, photoFound) {
  let h = String(html);
  if (photoFound) {
    h = h.replace("<!--PHOTO_SLOT-->", '<img src="cid:ridephoto" width="560" alt="Photo from your ride" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:12px;margin-top:16px">');
    h = h.replace(/<!--\/?PHOTO_ONLY-->/g, "");
  } else {
    h = h.replace(/<!--PHOTO_ONLY-->[\s\S]*?<!--\/PHOTO_ONLY-->/g, "");
  }
  return h.replace(/<!--PHOTO_SLOT-->/g, "");
}

// ── referral reward (phase 2 — built, OFF until recap_settings.reward_code is set) ──
// FareHarbor stores a booking's ?ref= in raw_payload.booking.online_booking_references.
export function parseFriendRef(ref) {
  const m = String(ref ?? "").trim().match(/^friend-#?(\d+)$/i);
  return m ? m[1] : null;
}

export function planReferralRewards({ friendBookings, referrers, existing = [], suppressed = new Set(), settings, now = new Date() }) {
  const s = normalizeRecapSettings(settings);
  if (!s.reward_code) return { rewards: [], skipped: [{ reason: "no_reward_code" }] };
  const season = recapSeason(now, s.timezone);
  const doneFriends = new Set(existing.map(r => r.friend_booking_id));
  const doneReferrers = new Set(existing.filter(r => r.season === season).map(r => normEmail(r.referrer_email)));
  const rewards = [], skipped = [];
  for (const row of friendBookings ?? []) {
    const f = bookingFacts(row);
    const refId = parseFriendRef(f.ref);
    if (!refId) continue;
    if (f.status !== "booked") { skipped.push({ friend: f.pk, reason: f.status }); continue; }
    if (doneFriends.has(f.pk)) { skipped.push({ friend: f.pk, reason: "already_rewarded" }); continue; }
    const refRow = referrers.get(`#${refId}`);
    if (!refRow) { skipped.push({ friend: f.pk, reason: "referrer_not_found" }); continue; }
    const r = bookingFacts(refRow);
    if (!isEmailAddress(r.email)) { skipped.push({ friend: f.pk, reason: "referrer_no_email" }); continue; }
    if (r.email === f.email) { skipped.push({ friend: f.pk, reason: "self_referral" }); continue; }
    if (suppressed.has(r.email)) { skipped.push({ friend: f.pk, reason: "unsubscribed" }); continue; }
    if (doneReferrers.has(r.email)) { skipped.push({ friend: f.pk, reason: "already_rewarded_this_season" }); continue; }
    doneReferrers.add(r.email); doneFriends.add(f.pk);
    rewards.push({ season, referrer: r, friend: f });
  }
  return { rewards, skipped, season };
}

export function renderReferralReward({ referrer, settings, unsubscribeUrl = null }) {
  const s = normalizeRecapSettings(settings);
  const C = RECAP_BRANDS[referrer.company === "rabbitearsadventures" ? "rea" : "csr"];
  const first = cleanFirstName(referrer.name), e = escapeHtml;
  const book = trackLink(C.key === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.csr, { type: "referral_reward", content: "book-reward" });
  const unsub = unsubscribeUrl || `mailto:${RECAP_LINKS.infoEmail}?subject=Unsubscribe`;
  const subject = `Your friend booked! Here's ${s.friend_percent}% off your next ride`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#EEF2F5"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF">` +
    `<tr><td style="background:${C.dark};padding:28px 20px;color:#FFFFFF;font:700 26px/1.2 ${C.head};text-transform:${C.up}">${e(first ? `${first}, your friend booked!` : "Your friend booked!")}</td></tr>` +
    `<tr><td style="padding:24px 20px;font:16px/1.5 Arial,Helvetica,sans-serif;color:${C.muted}">Thanks for sharing ${e(C.name)}. Here's ${s.friend_percent}% off your next ride — use this code at checkout:` +
    `<div style="border:2px dashed ${C.acc};border-radius:12px;text-align:center;font:700 24px 'Courier New',Courier,monospace;letter-spacing:3px;color:${C.dark2};padding:12px 0;margin:16px 0">${e(s.reward_code)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-radius:12px;background:${C.btn}"><a href="${attr(book)}" style="display:block;padding:15px 18px;font:700 16px/20px Arial,Helvetica,sans-serif;color:${C.btnTxt};text-decoration:none">Book your next ride</a></td></tr></table></td></tr>` +
    `<tr><td style="padding:28px 20px;font:13px/1.6 Arial,Helvetica,sans-serif;color:${C.muted};text-align:center">${C.footer.map(e).join("<br>")}<br>${RECAP_PHONE} · ${RECAP_SOCIAL}<br>` +
    `<a href="${attr(unsub)}" data-notrack style="color:#1670C2">Unsubscribe</a></td></tr></table></td></tr></table></body></html>`;
  const text = `${first ? `${first}, your friend booked!` : "Your friend booked!"}\n\nThanks for sharing ${C.name}. Here's ${s.friend_percent}% off your next ride with code ${s.reward_code}: ${book}\n\n—\n${C.footer.join("\n")}\n${RECAP_PHONE}\nUnsubscribe: ${unsubscribeUrl || RECAP_LINKS.infoEmail}`;
  return { subject, html, text, fromName: C.name };
}

// ── I/O ──────────────────────────────────────────────────────────────────────
const isTestMode = () => process.env.TEST_MODE === "true";

export async function loadRecapSettings(crm, clientId) {
  const { data, error } = await crm.from("recap_settings").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw new Error(`recap_settings read failed: ${error.message}`);
  return data ? normalizeRecapSettings(data) : null;
}

export async function loadRecapTours(crm, clientId) {
  const { data, error } = await crm.from("recap_tours").select("*").eq("client_id", clientId);
  if (error) throw new Error(`recap_tours read failed: ${error.message}`);
  return (data ?? []).filter(t => t.active !== false);
}

async function unsubscribeUrlFor(crm, email, baseUrl) {
  try {
    const { data } = await crm.from("contacts").select("email_unsubscribe_token").ilike("email", escapeLike(email)).limit(5);
    const tok = (data ?? []).map(c => c.email_unsubscribe_token).find(Boolean);
    return tok ? buildUnsubscribeUrl(baseUrl, tok) : null;           // null → the footer falls back to a mailto unsubscribe
  } catch { return null; }
}

// Queue one recap/reward row for the Apps Script. Idempotent on idempotencyKey (a retry never double-emails).
// One INSERT with every field, so the Apps Script drain can never pull a half-built row.
export async function queueRecapEmail(crm, { clientId, to, subject, html, text, fromName, photoHint = null, reference, idempotencyKey, dryRun }) {
  const row = {
    campaign_id: null, client_id: clientId, contact_id: null, email: normEmail(to), category: RECAP_CATEGORY, status: "queued", transport: "gmail",
    subject: (dryRun ? "[TEST] " : "") + subject, body_html: html, body_text: text, from_name: fromName, photo_hint: photoHint,
    reference: reference ?? null, idempotency_key: idempotencyKey,
  };
  const { data, error } = await crm.from("email_sends").insert(row).select("id").single();
  if (!error && data) return { row: data, duplicate: false };
  const { data: existing } = await crm.from("email_sends").select("id, status").eq("idempotency_key", idempotencyKey).limit(1).maybeSingle();
  if (existing) return { row: existing, duplicate: true };
  throw new Error(`recap enqueue failed (is db2_ride_recap.sql applied?): ${error?.message}`);
}

// One day's recaps for a client. TEST_MODE → plan only, nothing written.
export async function runRideRecap(crm, {
  clientId = "csr_rea", now = new Date(), settings = null, tours = null, baseUrl = resolveBaseUrl(),
  fetchImpl = globalThis.fetch, preview = false,
} = {}) {
  const out = { clientId, queued: 0, review: 0, skipped: 0, dryRun: true, preview: preview || isTestMode(), recaps: [] };
  const s = settings ? normalizeRecapSettings(settings) : await loadRecapSettings(crm, clientId);
  if (!s) return { ...out, blocked: "no_settings" };
  out.dryRun = s.dry_run;
  const t = tours ?? await loadRecapTours(crm, clientId);
  const win = recapWindow(s, now);
  out.window = { from: win.from.toISOString(), to: win.to.toISOString() };

  const { data: rows, error } = await crm.from("bookings")
    .select("fareharbor_pk, company, status, start_at, end_at, customer_count, guide_name, product_title, updated_at, raw_payload")
    .like("fareharbor_pk", "#%").gte("end_at", win.from.toISOString()).lte("end_at", win.to.toISOString());
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const pks = [...new Set((rows ?? []).map(r => r.fareharbor_pk))];
  const logged = new Set();
  for (let i = 0; i < pks.length; i += 100) {
    const { data, error: le } = await crm.from("recap_log").select("booking_id").in("booking_id", pks.slice(i, i + 100));
    if (le) throw new Error(`recap_log read failed: ${le.message}`);
    for (const r of data ?? []) logged.add(r.booking_id);
  }
  const sup = await loadSuppressionSets(crm);                           // unsubscribed OR bounced/complained, any contact row
  const plan = planRecaps({ bookings: rows, tours: t, logged, suppressed: sup.all, now, tz: s.timezone });
  out.skipped = plan.skipped.length; out.review = plan.review.length;

  const weatherByDate = new Map();
  for (const rc of plan.recaps) {
    const date = localDate(rc.primary.startAt ?? rc.primary.endAt, s.timezone);
    const pt = weatherPointFor({ item: rc.primary.item, type: rc.tour.type }, s);
    const wKey = pt ? `${date}|${pt.lat}|${pt.lon}` : null;
    if (wKey && !weatherByDate.has(wKey)) weatherByDate.set(wKey, await fetchRecapWeather({ lat: pt.lat, lon: pt.lon, date, fetchImpl }));
    const weather = wKey ? weatherByDate.get(wKey) : null;
    const unsubscribeUrl = out.preview ? null : await unsubscribeUrlFor(crm, rc.email, baseUrl);
    const trip = buildTripDetails({ booking: rc.primary, tour: rc.tour });
    const data = buildRecapData({ booking: rc.primary, tour: rc.tour, trip, settings: s, weather, pax: rc.pax, unsubscribeUrl });
    const msg = renderRideRecap(data);
    const photoHint = data.photo === false ? null : buildPhotoHint({ label: rc.tour.label, startAt: rc.primary.startAt ?? rc.primary.endAt, fileId: typeof data.photo === "string" ? data.photo : null });
    const to = s.dry_run ? s.test_to : rc.email;
    const summary = { booking_id: rc.primary.pk, bookings: rc.bookings.map(b => b.pk), email: rc.email, to, type: rc.tour.type, subject: (s.dry_run ? "[TEST] " : "") + msg.subject, photo_hint: photoHint, weather: !!weather };
    out.recaps.push(summary);
    if (out.preview) continue;

    // queue first (idempotent), then log — a crash between the two re-runs into the idempotency key, never a 2nd email
    const q = await queueRecapEmail(crm, { clientId, to, subject: msg.subject, html: msg.html, text: msg.text, fromName: msg.fromName, photoHint,
      reference: rc.primary.pk, idempotencyKey: `recap-${rc.primary.pk}`, dryRun: s.dry_run });
    const logRows = rc.bookings.map(b => ({
      booking_id: b.pk, client_id: clientId, email: rc.email, sent_to: to, type: rc.tour.type, send_id: q.row.id,
      primary_booking_id: rc.primary.pk, dry_run: s.dry_run, weather: !!weather, queued_at: new Date(now).toISOString(),
    }));
    const { error: lgErr } = await crm.from("recap_log").upsert(logRows, { onConflict: "booking_id", ignoreDuplicates: true });
    if (lgErr) throw new Error(`recap_log write failed: ${lgErr.message}`);
    if (!q.duplicate) out.queued++;
  }
  if (!out.preview && plan.review.length) {
    const { error: rvErr } = await crm.from("recap_review").upsert(plan.review.map(r => ({ ...r, client_id: clientId })), { onConflict: "booking_id,reason", ignoreDuplicates: true });
    if (rvErr) console.error(`[RIDE RECAP] recap_review write failed: ${rvErr.message}`);
  }
  return out;
}

// Phase 2 hook: OFF while reward_code is null. Looks at FareHarbor bookings created in the last few days whose ?ref= is friend-<id>.
export async function runReferralRewards(crm, { clientId = "csr_rea", now = new Date(), settings = null, baseUrl = resolveBaseUrl(), lookbackDays = 3 } = {}) {
  const s = settings ? normalizeRecapSettings(settings) : await loadRecapSettings(crm, clientId);
  if (!s?.reward_code) return { queued: 0, skipped: "no_reward_code" };
  const preview = isTestMode();
  const since = new Date(new Date(now).getTime() - lookbackDays * 864e5).toISOString();
  const { data: recent, error } = await crm.from("bookings").select("fareharbor_pk, company, status, customer_count, created_at, updated_at, raw_payload")
    .like("fareharbor_pk", "#%").gte("created_at", since);
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const friendBookings = (recent ?? []).filter(r => parseFriendRef(bookingFacts(r).ref));
  if (!friendBookings.length) return { queued: 0 };
  const refPks = [...new Set(friendBookings.map(r => `#${parseFriendRef(bookingFacts(r).ref)}`))];
  const { data: refRows, error: rErr } = await crm.from("bookings").select("fareharbor_pk, company, status, raw_payload").in("fareharbor_pk", refPks);
  if (rErr) throw new Error(`referrer lookup failed: ${rErr.message}`);
  const referrers = new Map((refRows ?? []).map(r => [r.fareharbor_pk, r]));
  const { data: existing, error: xErr } = await crm.from("recap_rewards").select("friend_booking_id, referrer_email, season").eq("client_id", clientId);
  if (xErr) throw new Error(`recap_rewards read failed: ${xErr.message}`);
  const sup = await loadSuppressionSets(crm);
  const plan = planReferralRewards({ friendBookings, referrers, existing: existing ?? [], suppressed: sup.all, settings: s, now });
  let queued = 0;
  for (const rw of plan.rewards) {
    if (preview) continue;
    const msg = renderReferralReward({ referrer: rw.referrer, settings: s, unsubscribeUrl: await unsubscribeUrlFor(crm, rw.referrer.email, baseUrl) });
    // claim first (unique per referrer per season + per friend booking), then queue
    const { error: insErr } = await crm.from("recap_rewards").insert({
      client_id: clientId, season: rw.season, referrer_booking_id: rw.referrer.pk, referrer_email: rw.referrer.email,
      friend_booking_id: rw.friend.pk, dry_run: s.dry_run, queued_at: new Date(now).toISOString(),
    });
    if (insErr) continue;                                              // lost a race / already rewarded
    const q = await queueRecapEmail(crm, { clientId, to: s.dry_run ? s.test_to : rw.referrer.email, subject: msg.subject, html: msg.html, text: msg.text,
      fromName: msg.fromName, reference: rw.friend.pk, idempotencyKey: `recap-reward-${rw.friend.pk}`, dryRun: s.dry_run });
    await crm.from("recap_rewards").update({ send_id: q.row.id }).eq("friend_booking_id", rw.friend.pk);
    queued++;
  }
  return { queued, planned: plan.rewards.length, skipped: plan.skipped.length, preview };
}

// Cron entry point: every tick, run each client whose send hour has come and that hasn't run today. The day is CLAIMED with a
// conditional update first, so two overlapping cron ticks can never both run it.
export async function runDueRideRecaps(crm, { now = new Date(), fetchImpl = globalThis.fetch, baseUrl } = {}) {
  const out = { ran: [] };
  if (!crm) return out;
  const { data, error } = await crm.from("recap_settings").select("*");
  if (error) return { ...out, error: error.message };                 // table not created yet → nothing to do
  for (const row of data ?? []) {
    if (!isRecapDue(row, now)) continue;
    const s = normalizeRecapSettings(row);
    const today = localDate(now, s.timezone);
    if (!isTestMode()) {
      const { data: claimed, error: cErr } = await crm.from("recap_settings").update({ last_run_on: today, last_run_at: new Date(now).toISOString() })
        .eq("client_id", row.client_id).or(`last_run_on.is.null,last_run_on.neq.${today}`).select("client_id");
      if (cErr || !claimed?.length) continue;
    }
    try {
      const recap = await runRideRecap(crm, { clientId: row.client_id, now, settings: row, fetchImpl, ...(baseUrl ? { baseUrl } : {}) });
      const reward = await runReferralRewards(crm, { clientId: row.client_id, now, settings: row, ...(baseUrl ? { baseUrl } : {}) });
      const summary = { queued: recap.queued, review: recap.review, skipped: recap.skipped, dry_run: recap.dryRun, rewards: reward.queued ?? 0 };
      if (!isTestMode()) await crm.from("recap_settings").update({ last_run_summary: summary }).eq("client_id", row.client_id);
      out.ran.push({ clientId: row.client_id, ...summary });
    } catch (err) {
      out.ran.push({ clientId: row.client_id, error: err.message });
    }
  }
  return out;
}

// ── CLI: node --env-file=.env rideRecap.js [--apply] [--now 2026-11-22T19:00:00-07:00] [--snapshots DIR] ──
// Default = preview: prints who WOULD get a recap (nothing written). --apply runs the job as configured in recap_settings
// (still dry_run=true unless Sean turned it off). --snapshots writes the six sample renders as .html files.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  (async () => {
    if (val("--snapshots")) {
      const fs = await import("fs"); const path = await import("path");
      const dir = val("--snapshots"); fs.mkdirSync(dir, { recursive: true });
      for (const [name, data] of Object.entries(sampleRecapRenders())) {
        const r = renderRideRecap(data);
        fs.writeFileSync(path.join(dir, `${name}.html`), applyPhotoMarkers(r.html, !name.endsWith("missing")));
      }
      console.log(`wrote ${Object.keys(sampleRecapRenders()).length} renders to ${dir}`);
      return;
    }
    const { createClient } = await import("@supabase/supabase-js");
    const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
    const now = val("--now") ? new Date(val("--now")) : new Date();
    const r = await runRideRecap(crm, { now, preview: !args.includes("--apply") });
    console.log(JSON.stringify(r, null, 2));
  })().catch(e => { console.error(e.message); process.exit(1); });
}

// The six fixed renders (3 types × full / missing data) used by the snapshot tests and --snapshots.
export function sampleRecapRenders() {
  const settings = { ...DEFAULT_RECAP_SETTINGS };
  const wx = [["SNOW", "6 in"], ["HIGH", "24°F"], ["SKY", "Snowing"]];
  const mk = (type, label, full) => {
    const tour = { type, label, miles: full ? 22 : null, high_point_ft: full ? 10340 : null, stops: full && type === "rea" ? ["Dumont Lake overlook", "Rabbit Ears Peak meadow", "Muddy Pass warming hut"] : [] };
    const booking = { bookingId: "392519085", pk: "#392519085", name: full ? "katrina schultz" : "Guest", startAt: "2027-01-29T18:00:00Z", endAt: "2027-01-29T21:00:00Z", pax: full ? 3 : 1, guide: full ? "Jake" : "" };
    const trip = buildTripDetails({ booking, tour });
    return buildRecapData({ booking, tour, trip: full ? trip : { ...trip, photo: false }, settings, weather: full ? wx : null, pax: booking.pax,
      unsubscribeUrl: "https://highmark-bot-production.up.railway.app/email/unsubscribe/00000000-0000-4000-8000-000000000000" });
  };
  return {
    "rea-full": mk("rea", "Grand Tour", true), "rea-missing": mk("rea", "Grand Tour", false),
    "backcountry-full": mk("backcountry", "Private Guided Backcountry", true), "backcountry-missing": mk("backcountry", "Private Guided Backcountry", false),
    "rental-full": mk("rental", "Polaris rental", true), "rental-missing": mk("rental", "Polaris rental", false),
  };
}
