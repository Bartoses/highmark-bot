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
import crypto from "crypto";
import { buildPhotoHint, pickRideMediaForBooking } from "./rideMedia.js";
import { escapeHtml, buildUnsubscribeUrl } from "./emailTemplates.js";
import { loadSuppressionSets, normEmail, isEmailAddress, escapeLike } from "./emailSuppression.js";
import { resolveBaseUrl } from "./emailSender.js";
import { buildSimpleRecapData, renderSimpleRecap, fetchNextStorm, normalizeTemplate } from "./recapSimple.js";

export const RECAP_TYPES = ["rea", "backcountry", "rental"];
export const RECAP_FEATURES = ["review", "share", "prints", "merch", "newsletter"];
export const RECAP_CATEGORY = "recap";

export const DEFAULT_RECAP_SETTINGS = Object.freeze({
  enabled: true, send_hour: 18, timezone: "America/Denver", dry_run: true, test_to: "sean@coloradosledrentals.com",
  features: [...RECAP_FEATURES], friend_code: "FRIEND10", friend_percent: 10, reward_code: null,
  weather_lat: null, weather_lon: null, weather_points: [], lookback_days: 1, last_run_on: null,
  template: "v1",                                                    // v1 | simple (recapSimple.js) — db2_ride_recap_v2.sql
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
  instagram: "https://www.instagram.com/coloradosledrentals/",
  facebook: "https://www.facebook.com/coloradosledrentals/",
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
  s.template = normalizeTemplate(row?.template);                      // anything unknown = v1 (today's email)
  s.experiments = row?.experiments && typeof row.experiments === "object" && !Array.isArray(row.experiments) ? { ...row.experiments } : {};
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
    availabilityPk: b.availability?.pk != null ? String(b.availability.pk) : null,   // FareHarbor departure id (ride_media key)
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
    highlight: null, photo: null, routeImage: tour?.route_image_url ?? null,
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
export function trackLink(base, { type, content, friendRef = null, term = null }) {
  const u = new URL(base);
  if (friendRef) u.searchParams.set("ref", `friend-${friendRef}`);
  u.searchParams.set("utm_source", "ride_recap");
  u.searchParams.set("utm_medium", "email");
  u.searchParams.set("utm_campaign", type);
  u.searchParams.set("utm_content", content);
  if (term) u.searchParams.set("utm_term", term);
  return u.toString();
}
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const thousands = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ── recap data (pure) ────────────────────────────────────────────────────────
// booking: bookingFacts(). trip: buildTripDetails(). settings: normalizeRecapSettings(). weather: weatherLabels() | null.
export function buildRecapData({ booking, tour, trip, settings, weather = null, pax = null, unsubscribeUrl = null, baseUrl = resolveBaseUrl(), variants = null }) {
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
    routeImage: type === "rental" ? null : (trip?.routeImage || null),
    routeTitle: type === "backcountry" ? "YOUR ROUTE · TRACKED BY YOUR GUIDE" : "YOUR LOOP",
    weather: Array.isArray(weather) && weather.length ? weather : null,
    photo: trip?.photo === false ? false : (trip?.photo || null),
    features: s.features, friendCode: s.friend_code, friendPercent: s.friend_percent,
    bookingId: booking.bookingId, label: tour.label,
    merchLine: [tour.label, dateShort, Number(trip?.miles) > 0 ? `${Number(trip.miles)} mi` : ""].filter(Boolean).join(" · "),
    reviewUrl: RECAP_LINKS.review[brand.key],
    nextUrl: type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.guided,
    shareUrl: type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.csr,
    // Gmail strips sms: links, so "Text it to a friend" opens this page in the browser, which can text/share (see renderSharePage).
    sharePageUrl: sharePageUrl(baseUrl, { bookingId: booking.bookingId, type }),
    unsubscribeUrl,
    variants: normalizeVariants(variants),
    subject: normalizeVariants(variants).subject === "B" ? questionSubject({ type, first, label: tour.label }) : copy.subject + (first ? `, ${first}` : ""),
  };
}

// Subject B ("question"): "Katrina, how was the Grand Tour?" / "How was your backcountry day?"
export function questionSubject({ type, first, label }) {
  const q = { rea: `how was the ${label}?`, backcountry: "how was your backcountry day?", rental: "how was your ride?" }[type];
  return first ? `${first}, ${q}` : q.charAt(0).toUpperCase() + q.slice(1);
}

// ── A/B experiments ──────────────────────────────────────────────────────────
// Each recap gets arm A or B of every experiment. Stats come from REAL sends only (recap_log.dry_run=false) and our own
// click tracking (email_events, human clicks, matched by the button's utm_content). Selection: 50/50 until every arm has
// MIN_SENDS real sends, then Thompson sampling (Beta posteriors), so traffic shifts toward the winner automatically while
// still testing the other arm a little. recap_settings.experiments[key] = "auto" (default) | "A" | "B" (locked) | "off" (= A).
export const RECAP_EXPERIMENTS = Object.freeze({
  subject:   { label: "Subject line", arms: { A: "Statement: \"Your Rabbit Ears tour recap, Katrina\"", B: "Question: \"Katrina, how was the Grand Tour?\"" }, goal: "any_click" },
  layout:    { label: "Review card position", arms: { A: "After the stats", B: "Right after the photo" }, goal: ["google-review"] },
  share_cta: { label: "Share button wording", arms: { A: "Send to a friend", B: "Give a friend 10% off" }, goal: ["share-sms", "share-social"] },
});
export const EXPERIMENT_MIN_SENDS = 20;
const ARMS = ["A", "B"];

export function normalizeVariants(v) {
  const out = {};
  for (const k of Object.keys(RECAP_EXPERIMENTS)) out[k] = v?.[k] === "B" ? "B" : "A";
  return out;
}
export const variantTerm = (v) => v ? Object.keys(RECAP_EXPERIMENTS).map(k => `${k}-${normalizeVariants(v)[k]}`).join(".") : null;

// Deterministic PRNG per (seed) so a re-run picks the same arms for the same booking.
function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Beta(a,b) sample via two Gamma draws (Marsaglia–Tsang), a,b >= 1 here.
function gammaSample(k, rnd) {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rnd() || 1e-12, u2 = rnd(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rnd() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const betaSample = (a, b, rnd) => { const x = gammaSample(a, rnd); return x / (x + gammaSample(b, rnd)); };

// stats: { [exp]: { A: { sends, wins }, B: { sends, wins } } }. mode per experiment from recap_settings.experiments.
export function chooseVariants({ seed, stats = {}, modes = {} }) {
  const rnd = seededRandom(seed), out = {};
  for (const k of Object.keys(RECAP_EXPERIMENTS)) {
    const mode = String(modes?.[k] ?? "auto");
    if (mode === "A" || mode === "B") { out[k] = mode; continue; }
    if (mode === "off") { out[k] = "A"; continue; }
    const st = stats[k] ?? {};
    const n = (a) => st[a]?.sends ?? 0, w = (a) => st[a]?.wins ?? 0;
    if (ARMS.some(a => n(a) < EXPERIMENT_MIN_SENDS)) { out[k] = rnd() < 0.5 ? "A" : "B"; continue; }   // explore evenly first
    const draw = (a) => betaSample(1 + w(a), 1 + Math.max(0, n(a) - w(a)), rnd);
    out[k] = draw("A") >= draw("B") ? "A" : "B";
  }
  return out;
}

// Chance each arm is best (Monte Carlo over the Beta posteriors) — for the report.
export function probBest(st, draws = 4000, seed = "report") {
  const rnd = seededRandom(seed); let a = 0;
  for (let i = 0; i < draws; i++) {
    const x = betaSample(1 + (st.A?.wins ?? 0), 1 + Math.max(0, (st.A?.sends ?? 0) - (st.A?.wins ?? 0)), rnd);
    const y = betaSample(1 + (st.B?.wins ?? 0), 1 + Math.max(0, (st.B?.sends ?? 0) - (st.B?.wins ?? 0)), rnd);
    if (x >= y) a++;
  }
  return { A: a / draws, B: 1 - a / draws };
}

// Did this send achieve the experiment's goal? clicks = human click URLs for the send.
export function goalHit(goal, clickUrls) {
  if (!clickUrls?.length) return false;
  if (goal === "any_click") return true;
  return clickUrls.some(u => { try { return goal.includes(new URL(u).searchParams.get("utm_content")); } catch { return false; } });
}

// Pure: fold log rows + click events into per-arm stats. Each template learns on its own (a v1 "layout B" and a simple
// "layout B" are different emails), so only rows of `template` count; rows logged before templates existed are v1.
export const variantTemplate = (v) => (v?.template === "simple" ? "simple" : "v1");
export function tallyExperiments(logRows, clicksBySend, { template = "v1" } = {}) {
  const stats = {};
  for (const k of Object.keys(RECAP_EXPERIMENTS)) stats[k] = { A: { sends: 0, wins: 0 }, B: { sends: 0, wins: 0 } };
  const seen = new Set();
  for (const r of logRows ?? []) {
    if (!r?.send_id || r.dry_run !== false || !r.variants || seen.has(r.send_id)) continue;   // one email may cover several bookings
    if (variantTemplate(r.variants) !== template) continue;
    seen.add(r.send_id);
    const v = normalizeVariants(r.variants), clicks = clicksBySend.get(r.send_id) ?? [];
    for (const [k, def] of Object.entries(RECAP_EXPERIMENTS)) {
      stats[k][v[k]].sends++;
      if (goalHit(def.goal, clicks)) stats[k][v[k]].wins++;
    }
  }
  return stats;
}

export async function loadExperimentStats(crm, { clientId = "csr_rea", sinceDays = 365, nowMs = Date.now(), template = "v1" } = {}) {
  const since = new Date(nowMs - sinceDays * 864e5).toISOString();
  const logs = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await crm.from("recap_log").select("send_id, dry_run, variants").eq("client_id", clientId).eq("dry_run", false)
      .gte("queued_at", since).order("queued_at", { ascending: true }).range(from, from + 999);
    if (error) return { stats: tallyExperiments([], new Map(), { template }), error: error.message };   // variants column missing → no stats yet
    logs.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  const ids = [...new Set(logs.map(r => r.send_id).filter(Boolean))], clicks = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await crm.from("email_events").select("send_id, url, is_bot").eq("type", "click").in("send_id", ids.slice(i, i + 200));
    for (const e of data ?? []) { if (e.is_bot) continue; if (!clicks.has(e.send_id)) clicks.set(e.send_id, []); clicks.get(e.send_id).push(e.url); }
  }
  return { stats: tallyExperiments(logs, clicks, { template }) };
}

export function experimentReport(stats, modes = {}) {
  return Object.entries(RECAP_EXPERIMENTS).map(([k, def]) => {
    const st = stats?.[k] ?? { A: { sends: 0, wins: 0 }, B: { sends: 0, wins: 0 } };
    const rate = (a) => st[a].sends ? Math.round((st[a].wins / st[a].sends) * 1000) / 10 : null;
    const pb = probBest(st);
    const ready = ARMS.every(a => st[a].sends >= EXPERIMENT_MIN_SENDS);
    const leader = pb.A >= pb.B ? "A" : "B";
    return { key: k, label: def.label, mode: String(modes?.[k] ?? "auto"), goal: def.goal === "any_click" ? "any click" : def.goal.join(" or "),
      arms: Object.fromEntries(ARMS.map(a => [a, { description: def.arms[a], sends: st[a].sends, clicks: st[a].wins, click_rate_pct: rate(a), chance_best_pct: Math.round(pb[a] * 100) }])),
      status: !ready ? `collecting data (needs ${EXPERIMENT_MIN_SENDS} real sends per version)` : (pb[leader] >= 0.95 ? `winner: ${leader}` : `leaning ${leader}`) };
  });
}

// ── HTML (table-based, inline styles, no flex/grid, max-width 600) ───────────
export function renderRideRecap(d) {
  const C = d.brand, rea = C.key === "rea", type = d.type, e = escapeHtml;
  const has = (f) => d.features.includes(f);
  const link = (base, content, friend = false) => trackLink(base, { type, content, friendRef: friend ? d.bookingId : null, term: variantTerm(d.variants) });
  const btn = (text, href, primary = true) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-radius:12px;background:${primary ? C.btn : "#FFFFFF"};${primary ? "" : `border:2px solid ${C.dark2};`}">` +
    `<a href="${attr(href)}" style="display:block;padding:15px 18px;font:700 16px/20px Arial,Helvetica,sans-serif;color:${primary ? C.btnTxt : C.dark2};text-decoration:none">${text}</a></td></tr></table>`;
  const h2 = (t, color = C.dark2) => `<div style="font:${rea ? "400 28px" : "700 24px"}/1.1 ${C.head};text-transform:${C.up};color:${color};margin:0 0 10px">${t}</div>`;
  const p = (t, color = C.muted) => `<div style="font:17px/1.5 Arial,Helvetica,sans-serif;color:${color};margin:0 0 14px">${t}</div>`;
  const block = (inner) => `<tr><td style="padding:24px 20px 0">${inner}</td></tr>`;
  const card = (inner, bg = "#FFFFFF", border = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px;border-radius:16px;background:${bg};${border ? `border:${border};` : ""}">${inner}</td></tr></table>`;

  let rows = "";
  // header logo
  rows += `<tr><td style="background:${C.headBg};padding:14px 20px;border-bottom:1px solid #DFE9F0"><img src="${attr(C.logo)}" height="${C.logoH}" alt="${e(C.name)}" style="display:block;border:0;height:${C.logoH}px;width:auto"></td></tr>`;
  // hero: kicker, headline, subline, photo slot (filled by the Apps Script from Drive, or removed)
  rows += `<tr><td style="background:${C.dark};padding:28px 20px 24px;color:#FFFFFF">` +
    `<div style="font:700 13px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc}">${e(d.kicker)}</div>` +
    `<div style="font:${rea ? "400 44px" : "700 30px"}/1.05 ${C.head};text-transform:${C.up};margin:10px 0;color:#FFFFFF">${e(d.h1)}</div>` +
    `<div style="font:17px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3">${e(d.sub)}</div>` +
    (d.highlight ? `<div style="font:italic 15px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3;margin-top:10px">“${e(d.highlight)}”</div>` : "") +
    (d.photo === false ? "" : `<div style="max-height:260px;overflow:hidden;border-radius:12px">${"<!--PHOTO_SLOT-->"}</div>`) +
    `</td></tr>`;
  if (has("review") && d.variants.layout === "B") rows += reviewCard();
  // route map (REA loop / backcountry track). Only when a route image exists — never a made-up route for a guest.
  if (d.routeImage) {
    rows += `<tr><td style="padding:22px 20px 0"><div style="font:700 13px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.muted};margin-bottom:10px">${e(d.routeTitle)}</div>` +
      `<img src="${attr(d.routeImage)}" width="560" alt="Map of your route" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:14px"></td></tr>`;
  }
  // stats 2×2
  if (d.stats.length) {
    let s = "";
    for (let i = 0; i < d.stats.length; i += 2) {
      s += "<tr>" + [d.stats[i], d.stats[i + 1]].map(x => x
        ? `<td width="50%" valign="top" style="padding:5px"><div style="background:${C.soft};border:1px solid #DFE9F0;border-radius:12px;padding:14px 16px"><div style="font:${rea ? "400 30px" : "700 26px"}/1 ${C.head};color:${C.dark2}">${e(x[0])}</div><div style="font:15px/1.3 Arial,Helvetica,sans-serif;color:${C.muted};margin-top:4px">${e(x[1])}</div></div></td>`
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
    rows += `<tr><td style="padding:12px 20px 0;font:15px Arial,Helvetica,sans-serif;color:${C.muted}">` +
      d.weather.map(w => `<span style="display:inline-block;background:${C.dark2};color:#FFFFFF;border-radius:999px;padding:7px 12px;margin:0 6px 6px 0"><span style="font-size:11px;color:#9FB3C8;font-weight:700">${e(w[0])}</span> <b>${e(w[1])}</b></span>`).join("") +
      `</td></tr>`;
  }
  // review — EVERY guest sees both the review button and "tell us directly" (no review gating). Experiment "layout":
  // A = here (after the stats), B = right after the hero (rendered there and skipped here).
  if (has("review") && d.variants.layout !== "B") rows += reviewCard();
  function reviewCard() {
    const feedback = `mailto:${RECAP_LINKS.infoEmail}?subject=${encodeURIComponent(`Feedback on my ride (#${d.bookingId})`)}`;
    return block(card(`<div style="font-size:20px;color:#F5B301;letter-spacing:2px;margin-bottom:8px">★★★★★</div>` + h2(`How was your ${e(d.copy.place)}?`) +
      p("If you had a great time, a quick Google review helps our small local team more than anything. It takes about a minute.") +
      btn("Leave a Google review", link(d.reviewUrl, "google-review")) +
      `<div style="text-align:center;padding:12px 0 0"><a href="${attr(feedback)}" style="font:700 15px Arial,Helvetica,sans-serif;color:#1670C2">Something not right? Tell us directly</a></div>`,
    "#FFFFFF", `2px solid ${C.dark2}`));
  }
  // share / referral
  if (has("share")) {
    const pct = d.friendPercent, code = e(d.friendCode);
    rows += block(card(`<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc};margin-bottom:8px">GIVE ${pct}%, GET ${pct}%</div>` +
      h2("Bring a friend next time", "#FFFFFF") +
      p(`Friends save ${pct}% with this code at checkout. When they ride, you get ${pct}% off your next booking.`, "#C9D6E3") +
      `<div style="border:2px dashed ${C.acc};border-radius:12px;text-align:center;font:700 24px 'Courier New',Courier,monospace;letter-spacing:3px;color:#FFFFFF;padding:12px 0;margin-bottom:14px">${code}</div>` +
      btn(d.variants.share_cta === "B" ? `Give a friend ${pct}% off` : "Send to a friend", link(d.sharePageUrl, "share-sms")) +
      `<div style="height:10px;line-height:10px;font-size:10px">&nbsp;</div>` +
      btn("Post your ride on Instagram", link(`${d.sharePageUrl}#ride`, "share-social"), false),
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
  rows += `<tr><td style="padding:28px 20px;font:14px/1.6 Arial,Helvetica,sans-serif;color:${C.muted};text-align:center">` +
    C.footer.map(e).join("<br>") + `<br>${RECAP_PHONE} · ${RECAP_SOCIAL}<br>` +
    `<a href="${attr(unsub)}" data-notrack style="color:#1670C2">Unsubscribe</a></td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${e(d.subject)}</title>` +
    `<meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no">` +
    `<style>body{-webkit-text-size-adjust:100%;text-size-adjust:100%}</style>` +
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
  if (has("share")) out.push("", `Give ${d.friendPercent}%, get ${d.friendPercent}%: friends save ${d.friendPercent}% with code ${d.friendCode}: ${link(d.shareUrl, "share-email", true)}`,
    `Text it to a friend: ${link(d.sharePageUrl, "share-sms")}`, `Post your ride: ${link(`${d.sharePageUrl}#ride`, "share-social")}`);
  if (has("merch")) out.push("", `Wear the memory — a hoodie printed with ${d.merchLine}: ${link(RECAP_LINKS.merch, "merch")}`);
  out.push("", `${d.copy.nextTitle}. ${d.copy.nextBody} ${link(d.nextUrl, "book-next")}`);
  if (has("newsletter")) out.push("", `Get first dibs on powder days: ${link(RECAP_LINKS.newsletter, "newsletter")}`);
  out.push("", "—", ...C.footer, `${RECAP_PHONE} · ${RECAP_SOCIAL}`, `Unsubscribe: ${d.unsubscribeUrl || `email ${RECAP_LINKS.infoEmail} with the subject "Unsubscribe"`}`);
  return out.join("\n");
}

// ── share page (GET /r/share?b=<booking id>&t=<type>) ─────────────────────────
// Gmail (web + apps) removes sms: hrefs from emails, so the email's "Text it to a friend" button is an https link to this page.
// In the phone's browser it offers the native share sheet (Messages, WhatsApp, …), a "Text it" sms: link, and copy-to-clipboard.
// Nothing here is secret: the booking id only labels the referral (ref=friend-<id>); a reward still needs a real booking.
export function sharePageUrl(baseUrl, { bookingId, type, sig = null }) {
  return `${String(baseUrl || resolveBaseUrl()).replace(/\/$/, "")}/r/share?b=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(type)}${sig ? `&s=${encodeURIComponent(sig)}` : ""}`;
}
// "See & download photos" page (GET /r/photos). Always signed: it can show the guest's own photo.
export function photosPageUrl(baseUrl, { bookingId, type, sig }) {
  return `${String(baseUrl || resolveBaseUrl()).replace(/\/$/, "")}/r/photos?b=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(type)}&s=${encodeURIComponent(sig ?? "")}`;
}

// A guest's ride photo is personal, so the public pages (/r/share, /r/ride, /r/photos) only show it when the link carries
// this signature (HMAC of the booking id; EMAIL_TRACKING_SECRET, else OUTBOUND_API_KEY). The email's links are signed;
// a guessed booking id gets the map and the stats, never the photo. No secret configured = photos are never shown.
const rideLinkSecret = () => (process.env.EMAIL_TRACKING_SECRET || process.env.OUTBOUND_API_KEY || "").trim() || null;
export function rideLinkSig(bookingId, secret = rideLinkSecret()) {
  if (!secret || !/^\d{1,15}$/.test(String(bookingId ?? ""))) return null;
  return crypto.createHmac("sha256", secret).update(`ride-photos:${bookingId}`).digest("base64url").slice(0, 22);
}
export function verifyRideLinkSig(bookingId, sig, secret = rideLinkSecret()) {
  const want = rideLinkSig(bookingId, secret);
  if (!want || typeof sig !== "string" || sig.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

export function shareMessage({ bookingId, type, settings }) {
  const s = normalizeRecapSettings(settings);
  const C = RECAP_BRANDS[type === "rea" ? "rea" : "csr"];
  const url = trackLink(type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.csr, { type, content: "share-sms", friendRef: bookingId });
  return { brand: C, url, text: `You have to try ${C.name}! Use code ${s.friend_code} for ${s.friend_percent}% off: ${url}` };
}

// ── ride share context: what a public page may show about a ride (no names, emails or phones) ──
const MON_LONG = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u ?? "")) ? String(u) : null);
export function shareContextFrom({ bookingId, type, row = null, tours = [], settings = null, hostedPhoto = null, sig = null }) {
  const b = String(bookingId ?? ""), t = String(type ?? "");
  if (!/^\d{1,15}$/.test(b) || !RECAP_TYPES.includes(t)) return null;
  const s = normalizeRecapSettings(settings);
  let tour = null, facts = null;
  if (row) { facts = bookingFacts(row); tour = matchTour(facts.item, tours); }
  const rtype = tour?.type ?? t;
  const brand = RECAP_BRANDS[rtype === "rea" ? "rea" : "csr"];
  const label = tour?.label ?? { rea: "Rabbit Ears tour", backcountry: "Backcountry day", rental: "Sled day" }[rtype];
  let dateLabel = null;
  const when = facts?.startAt ?? facts?.endAt;
  if (when) { const [y, m, d] = localDate(when, s.timezone).split("-").map(Number); dateLabel = `${MON_LONG[m - 1]} ${d}, ${y}`; }
  const stats = [];
  if (tour && Number(tour.miles) > 0) stats.push([`${Number(tour.miles)} mi`, "ridden"]);
  if (tour && Number(tour.high_point_ft) > 0) stats.push([`${thousands(tour.high_point_ft)} ft`, "high point"]);
  const hrs = facts ? hoursLabel(facts.startAt, facts.endAt) : "";
  if (hrs) stats.push([hrs, "on the snow"]);
  if (facts?.pax > 0) stats.push([String(facts.pax), facts.pax === 1 ? "rider" : "riders"]);
  // photo: from the hosted recap photo (DB, email_sends.photo_hint.hosted_photo), only for a signed link. map: recap_tours.map_url (REA).
  return { bookingId: b, type: rtype, brand, label, dateLabel, stats: stats.slice(0, 4), settings: s,
    sig: sig || null, photoUrl: sig ? httpsUrl(hostedPhoto?.full) : null, mapUrl: rtype === "rea" ? httpsUrl(tour?.map_url) : null };
}

export async function loadShareContext(crm, { bookingId, type, sig = null, clientId = "csr_rea" }) {
  let row = null, tours = [], settings = null, hostedPhoto = null;
  const signed = verifyRideLinkSig(bookingId, sig) ? sig : null;
  if (crm && /^\d{1,15}$/.test(String(bookingId ?? ""))) {
    try {
      if (signed) {
        const { data: sends } = await crm.from("email_sends").select("photo_hint, created_at").eq("category", "recap").eq("reference", `#${bookingId}`)
          .order("created_at", { ascending: false }).limit(5);
        const hint = (sends ?? []).map(r => (typeof r.photo_hint === "string" ? (() => { try { return JSON.parse(r.photo_hint); } catch { return null; } })() : r.photo_hint)).find(h => h?.hosted_photo);
        hostedPhoto = hint?.hosted_photo ?? null;
      }
      const [bk, tr, st] = await Promise.all([
        crm.from("bookings").select("fareharbor_pk, company, status, start_at, end_at, customer_count, product_title, raw_payload").eq("fareharbor_pk", `#${bookingId}`).maybeSingle(),
        crm.from("recap_tours").select("*").eq("client_id", clientId),
        crm.from("recap_settings").select("*").eq("client_id", clientId).maybeSingle(),
      ]);
      row = bk.data ?? null; tours = (tr.data ?? []).filter(x => x.active !== false); settings = st.data ?? null;
    } catch { /* generic page */ }
  }
  return shareContextFrom({ bookingId, type, row, tours, settings, hostedPhoto, sig: signed });
}

export const ridePageUrl = (baseUrl, { bookingId, type, sig = null }) =>
  `${String(baseUrl || resolveBaseUrl()).replace(/\/$/, "")}/r/ride?b=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(type)}${sig ? `&s=${encodeURIComponent(sig)}` : ""}`;
export const ogImageUrl = (baseUrl, brandKey) => `${String(baseUrl || resolveBaseUrl()).replace(/\/$/, "")}/r/og/${brandKey === "rea" ? "rea" : "csr"}.png`;

const pageHead = (title, C, extra = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title>${extra}` +
  `<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&amp;family=Roboto:wght@400;700&amp;display=swap" rel="stylesheet"></head>` +
  `<body style="margin:0;background:${C.dark};color:#FFFFFF;font:16px/1.5 Arial,Helvetica,sans-serif"><div style="max-width:480px;margin:0 auto;padding:32px 20px">`;
const pageButton = (C, label, attrs, primary) => `<a ${attrs} style="display:block;text-align:center;padding:16px;border-radius:12px;font:700 17px Arial,Helvetica,sans-serif;text-decoration:none;margin:0 0 12px;cursor:pointer;` +
  (primary ? `background:${C.btn};color:${C.btnTxt}` : `background:#FFFFFF;color:${C.dark2};border:2px solid ${C.dark2}`) + `">${label}</a>`;
const statTiles = (C, stats) => stats.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>` +
  stats.map((x, i) => (i && i % 2 === 0 ? "</tr><tr>" : "") + `<td style="padding:4px;width:50%"><div style="background:${C.dark2};border-radius:12px;padding:12px;text-align:center"><div style="font:${C.key === "rea" ? "400 28px" : "700 22px"}/1 ${C.head};color:#FFFFFF">${escapeHtml(x[0])}</div><div style="font-size:12px;color:#9FB3C8;margin-top:4px">${escapeHtml(x[1])}</div></div></td>`).join("") +
  `</tr></table>` : "";

const followUs = (C) => `<p style="text-align:center;color:#9FB3C8;font-size:15px;margin:28px 0 0">Follow us: ` +
  `<a href="${attr(RECAP_LINKS.instagram)}" target="_blank" rel="noopener" style="color:#FFFFFF">Instagram</a>` +
  `<span style="color:#5B6B7C;padding:0 8px">·</span><a href="${attr(RECAP_LINKS.facebook)}" target="_blank" rel="noopener" style="color:#FFFFFF">Facebook</a></p>`;

// GET /r/share — "Bring a friend" (text/share/copy) + "Share your ride" (story image, Facebook, X, copy link).
// Gmail removes sms: hrefs from emails, so the email's buttons are https links to this page.
export function renderSharePage(input) {
  const ctx = input?.label ? input : shareContextFrom(input ?? {});
  if (!ctx) return null;
  const baseUrl = input?.baseUrl, C = ctx.brand, s = ctx.settings, e = escapeHtml;
  const { text } = shareMessage({ bookingId: ctx.bookingId, type: ctx.type, settings: s });
  const sms = `sms:?&body=${encodeURIComponent(text)}`;
  const rideUrl = trackLink(ridePageUrl(baseUrl, ctx), { type: ctx.type, content: "social-link" });
  const fb = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(trackLink(ridePageUrl(baseUrl, ctx), { type: ctx.type, content: "social-facebook" }))}`;
  const photos = ctx.sig && (ctx.photoUrl || ctx.mapUrl) ? photosPageUrl(baseUrl, ctx) : null;
  const story = { brand: C.name, label: ctx.label, date: ctx.dateLabel, stats: ctx.stats, code: s.friend_code, pct: s.friend_percent,
    dark: C.dark, dark2: C.dark2, acc: C.acc, btn: C.btn, head: C.key === "rea" ? "Bebas Neue" : "Roboto", upper: C.key === "rea",
    site: C.key === "rea" ? "rabbitearsadventures.com" : "coloradosledrentals.com",
    // the story picture: the guest's ride photo (signed link) → else the loop's route map (REA) → else the drawn ridge
    ...(ctx.photoUrl ? { photo: ctx.photoUrl, fit: "cover" } : ctx.mapUrl ? { photo: ctx.mapUrl, fit: "contain" } : {}) };
  const B = (label, attrs, primary) => pageButton(C, label, attrs, primary);
  const small = (label, attrs) => `<a ${attrs} style="color:#C9D6E3;font-size:15px;text-decoration:underline;cursor:pointer">${label}</a>`;
  const eyebrow = (t) => `<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc}">${t}</div>`;
  const h = (t, size) => `<h1 style="font:${C.key === "rea" ? `400 ${size}px` : `700 ${Math.round(size * 0.8)}px`}/1.1 ${C.head};text-transform:${C.up};margin:8px 0 12px">${t}</h1>`;
  return pageHead(`Share ${C.name}`, C, `<meta name="robots" content="noindex">`) +
    // 1) bring a friend — one button
    `<div id="friend">` + eyebrow(`GIVE ${s.friend_percent}%, GET ${s.friend_percent}%`) + h("Bring a friend next time", 36) +
    `<p style="color:#C9D6E3;margin:0 0 16px">Friends save ${s.friend_percent}% with code <b style="color:#FFFFFF;letter-spacing:1px">${e(s.friend_code)}</b>. When they ride, you get ${s.friend_percent}% off your next booking.</p>` +
    B("Send to a friend", `id="share" href="${attr(sms)}"`, true) +
    `<div style="text-align:center">${small("Copy message", `id="copy" href="#"`)}</div></div>` +
    // 2) share your ride — Instagram first
    `<div id="ride" style="border-top:1px solid ${C.dark2};margin:28px 0 0;padding:28px 0 0">` + eyebrow("SHARE YOUR RIDE") + h(e(ctx.label), 32) +
    `<img id="storyImg" alt="Your ride story image" style="display:block;width:100%;max-width:240px;margin:4px auto 16px;border-radius:12px;border:1px solid #3A4A5C;box-shadow:0 8px 24px rgba(0,0,0,.45);background:${C.dark2};aspect-ratio:9/16">` +
    `<canvas id="story" width="1080" height="1920" style="display:none"></canvas>` +
    B("Share to Instagram", `id="shareStory" href="#"`, true) +
    `<p id="storyTip" style="display:none;color:#C9D6E3;font-size:15px;margin:0 0 14px;text-align:center">Press and hold the picture above, tap <b>Save to Photos</b>, then post it as your Instagram story.</p>` +
    `<div style="text-align:center">${small("Facebook", `href="${attr(fb)}" target="_blank" rel="noopener"`)}<span style="color:#5B6B7C;padding:0 10px">·</span>${small("Copy link", `id="copyLink" href="#"`)}` +
    (photos ? `<span style="color:#5B6B7C;padding:0 10px">·</span>${small("Your photos", `href="${attr(photos)}"`)}` : "") + `</div>` +
    `</div>` + followUs(C) +
    `<p style="color:#9FB3C8;font-size:13px;margin:20px 0 0">${C.footer.map(e).join("<br>")}</p></div>` +
    `<script>(function(){var t=${jsonForScript(text)},R=${jsonForScript(Object.fromEntries(Object.entries(story).filter(([, v]) => v != null)))},L=${jsonForScript(rideUrl)};` +
    `function copy(v,el){var d=function(){el.textContent="Copied!";};if(navigator.clipboard){navigator.clipboard.writeText(v).then(d,function(){});}else{var a=document.createElement("textarea");a.value=v;document.body.appendChild(a);a.select();document.execCommand("copy");a.remove();d();}}` +
    `var s=document.getElementById("share");if(navigator.share){s.addEventListener("click",function(ev){ev.preventDefault();navigator.share({text:t}).catch(function(){});});}` +
    `document.getElementById("copy").addEventListener("click",function(ev){ev.preventDefault();copy(t,ev.target);});` +
    `document.getElementById("copyLink").addEventListener("click",function(ev){ev.preventDefault();copy(L,ev.target);});` +
    STORY_SCRIPT + `})();</script></body></html>`;
}

// Draws the 1080x1920 story card (Instagram/Facebook Stories) in the browser — no server image library needed.
// R.photo (a public image URL from the Guide Ride Log, later) fills the top half when present.
const STORY_SCRIPT = `var c=document.getElementById("story"),x=c.getContext("2d");` +
  `function font(w,px){return w+" "+px+"px "+(R.head==="Bebas Neue"?"'Bebas Neue',Impact,Arial":"Roboto,Arial")+",sans-serif";}` +
  `function wrap(txt,y,px,max){var words=txt.split(" "),line="",lines=[];words.forEach(function(w){var tt=line?line+" "+w:w;if(x.measureText(tt).width>max&&line){lines.push(line);line=w;}else line=tt;});lines.push(line);lines.forEach(function(l,i){x.fillText(l,90,y+i*px*1.05);});return y+(lines.length-1)*px*1.05;}` +
  `function ridge(){x.globalAlpha=0.16;x.fillStyle=R.acc;x.beginPath();x.moveTo(0,1560);x.lineTo(0,1400);x.lineTo(170,1250);x.lineTo(330,1360);x.lineTo(520,1190);x.lineTo(700,1340);x.lineTo(880,1230);x.lineTo(1080,1330);x.lineTo(1080,1560);x.closePath();x.fill();x.globalAlpha=1;}` +
  `function draw(img){x.fillStyle=R.dark;x.fillRect(0,0,1080,1920);var top=330;if(!img)ridge();` +
  `if(img&&R.fit==="contain"){var mh=Math.round(img.height*1080/img.width);x.drawImage(img,0,0,1080,mh);top=mh+110;}` +
  `else if(img){var h=1000,sc=Math.max(1080/img.width,h/img.height);x.drawImage(img,(1080-img.width*sc)/2,0,img.width*sc,img.height*sc);var g=x.createLinearGradient(0,600,0,1000);g.addColorStop(0,"rgba(0,0,0,0)");g.addColorStop(1,R.dark);x.fillStyle=g;x.fillRect(0,600,1080,400);top=1020;}` +
  `x.fillStyle=R.acc;x.font="700 40px Arial,sans-serif";x.fillText(R.brand.toUpperCase(),90,top);` +
  `x.fillStyle="#FFFFFF";x.font=font(R.upper?"400":"700",R.upper?170:120);var lbl=R.upper?R.label.toUpperCase():R.label;var y=wrap(lbl,top+(R.upper?190:150),R.upper?170:120,900);` +
  `if(R.date){x.fillStyle="#C9D6E3";x.font="400 52px Arial,sans-serif";x.fillText(R.date,90,y+90);y+=90;}` +
  `var st=R.stats||[];for(var i=0;i<st.length;i++){var col=i%2,row=Math.floor(i/2),bx=90+col*460,by=y+70+row*230;x.fillStyle=R.dark2;x.beginPath();if(x.roundRect)x.roundRect(bx,by,440,200,28);else x.rect(bx,by,440,200);x.fill();` +
  `x.fillStyle="#FFFFFF";x.font=font(R.upper?"400":"700",R.upper?110:84);x.fillText(st[i][0],bx+36,by+115);x.fillStyle="#9FB3C8";x.font="400 38px Arial,sans-serif";x.fillText(st[i][1],bx+36,by+170);}` +
  `x.fillStyle=R.btn;x.beginPath();if(x.roundRect)x.roundRect(90,1610,900,170,36);else x.rect(90,1610,900,170);x.fill();` +
  `x.fillStyle=R.dark;x.font="700 50px Arial,sans-serif";x.textAlign="center";x.fillText("Use "+R.code+" for "+R.pct+"% off",540,1690);x.font="400 38px Arial,sans-serif";x.fillText(R.site,540,1745);x.textAlign="left";` +
  `document.getElementById("storyImg").src=c.toDataURL("image/png");c.toBlob(function(b){if(b)window.__story=b;});}` +
  `function go(){if(R.photo){var im=new Image();im.crossOrigin="anonymous";im.onload=function(){draw(im);};im.onerror=function(){draw(0);};im.src=R.photo;}else draw(0);}` +
  `if(document.fonts&&document.fonts.load){Promise.all([document.fonts.load("400 100px 'Bebas Neue'"),document.fonts.load("700 100px Roboto")]).then(go,go);}else go();` +
  `function tip(){var p=document.getElementById("storyTip");p.style.display="block";p.scrollIntoView({behavior:"smooth",block:"center"});}` +
  `document.getElementById("shareStory").addEventListener("click",function(ev){ev.preventDefault();var b=window.__story;if(!b){tip();return;}` +
  `var f=new File([b],"my-ride.png",{type:"image/png"});if(navigator.canShare&&navigator.canShare({files:[f]})){navigator.share({files:[f]}).catch(function(e){if(!e||e.name!=="AbortError")tip();});}else{tip();}});`;

// GET /r/ride — the public page a posted link points at. Social sites read its preview (og:*) tags.
// Shows only the tour, date and ride stats (never a name, email or phone), plus a booking button that credits the guest (ref=friend-<id>).
export function renderRidePage(input) {
  const ctx = input?.label ? input : shareContextFrom(input ?? {});
  if (!ctx) return null;
  const baseUrl = input?.baseUrl, C = ctx.brand, s = ctx.settings, e = escapeHtml;
  const title = `${ctx.label} with ${C.name}`;
  const desc = `${ctx.dateLabel ? `${ctx.dateLabel}. ` : ""}Book your own ride and save ${s.friend_percent}% with code ${s.friend_code}.`;
  const img = ctx.photoUrl || ctx.mapUrl || ogImageUrl(baseUrl, C.key);
  const ogSize = img === ogImageUrl(baseUrl, C.key) ? [["og:image:width", "1200"], ["og:image:height", "630"]] : [];
  const book = trackLink(ctx.type === "rea" ? RECAP_LINKS.book.rea : RECAP_LINKS.book.csr, { type: ctx.type, content: "ride-page-book", friendRef: ctx.bookingId });
  const og = [["og:type", "website"], ["og:title", title], ["og:description", desc], ["og:image", img], ...ogSize,
    ["og:url", ridePageUrl(baseUrl, ctx)], ["og:site_name", C.name]].map(([p, v]) => `<meta property="${p}" content="${attr(v)}">`).join("") +
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${attr(title)}"><meta name="twitter:description" content="${attr(desc)}"><meta name="twitter:image" content="${attr(img)}"><meta name="description" content="${attr(desc)}">`;
  return pageHead(title, C, og) +
    `<img src="${attr(img)}" alt="${attr(C.name)}" style="display:block;width:100%;height:auto;border-radius:12px;margin:0 0 20px">` +
    `<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc}">${e(C.name.toUpperCase())}</div>` +
    `<h1 style="font:${C.key === "rea" ? "400 40px" : "700 30px"}/1.1 ${C.head};text-transform:${C.up};margin:8px 0 6px">${e(ctx.label)}</h1>` +
    (ctx.dateLabel ? `<p style="color:#C9D6E3;margin:0 0 16px">${e(ctx.dateLabel)}</p>` : "") +
    statTiles(C, ctx.stats) +
    `<p style="color:#C9D6E3;margin:0 0 14px">Want to ride too? Save ${s.friend_percent}% on your booking with this code:</p>` +
    `<div style="border:2px dashed ${C.acc};border-radius:12px;text-align:center;font:700 26px 'Courier New',Courier,monospace;letter-spacing:3px;padding:14px 0;margin:0 0 16px">${e(s.friend_code)}</div>` +
    pageButton(C, "Book your ride", `href="${attr(book)}"`, true) + followUs(C) +
    `<p style="color:#9FB3C8;font-size:13px;margin:20px 0 0">${C.footer.map(e).join("<br>")}<br>${RECAP_PHONE}</p></div></body></html>`;
}

// GET /r/photos?b=&t=&s= — "See & download photos": the guest's hosted ride photo (signed link only) + the loop's route map,
// each with a Save/Share button (native share sheet → Save Image on a phone; a download elsewhere). Data comes from the DB.
export function renderPhotosPage(input) {
  const ctx = input?.label ? input : shareContextFrom(input ?? {});
  if (!ctx) return null;
  const baseUrl = input?.baseUrl, C = ctx.brand, e = escapeHtml;
  const items = [];
  if (ctx.photoUrl) items.push({ url: ctx.photoUrl, alt: `Photo from your ${ctx.label}`, name: `${ctx.label} photo.jpg` });
  if (ctx.mapUrl) items.push({ url: ctx.mapUrl, alt: `Map of your ${ctx.label} loop`, name: `${ctx.label} map.png` });
  const share = sharePageUrl(baseUrl, ctx);
  return pageHead(`Your ${ctx.label} photos`, C, `<meta name="robots" content="noindex">`) +
    `<div style="font:700 12px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc}">${e(C.name.toUpperCase())}</div>` +
    `<h1 style="font:${C.key === "rea" ? "400 40px" : "700 30px"}/1.1 ${C.head};text-transform:${C.up};margin:8px 0 6px">Your ${e(ctx.label)}</h1>` +
    (ctx.dateLabel ? `<p style="color:#C9D6E3;margin:0 0 20px">${e(ctx.dateLabel)}</p>` : "") +
    (items.length ? items.map((it, i) => `<img src="${attr(it.url)}" alt="${attr(it.alt)}" style="display:block;width:100%;height:auto;border-radius:12px;margin:0 0 12px">` +
      pageButton(C, "Save or share", `class="save" data-i="${i}" href="${attr(it.url)}" target="_blank" rel="noopener"`, i === 0)).join(`<div style="height:12px"></div>`)
      : `<p style="color:#C9D6E3">Your photos aren't ready yet. Check back soon.</p>`) +
    `<div style="height:16px"></div>` + pageButton(C, "Share your ride", `href="${attr(share)}#ride"`, false) + followUs(C) +
    `<p style="color:#9FB3C8;font-size:13px;margin:20px 0 0">${C.footer.map(e).join("<br>")}<br>${RECAP_PHONE}</p></div>` +
    `<script>(function(){var I=${jsonForScript(items)};Array.prototype.forEach.call(document.querySelectorAll(".save"),function(a){a.addEventListener("click",function(ev){` +
    `var it=I[+a.getAttribute("data-i")];if(!window.fetch||!window.File)return;ev.preventDefault();fetch(it.url).then(function(r){return r.blob();}).then(function(b){` +
    `var f=new File([b],it.name,{type:b.type||"image/jpeg"});if(navigator.canShare&&navigator.canShare({files:[f]})){return navigator.share({files:[f]}).catch(function(){});}` +
    `var u=URL.createObjectURL(b),d=document.createElement("a");d.href=u;d.download=it.name;document.body.appendChild(d);d.click();d.remove();setTimeout(function(){URL.revokeObjectURL(u);},4000);` +
    `}).catch(function(){window.open(it.url,"_blank");});});});})();</script></body></html>`;
}

const jsonForScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c");   // safe inside <script> (ES2019+ allows U+2028/2029 in strings)

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
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title>` +
    `<meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no">` +
    `<style>body{-webkit-text-size-adjust:100%;text-size-adjust:100%}</style>` +
    `</head>` +
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

  // Guide app photos (ride_media): the exact Drive file per departure / booking. Table missing → name matching only.
  let media = [];
  const avails = [...new Set(plan.recaps.flatMap(rc => rc.bookings.map(b => b.availabilityPk)).filter(Boolean))];
  if (avails.length) {
    try {
      const { data, error: mErr } = await crm.from("ride_media").select("*").eq("client_id", clientId).in("availability_pk", avails);
      if (!mErr) media = data ?? [];
    } catch { media = []; }
  }
  const weatherByDate = new Map(), stormByPoint = new Map();
  const simple = s.template === "simple";
  const exp = plan.recaps.length ? await loadExperimentStats(crm, { clientId, nowMs: new Date(now).getTime(), template: s.template }) : { stats: {} };
  for (const rc of plan.recaps) {
    const date = localDate(rc.primary.startAt ?? rc.primary.endAt, s.timezone);
    const pt = weatherPointFor({ item: rc.primary.item, type: rc.tour.type }, s);
    const wKey = pt ? `${date}|${pt.lat}|${pt.lon}` : null;
    if (!simple && wKey && !weatherByDate.has(wKey)) weatherByDate.set(wKey, await fetchRecapWeather({ lat: pt.lat, lon: pt.lon, date, fetchImpl }));
    const weather = !simple && wKey ? weatherByDate.get(wKey) : null;
    const unsubscribeUrl = out.preview ? null : await unsubscribeUrlFor(crm, rc.email, baseUrl);
    const trip = buildTripDetails({ booking: rc.primary, tour: rc.tour });
    const tagged = pickRideMediaForBooking(media, rc.primary);
    if (tagged) trip.photo = String(tagged.drive_file_id);
    const variants = chooseVariants({ seed: rc.primary.pk, stats: exp.stats, modes: s.experiments });
    let data, msg;
    if (simple) {
      // "Next storm" (CSR only): a live forecast fetched now, from the ride's weather point. None → the line is hidden.
      let nextStorm = null;
      if (rc.tour.type !== "rea" && pt) {
        const sKey = `${pt.lat}|${pt.lon}`;
        if (!stormByPoint.has(sKey)) stormByPoint.set(sKey, await fetchNextStorm({ lat: pt.lat, lon: pt.lon, fromYmd: localDate(now, s.timezone), fetchImpl }));
        nextStorm = stormByPoint.get(sKey);
      }
      data = buildSimpleRecapData({ booking: rc.primary, tour: rc.tour, trip, settings: s, nextStorm, unsubscribeUrl, baseUrl, variants });
      msg = renderSimpleRecap(data);
    } else {
      data = buildRecapData({ booking: rc.primary, tour: rc.tour, trip, settings: s, weather, pax: rc.pax, unsubscribeUrl, baseUrl, variants });
      msg = renderRideRecap(data);
    }
    // season "winter": every recap ride is on snow, so the photo matcher refuses summer/RZR/UTV files (both templates).
    const photoHint = data.photo === false ? null : buildPhotoHint({ label: rc.tour.label, startAt: rc.primary.startAt ?? rc.primary.endAt,
      fileId: typeof data.photo === "string" ? data.photo : null, season: "winter", hosted: simple });
    if (simple && photoHint && data.mapUrl) photoHint.map_url = data.mapUrl;   // the upload adds the map to the photo row
    const loggedVariants = simple ? { ...data.variants, template: "simple" } : data.variants;
    const to = s.dry_run ? s.test_to : rc.email;
    const summary = { booking_id: rc.primary.pk, bookings: rc.bookings.map(b => b.pk), email: rc.email, to, type: rc.tour.type, subject: (s.dry_run ? "[TEST] " : "") + msg.subject, photo_hint: photoHint, weather: !!weather, variants: loggedVariants, template: s.template };
    out.recaps.push(summary);
    if (out.preview) continue;

    // queue first (idempotent), then log — a crash between the two re-runs into the idempotency key, never a 2nd email
    const q = await queueRecapEmail(crm, { clientId, to, subject: msg.subject, html: msg.html, text: msg.text, fromName: msg.fromName, photoHint,
      reference: rc.primary.pk, idempotencyKey: `recap-${rc.primary.pk}`, dryRun: s.dry_run });
    const logRows = rc.bookings.map(b => ({
      booking_id: b.pk, client_id: clientId, email: rc.email, sent_to: to, type: rc.tour.type, send_id: q.row.id,
      primary_booking_id: rc.primary.pk, dry_run: s.dry_run, weather: !!weather, queued_at: new Date(now).toISOString(), variants: loggedVariants,
    }));
    let { error: lgErr } = await crm.from("recap_log").upsert(logRows, { onConflict: "booking_id", ignoreDuplicates: true });
    if (lgErr && /variants/i.test(lgErr.message)) {   // db2_ride_recap_ab.sql not applied yet → log without the variant
      ({ error: lgErr } = await crm.from("recap_log").upsert(logRows.map(({ variants: _v, ...r }) => r), { onConflict: "booking_id", ignoreDuplicates: true }));
    }
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
    // PLACEHOLDER route art so previews show the route card; real recaps only get a route when a real one exists.
    if (full && type !== "rental") trip.routeImage = `https://highmark-bot-production.up.railway.app/r/route/${type}-placeholder.png`;
    return buildRecapData({ booking, tour, trip: full ? trip : { ...trip, photo: false }, settings, weather: full ? wx : null, pax: booking.pax,
      unsubscribeUrl: "https://highmark-bot-production.up.railway.app/email/unsubscribe/00000000-0000-4000-8000-000000000000", baseUrl: "https://highmark-bot-production.up.railway.app" });
  };
  return {
    "rea-full": mk("rea", "Grand Tour", true), "rea-missing": mk("rea", "Grand Tour", false),
    "backcountry-full": mk("backcountry", "Private Guided Backcountry", true), "backcountry-missing": mk("backcountry", "Private Guided Backcountry", false),
    "rental-full": mk("rental", "Polaris rental", true), "rental-missing": mk("rental", "Polaris rental", false),
  };
}
