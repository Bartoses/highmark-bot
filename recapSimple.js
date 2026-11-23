// ─────────────────────────────────────────────────────────────────────────────
// RIDE RECAP — "simple" template (sprint: sprint-ride-recap-v2-simple.md; design: canvas page "Simple v2")
//
// Behind recap_settings.template: 'v1' (default — rideRecap.js renderRideRecap, unchanged) | 'simple' (this file).
// One photo, one stat line, one ask per section. Table-based, inline styles, max-width 600, no flex/grid, no emoji.
//
// Photos are HOSTED, never attached: the Apps Script finds the ride photo in Drive (strict match, rideMedia.js) and
// uploads it (POST /api/v1/recaps/photo → handleRecapPhotoUpload). The bot resizes it, stores it in the public
// Supabase Storage bucket recap-photos (<YYYY-MM-DD>/<booking id>*.jpg) and fills the photo blocks of the queued email.
// The stored HTML carries both versions:
//   <!--RR_PHOTO--> … <!--/RR_PHOTO-->      hero photo + "Your photos are ready" (tokens __RR_HERO__ __RR_FULL__ __RR_T1..3__)
//   <!--RR_NOPHOTO--> … <!--/RR_NOPHOTO-->  the REA loop's route map (or nothing)
// applyHostedPhotos() keeps exactly one of them (emailSender.renderRecapRow runs it at pull time). An Apps Script that
// doesn't know about hosted photos therefore still sends a correct no-photo email.
//
// Data honesty: every number shown comes from recap_tours (miles, high point), the booking (hours) or a live forecast
// fetched that day (Open-Meteo, "Next storm"). Nothing missing is ever printed; there is no "Ride #N" (no booking
// history source yet) and no snow-depth stat (no confirmed live station source yet).
// ─────────────────────────────────────────────────────────────────────────────
import {
  RECAP_BRANDS, RECAP_LINKS, RECAP_PHONE, RECAP_SOCIAL, trackLink, cleanFirstName, hoursLabel, localDate,
  normalizeRecapSettings, normalizeVariants, questionSubject, sharePageUrl, shareMessage, renderRideRecap,
  variantTerm, rideLinkSig, photosPageUrl,
} from "./rideRecap.js";
import { escapeHtml } from "./emailTemplates.js";
import { resolveBaseUrl } from "./emailSender.js";
import crypto from "crypto";
import { isStrictPhotoMatch, applyHostedPhotos } from "./rideMedia.js";

export const RECAP_TEMPLATES = ["v1", "simple"];
export const PHOTO_BUCKET = "recap-photos";
export const MAP_BUCKET = "recap-maps";
const DEFAULT_STORAGE_BASE = "https://aiiguzslqiemksrvfvwk.supabase.co";

export const normalizeTemplate = (t) => (RECAP_TEMPLATES.includes(String(t ?? "").trim().toLowerCase()) ? String(t).trim().toLowerCase() : "v1");

export function storagePublicUrl(bucket, path, base = process.env.CRM_SUPABASE_URL || DEFAULT_STORAGE_BASE) {
  return `${String(base).replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${String(path).split("/").map(encodeURIComponent).join("/")}`;
}
export const tourSlug = (label) => String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ── brand look (spec "Typography and colors") ────────────────────────────────
const LOOK = {
  csr: {
    headBg: "#FFFFFF", logoH: 40, ink: "#0B2D4F", dark: "#06121F", btn: "#1670C2", btnTxt: "#FFFFFF", acc: "#D9A24E", kicker: "#8A5A12",
    link: "#1670C2", head: "Roboto,Arial,Helvetica,sans-serif", up: "none", h1: "700 32px/1.1", h2: "700 22px/1.15", stat: "700 26px/1",
    gearTop: "STEAMBOAT<br>CO",
  },
  rea: {
    headBg: "#0E131B", logoH: 30, ink: "#0E131B", dark: "#0E131B", btn: "#F99E16", btnTxt: "#0E131B", acc: "#00B4E6", kicker: "#00799C",
    link: "#00799C", head: "'Bebas Neue',Impact,Arial,sans-serif", up: "uppercase", h1: "400 44px/1.05", h2: "400 28px/1.1", stat: "400 30px/1",
    gearTop: "RABBIT<br>EARS",
  },
};
const MUTED = "#4A5560", SUBTLE = "#6B7680", RULE = "#E3E6EA", FOOT_BG = "#F4F6F8";
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const thousands = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// ── stat line: up to 3 items (miles · high point · hours); fewer than 2 → hidden ──
export function buildStatLine({ miles, highPointFt, startAt, endAt }) {
  const out = [];
  if (Number(miles) > 0) out.push([`${Number(miles)} mi`, "RIDDEN"]);
  if (Number(highPointFt) > 0) out.push([`${thousands(highPointFt)}′`, "HIGH POINT"]);
  const h = hoursLabel(startAt, endAt);
  if (h) out.push([h, "ON SNOW"]);
  return out.length >= 2 ? out.slice(0, 3) : [];
}

// ── "Next storm" (CSR only): live Open-Meteo forecast fetched that day. ≥3″ in the next 7 days, else null (line hidden). ──
export const STORM_MIN_INCHES = 3;
export function nextStormFromDaily(daily, fromYmd) {
  const days = daily?.time ?? [], snow = daily?.snowfall_sum ?? [];
  let best = null;
  for (let i = 0; i < days.length; i++) {
    const d = String(days[i]), inches = Number(snow[i]);
    if (!(d > String(fromYmd)) || !Number.isFinite(inches) || inches < STORM_MIN_INCHES) continue;
    if (!best || inches > best.inches) best = { date: d, inches };
  }
  if (!best) return null;
  const [y, m, dd] = best.date.split("-").map(Number);
  return { date: best.date, inches: Math.round(best.inches), day: DAY_LONG[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()], source: "Open-Meteo forecast" };
}
export async function fetchNextStorm({ lat, lon, fromYmd, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (lat == null || lon == null || !fromYmd || !fetchImpl) return null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=snowfall_sum&precipitation_unit=inch` +
      `&timezone=America%2FDenver&forecast_days=8`;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetchImpl(u, ctl ? { signal: ctl.signal } : undefined).finally(() => t && clearTimeout(t));
    if (!res?.ok) return null;
    return nextStormFromDaily((await res.json())?.daily, fromYmd);
  } catch { return null; }                                            // never block a send on a forecast
}

// ── data (pure) ──────────────────────────────────────────────────────────────
// booking: bookingFacts(). trip: buildTripDetails(). tour: matchTour() row (map_url optional). nextStorm: fetchNextStorm() | null.
// linkSecret: signs the share / photos links (rideLinkSig) so those pages may show the guest's own photo. Default = env.
export function buildSimpleRecapData({ booking, tour, trip, settings, nextStorm = null, unsubscribeUrl = null, baseUrl = resolveBaseUrl(), variants = null, linkSecret = undefined }) {
  const s = normalizeRecapSettings(settings);
  const type = tour.type, rea = type === "rea";
  const brand = RECAP_BRANDS[rea ? "rea" : "csr"];
  const first = cleanFirstName(booking.name);
  const guide = String(trip?.guide ?? "").trim();
  const start = booking.startAt ?? booking.endAt;
  const ymd = start ? localDate(start, s.timezone) : null;
  const [yy, mm, dd] = ymd ? ymd.split("-").map(Number) : [];
  const kicker = [ymd ? `${DOW[new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()]} · ${MON[mm - 1]} ${dd}` : "", tour.label.toUpperCase()].filter(Boolean).join(" · ");
  const withGuide = guide ? ` with guide ${guide}` : "";
  const h1 = !first ? "Thanks for riding with us." : {
    rea: `${first}, that’s a memory in the making.`, backcountry: `${first}, you went deep into the backcountry.`, rental: `${first}, thanks for riding with CSR.`,
  }[type];
  const sub = {
    rea: `Your ${tour.label} through North Routt’s meadows and forest trails${withGuide}.`,
    backcountry: `A day off the groomers${withGuide}.`,
    rental: "Brand-new Polaris sleds and a day on your own terms.",
  }[type];
  const storm = !rea && nextStorm && Number(nextStorm.inches) >= STORM_MIN_INCHES && nextStorm.day ? nextStorm : null;
  const next = rea
    ? (/sunset/i.test(tour.label)   // they just did the Sunset Ride: don't pitch it back to them
      ? { title: "Come back in daylight", body: "See the meadows and forest trails in full sun on a daytime tour.", cta: "Book a daytime tour", url: RECAP_LINKS.book.rea }
      : { title: "Come back for sunset", body: "The 3-Hour Sunset Ride shows the mountains in a whole new light.", cta: "Book a sunset ride", url: RECAP_LINKS.book.rea })
    : storm
      ? { title: `Next storm: ~${storm.inches}″ ${storm.day}`, body: "Powder days fill up first. Grab your sleds before they’re gone.", cta: "Book your next ride",
          url: type === "backcountry" ? RECAP_LINKS.book.guided : RECAP_LINKS.book.csr }
      : { title: "Ready for your next ride?", body: type === "backcountry" ? "Big storm days fill up first. Book your next backcountry day early." : "The best snow days fill up first. Lock in your sleds early.",
          cta: "Book your next ride", url: type === "backcountry" ? RECAP_LINKS.book.guided : RECAP_LINKS.book.csr };
  const v = normalizeVariants(variants);
  const share = shareMessage({ bookingId: booking.bookingId, type, settings: s });
  const sig = rideLinkSig(booking.bookingId, ...(linkSecret !== undefined ? [linkSecret] : []));
  const subjects = { rea: "Your Rabbit Ears tour recap", backcountry: "Your backcountry day, recapped", rental: "Thanks for riding with CSR" };
  const photo = trip?.photo === false ? false : (typeof trip?.photo === "string" && trip.photo ? trip.photo : null);   // string = Drive file id (Guide app)
  return {
    template: "simple", type, brand, look: LOOK[brand.key], first, kicker, h1, sub,
    stats: buildStatLine({ miles: trip?.miles, highPointFt: trip?.high_point_ft, startAt: booking.startAt, endAt: booking.endAt }),
    photo, label: tour.label, date: ymd,
    // the route map is the hero of a REA recap without a photo; any other recap without a photo has no hero
    mapUrl: rea && /^https:\/\//.test(String(tour.map_url ?? "")) ? String(tour.map_url) : null,
    features: s.features, friendCode: s.friend_code, friendPercent: s.friend_percent, bookingId: booking.bookingId,
    reviewUrl: RECAP_LINKS.review[brand.key], next, nextStorm: storm,
    sharePageUrl: sharePageUrl(baseUrl, { bookingId: booking.bookingId, type, sig }),
    // "See & download photos" → the signed /r/photos page (photo + loop map, from the DB); no secret → the photo file itself
    photosUrl: sig ? photosPageUrl(baseUrl, { bookingId: booking.bookingId, type, sig }) : null,
    shareMailto: `mailto:?subject=${encodeURIComponent(`${s.friend_percent}% off at ${brand.name}`)}&body=${encodeURIComponent(share.text)}`,
    unsubscribeUrl, variants: v,
    subject: v.subject === "B" ? questionSubject({ type, first, label: tour.label }) : subjects[type] + (first ? `, ${first}` : ""),
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────
export function renderSimpleRecap(d) {
  const C = d.brand, L = d.look, e = escapeHtml, has = (f) => d.features.includes(f);
  // utm_term = the A/B arms + ".simple", so clicks are credited to the right version of the right template
  const link = (base, content, friend = false) => trackLink(base, { type: d.type, content, friendRef: friend ? d.bookingId : null, term: `${variantTerm(d.variants)}.simple` });
  const font = "Arial,Helvetica,sans-serif";
  const h2 = (t) => `<h2 style="margin:0 0 12px;font:${L.h2} ${L.head};text-transform:${L.up};color:${L.ink}">${t}</h2>`;
  const p = (t, color = MUTED) => `<p style="margin:0 0 16px;font:16px/1.5 ${font};color:${color}">${t}</p>`;
  const btn = (text, href, { bg = L.btn, color = L.btnTxt, border = null } = {}) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${bg}" style="border-radius:10px;background:${bg};${border ? `border:2px solid ${border};` : ""}">` +
    `<a href="${attr(href)}" style="display:block;padding:14px 16px;font:700 16px/20px ${font};color:${color};text-decoration:none;mso-line-height-rule:exactly">${text}</a></td></tr></table>`;
  const section = (inner) => `<tr><td style="padding:28px 24px">${inner}</td></tr>`;
  const rule = `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" style="height:1px;line-height:1px;font-size:1px;background:${RULE}">&nbsp;</td></tr></table></td></tr>`;

  let rows = "";
  // 1. header: logo only
  rows += `<tr><td style="background:${L.headBg};padding:16px 24px"><img src="${attr(C.logo)}" height="${L.logoH}" alt="${e(C.name)}" style="display:block;border:0;height:${L.logoH}px;width:auto"></td></tr>`;
  // 2. hero: hosted photo (filled at pull time) | REA route map | nothing
  const alt = e(`Photo from your ${d.label}`);
  if (d.photo !== false) rows += `<!--RR_PHOTO--><tr><td style="padding:0"><img src="__RR_HERO__" width="600" alt="${alt}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr><!--/RR_PHOTO-->`;
  rows += "<!--RR_NOPHOTO-->" + (d.mapUrl
    ? `<tr><td style="padding:0"><img src="${attr(d.mapUrl)}" width="600" alt="${e(`Illustrated map of your ${d.label} loop`)}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>`
    : "") + "<!--/RR_NOPHOTO-->";
  // 3. kicker + headline + one sentence
  rows += `<tr><td style="padding:24px 24px 20px">` +
    `<div style="font:700 12px/1.4 ${font};letter-spacing:2px;color:${L.kicker};margin:0 0 12px">${e(d.kicker)}</div>` +
    `<h1 style="margin:0 0 12px;font:${L.h1} ${L.head};letter-spacing:${C.key === "rea" ? "0.5px" : "0"};text-transform:${L.up};color:${L.ink}">${e(d.h1)}</h1>` +
    `<p style="margin:0;font:16px/1.5 ${font};color:${MUTED}">${e(d.sub)}</p></td></tr>`;
  // A/B "layout": A = review after the photos (below), B = review right after the headline
  const feedback = `mailto:${RECAP_LINKS.infoEmail}?subject=${encodeURIComponent(`Feedback on my ride (#${d.bookingId})`)}`;
  const review = () => section(h2("Had a good day?") + p("A quick Google review helps our small local crew more than anything.") +
    btn("Leave a review", link(d.reviewUrl, "google-review"), { bg: "#FFFFFF", color: L.ink, border: L.ink }) +
    `<div style="text-align:center;padding:14px 0 0"><a href="${attr(feedback)}" style="font:14px/20px ${font};color:${L.link}">Something not right? Tell us directly</a></div>`);
  if (d.variants.layout === "B") rows += review() + rule;
  // 4. one stat line between two thin rules (hidden with fewer than 2 items)
  if (d.stats.length >= 2) {
    const w = Math.floor(100 / d.stats.length);
    rows += `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE}"><tr>` +
      d.stats.map(([val, lab]) => `<td width="${w}%" valign="top" style="padding:16px 6px 16px 0"><div style="font:${L.stat} ${L.head};text-transform:${L.up};color:${L.ink}">${e(val)}</div>` +
        `<div style="font:12px/1.4 ${font};letter-spacing:0.5px;color:${SUBTLE};margin-top:4px">${e(lab)}</div></td>`).join("") +
      `</tr></table></td></tr>`;
  }
  // 5. "Your photos are ready" — only with a photo
  if (d.photo !== false) {
    const thumb = (tok) => `<td width="33%" valign="top" style="padding:0 3px"><img src="${tok}" width="180" alt="${alt}" style="display:block;width:100%;max-width:180px;height:auto;border:0;border-radius:8px"></td>`;
    rows += `<!--RR_PHOTO-->` + section(h2("Your photos are ready") +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px"><tr>${thumb("__RR_T1__")}${thumb("__RR_T2__")}${thumb("__RR_T3__")}</tr></table>` +
      btn("See &amp; download photos", d.photosUrl ? link(d.photosUrl, "see-photos") : "__RR_FULL__")) + rule + `<!--/RR_PHOTO-->`;
  }
  // 6. "Had a good day?" — every guest (no review gating)
  if (d.variants.layout !== "B") rows += review();
  // 7. "Bring a friend" dark card
  if (has("share")) {
    const pct = d.friendPercent, code = e(d.friendCode);
    rows += `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${L.dark}" style="background:${L.dark};border-radius:12px;padding:20px">` +
      `<div style="font:700 12px/1.4 ${font};letter-spacing:2px;color:${L.acc};margin:0 0 10px">BRING A FRIEND</div>` +
      `<p style="margin:0 0 16px;font:16px/1.5 ${font};color:#D5DCE3">Friends save ${pct}% with code <b style="color:#FFFFFF;letter-spacing:1px">${code}</b>. When they ride, you get ${pct}% off your next one.</p>` +
      btn(d.variants.share_cta === "B" ? `Give a friend ${pct}% off` : "Share the code", link(d.sharePageUrl, "share-sms"), { bg: "#FFFFFF", color: L.dark }) +
      `<div style="text-align:center;padding:12px 0 0"><a href="${attr(d.shareMailto)}" style="font:14px/20px ${font};color:#D5DCE3">Or email it to a friend</a></div>` +
      `<div style="border-top:1px solid #2A3644;margin:18px 0 0;padding:16px 0 0;text-align:center">` +
      `<a href="${attr(link(`${d.sharePageUrl}#ride`, "share-social"))}" style="font:700 15px/20px ${font};color:#FFFFFF">Post your ride on Instagram</a></div>` +
      `</td></tr></table></td></tr>`;
  }
  // 8. "Gear from your ride" — only with merch on
  if (has("merch")) {
    const ds = d.date ? `${d.date.slice(5, 7)}.${d.date.slice(8, 10)}.${d.date.slice(2, 4)}` : "";
    const tile = (name, content) => `<td width="50%" valign="top" style="padding:0 6px"><a href="${attr(link(RECAP_LINKS.merch, content))}" style="text-decoration:none;color:${L.ink}">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${L.dark}" height="132" style="background:${L.dark};border-radius:10px;height:132px;color:#FFFFFF">` +
      `<div style="font:${C.key === "rea" ? "400 18px" : "700 18px"}/1 ${L.head};color:#FFFFFF">${L.gearTop}</div>` +
      `<div style="width:28px;height:2px;line-height:2px;font-size:2px;background:${L.acc};margin:6px auto">&nbsp;</div>` +
      (ds ? `<div style="font:700 10px/1 ${font};letter-spacing:1px;color:#FFFFFF">${ds}</div>` : "") +
      `</td></tr></table><div style="font:700 14px/1.4 ${font};color:${L.ink};padding-top:8px">${name}</div></a></td>`;
    rows += section(h2("Gear from your ride") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tile("Ride hoodie", "merch-hoodie")}${tile("Trucker hat", "merch-hat")}</tr></table>`);
  }
  // 9. book again
  rows += rule + section(h2(e(d.next.title)) + p(e(d.next.body)) + btn(e(d.next.cta), link(d.next.url, "book-next")));
  // 9b. stay in the loop: newsletter (when on) + follow us as real buttons
  const half = (label, href) => `<td width="50%" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${L.dark}" style="border-radius:10px;background:${L.dark}">` +
    `<a href="${attr(href)}" style="display:block;padding:14px 8px;font:700 16px/20px ${font};color:#FFFFFF;text-decoration:none">${label}</a></td></tr></table></td>`;
  rows += rule + section(h2("Stay in the loop") +
    p(has("newsletter") ? "Storm alerts, new adventures and first dibs on powder days." : "Powder days, new trails and ride photos from the crew.") +
    (has("newsletter") ? btn("Join the newsletter", link(RECAP_LINKS.newsletter, "newsletter"), { bg: "#FFFFFF", color: L.ink, border: L.ink }) + `<div style="height:10px;line-height:10px;font-size:10px">&nbsp;</div>` : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0"><tr>` +
    half("Instagram", link(RECAP_LINKS.instagram, "follow-instagram")) + half("Facebook", link(RECAP_LINKS.facebook, "follow-facebook")) + `</tr></table>`);
  // 10. footer — CAN-SPAM: physical address + working unsubscribe
  const unsub = d.unsubscribeUrl || `mailto:${RECAP_LINKS.infoEmail}?subject=Unsubscribe`;
  rows += `<tr><td bgcolor="${FOOT_BG}" style="background:${FOOT_BG};padding:24px;font:12px/1.7 ${font};color:${SUBTLE};text-align:center">` +
    C.footer.map(e).join(" · ") + `<br>${RECAP_PHONE} · ${RECAP_SOCIAL}<br>` +
    `<a href="${attr(link(RECAP_LINKS.newsletter, "newsletter"))}" style="color:${SUBTLE}">Newsletter</a> · ` +
    `<a href="${attr(unsub)}" data-notrack style="color:${SUBTLE}">Unsubscribe</a></td></tr>`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,address=no,email=no,date=no">` +
    `<title>${e(d.subject)}</title><style>body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%}a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}</style>` +
    (C.key === "rea" ? `<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&amp;display=swap" rel="stylesheet">` : `<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&amp;display=swap" rel="stylesheet">`) +
    `</head><body style="margin:0;padding:0;background:#FFFFFF"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF">${rows}</table></td></tr></table></body></html>`;
  return { subject: d.subject, html, text: renderSimpleRecapText(d), fromName: C.name, brand: C.key, type: d.type, template: "simple" };
}

export function renderSimpleRecapText(d) {
  const C = d.brand, has = (f) => d.features.includes(f), link = (b, c) => trackLink(b, { type: d.type, content: c });
  const out = [d.kicker, "", d.h1, d.sub];
  if (d.stats.length >= 2) out.push("", d.stats.map(([v, l]) => `${v} ${l.toLowerCase()}`).join(" · "));
  out.push("", `Had a good day? Leave us a Google review: ${link(d.reviewUrl, "google-review")}`, `Something not right? Tell us directly: ${RECAP_LINKS.infoEmail}`);
  if (has("share")) out.push("", `Bring a friend: friends save ${d.friendPercent}% with code ${d.friendCode}. Share it: ${link(d.sharePageUrl, "share-sms")}`,
    `Post your ride on Instagram: ${link(`${d.sharePageUrl}#ride`, "share-social")}`);
  if (has("merch")) out.push("", `Gear from your ride: ${link(RECAP_LINKS.merch, "merch-hoodie")}`);
  out.push("", `${d.next.title}. ${d.next.body} ${link(d.next.url, "book-next")}`);
  out.push("", "—", `Follow us: ${RECAP_LINKS.instagram} · ${RECAP_LINKS.facebook}`, ...C.footer, `${RECAP_PHONE} · ${RECAP_SOCIAL}`, `Newsletter: ${link(RECAP_LINKS.newsletter, "newsletter")}`,
    `Unsubscribe: ${d.unsubscribeUrl || `email ${RECAP_LINKS.infoEmail} with the subject "Unsubscribe"`}`);
  return out.join("\n");
}

// One entry point for both templates (runRideRecap / previews).
export function renderRecapForTemplate(template, data) {
  return normalizeTemplate(template) === "simple" ? renderSimpleRecap(data) : renderRideRecap(data);
}

// ── hosted photos ────────────────────────────────────────────────────────────
// applyHostedPhotos lives in rideMedia.js (a leaf module emailSender can import without a cycle).
export { applyHostedPhotos };

// Resize one Drive photo into the hosted set. 1200px-wide JPEG q75 (target < 250 KB) for download, a 1200×900 hero
// cropped ~35% from the top (≈300 px tall on a phone), and 3 small crops for the "Your photos are ready" row.
export const PHOTO_SPEC = { width: 1200, heroHeight: 900, thumbW: 400, thumbH: 300, quality: 75, maxBytes: 250 * 1024, maxUploadBytes: 15 * 1024 * 1024 };
async function loadSharp() { try { return (await import("sharp")).default; } catch { return null; } }
// mapBuf (optional, REA): the loop's route map becomes the 3rd thumbnail, so the photo row shows the photo AND the map.
export async function processRidePhoto(buf, { sharpImpl, mapBuf = null } = {}) {
  const sharp = sharpImpl ?? await loadSharp();
  if (!sharp) throw new Error("image processing unavailable (sharp not installed)");
  const jpeg = async (img, q = PHOTO_SPEC.quality) => img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
  const base = sharp(buf, { failOn: "error" }).rotate();                // honor EXIF orientation
  let full = await jpeg(base.clone().resize({ width: PHOTO_SPEC.width, withoutEnlargement: true }));
  for (const q of [65, 55]) if (full.length > PHOTO_SPEC.maxBytes) full = await jpeg(sharp(full).resize({ width: PHOTO_SPEC.width, withoutEnlargement: true }), q);
  const meta = await sharp(full).metadata();
  const crop = async (w, h, pos) => {
    const scale = Math.max(w / meta.width, h / meta.height);
    const sw = Math.round(meta.width * scale), sh = Math.round(meta.height * scale);
    const img = sharp(full).resize(sw, sh).extract({ left: Math.max(0, Math.round((sw - w) / 2)), top: Math.max(0, Math.round((sh - h) * pos)), width: Math.min(w, sw), height: Math.min(h, sh) });
    return jpeg(img);
  };
  let mapThumb = null;
  if (mapBuf) {
    try { mapThumb = await jpeg(sharp(mapBuf).resize(PHOTO_SPEC.thumbW, PHOTO_SPEC.thumbH, { fit: "cover", position: "centre" }).flatten({ background: "#F1EDE2" })); }
    catch { mapThumb = null; }                                         // a bad map never costs the guest their photo
  }
  return {
    full, hero: await crop(PHOTO_SPEC.width, PHOTO_SPEC.heroHeight, 0.35),
    thumbs: [await crop(PHOTO_SPEC.thumbW, PHOTO_SPEC.thumbH, 0.15), await crop(PHOTO_SPEC.thumbW, PHOTO_SPEC.thumbH, mapThumb ? 0.7 : 0.55),
      mapThumb ?? await crop(PHOTO_SPEC.thumbW, PHOTO_SPEC.thumbH, 0.85)],
  };
}

// <YYYY-MM-DD>/<booking id>-<random>: the bucket is public, so a random part keeps guest photos from being found by
// guessing booking ids (FareHarbor ids are sequential). The URLs are stored on the send row.
export const photoBasePath = (date, bookingRef, token = "") => `${date}/${String(bookingRef ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "ride"}${token ? `-${token}` : ""}`;

export async function uploadRidePhotos(crm, { date, bookingRef, set, token = crypto.randomBytes(6).toString("hex") }) {
  const base = photoBasePath(date, bookingRef, token);
  const files = [[`${base}.jpg`, set.full], [`${base}-hero.jpg`, set.hero], ...set.thumbs.map((b, i) => [`${base}-t${i + 1}.jpg`, b])];
  for (const [path, body] of files) {
    const { error } = await crm.storage.from(PHOTO_BUCKET).upload(path, body, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    if (error) throw new Error(`photo upload failed (${path}): ${error.message}`);
  }
  const url = (p) => storagePublicUrl(PHOTO_BUCKET, p);
  return { full: url(files[0][0]), hero: url(files[1][0]), thumbs: files.slice(2).map(f => url(f[0])) };
}

// POST /api/v1/recaps/photo { send_id, folder_date, file_name, content_type, data (base64) }
// → { html, text, photo_url } — the finished email (tracking included) with the photo filled in. Called by the Apps Script
// for a simple-template recap it has just pulled. Refuses anything that isn't a strict match for that ride.
async function fetchMap(url, fetchImpl) {
  try { const r = await fetchImpl(url); return r?.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; }
}
export async function handleRecapPhotoUpload(crm, body, { render, process: proc = processRidePhoto, upload = uploadRidePhotos, fetchImpl = globalThis.fetch } = {}) {
  const b = body ?? {};
  if (!b.send_id || !b.data) return { status: 400, body: { error: "send_id and data are required" } };
  const { data: row, error } = await crm.from("email_sends").select("*").eq("id", b.send_id).maybeSingle();
  if (error) return { status: 500, body: { error: "lookup failed" } };
  if (!row || row.category !== "recap") return { status: 404, body: { error: "recap send not found" } };
  if (!["sending", "queued"].includes(row.status)) return { status: 409, body: { error: `send is ${row.status}` } };
  const hint = typeof row.photo_hint === "string" ? (() => { try { return JSON.parse(row.photo_hint); } catch { return null; } })() : row.photo_hint;
  if (!hint?.hosted) return { status: 409, body: { error: "this recap does not use hosted photos" } };
  if (!isStrictPhotoMatch({ folderDate: b.folder_date, fileName: b.file_name, fileId: b.file_id ?? null }, hint)) return { status: 422, body: { error: "photo_mismatch" } };
  if (!/^image\/(jpeg|png)$/i.test(String(b.content_type ?? "image/jpeg"))) return { status: 415, body: { error: "JPEG or PNG only" } };
  const buf = Buffer.from(String(b.data), "base64");
  if (!buf.length || buf.length > PHOTO_SPEC.maxUploadBytes) return { status: 413, body: { error: "photo empty or too large" } };
  let set;
  const mapBuf = /^https:\/\//.test(String(hint.map_url ?? "")) && fetchImpl ? await fetchMap(hint.map_url, fetchImpl) : null;
  try { set = await proc(buf, { mapBuf }); } catch (e) { return { status: 422, body: { error: `not a usable image: ${e.message}` } }; }
  const photos = await upload(crm, { date: hint.date, bookingRef: row.reference, set });
  const newHint = { ...hint, hosted_photo: photos };
  const { error: uErr } = await crm.from("email_sends").update({ photo_hint: newHint }).eq("id", row.id);
  if (uErr) return { status: 500, body: { error: "could not save the photo on the send" } };
  const item = render({ ...row, photo_hint: newHint });
  return { status: 200, body: { html: item.html, text: item.text, photo_url: photos.full } };
}

// ── fixed renders for snapshots + previews (6 cases from the sprint) ─────────
export const SAMPLE_PHOTOS = Object.freeze({
  full: storagePublicUrl(PHOTO_BUCKET, "samples/ride-sample.jpg", DEFAULT_STORAGE_BASE),
  hero: storagePublicUrl(PHOTO_BUCKET, "samples/ride-sample-hero.jpg", DEFAULT_STORAGE_BASE),
  thumbs: [1, 2, 3].map(i => storagePublicUrl(PHOTO_BUCKET, `samples/ride-sample-t${i}.jpg`, DEFAULT_STORAGE_BASE)),
});
// REA with a map: the photo row is photo, photo, map (what processRidePhoto makes when the tour has map_url)
export const SAMPLE_PHOTOS_REA = Object.freeze({ ...SAMPLE_PHOTOS, thumbs: [SAMPLE_PHOTOS.thumbs[0],
  storagePublicUrl(PHOTO_BUCKET, "samples/ride-sample-t2b.jpg", DEFAULT_STORAGE_BASE), storagePublicUrl(PHOTO_BUCKET, "samples/rea-map-thumb.jpg", DEFAULT_STORAGE_BASE)] });
export const GRAND_TOUR_MAP_URL = storagePublicUrl(MAP_BUCKET, "grand-tour.png", DEFAULT_STORAGE_BASE);

// → { name: { data, photos } }. photos = what the Apps Script would have uploaded (null = no photo found).
export function sampleSimpleRenders() {
  const base = "https://highmark-bot-production.up.railway.app";
  const settings = { features: ["review", "share", "merch", "newsletter"] };
  const booking = (full) => ({ bookingId: "392519085", pk: "#392519085", name: full ? "katrina schultz" : "Guest", startAt: "2027-01-29T18:00:00Z", endAt: "2027-01-29T21:00:00Z", pax: 3, guide: full ? "Jake" : "" });
  const mk = ({ type, label, full = true, map = null, storm = null, features = settings.features }) => {
    const tour = { type, label, miles: full ? (type === "rea" ? 24 : 22) : null, high_point_ft: full ? (type === "rea" ? 9880 : 10340) : null, map_url: map };
    const bk = booking(full);
    return buildSimpleRecapData({ booking: bk, tour, trip: { guide: bk.guide, miles: tour.miles, high_point_ft: tour.high_point_ft, photo: null },
      settings: { features }, nextStorm: storm, baseUrl: base, linkSecret: "sample-link-secret-0123456789",
      unsubscribeUrl: `${base}/email/unsubscribe/00000000-0000-4000-8000-000000000000` });
  };
  const storm = { date: "2027-02-04", inches: 9, day: "Thursday", source: "Open-Meteo forecast" };
  return {
    "simple-csr-full": { data: mk({ type: "rental", label: "Polaris rental", storm }), photos: SAMPLE_PHOTOS },
    "simple-csr-nophoto": { data: mk({ type: "rental", label: "Polaris rental", storm }), photos: null },
    "simple-rea-photo": { data: mk({ type: "rea", label: "Grand Tour", map: GRAND_TOUR_MAP_URL }), photos: SAMPLE_PHOTOS_REA },
    "simple-rea-map": { data: mk({ type: "rea", label: "Grand Tour", map: GRAND_TOUR_MAP_URL }), photos: null },
    "simple-rea-nomap": { data: mk({ type: "rea", label: "First Tracks" }), photos: null },
    "simple-missing": { data: mk({ type: "rental", label: "Polaris rental", full: false, features: ["review"] }), photos: null },
  };
}
