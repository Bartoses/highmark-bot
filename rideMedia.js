// rideMedia.js — the ONE naming + matching contract for ride photos/videos in Google Drive.
//
// Who uses it:
//   - Guide Ride Log app (upload side): names every file it writes to Drive with buildRideMediaFileName()
//     into the folder rideDateFolder(startAt), so guides never type a file name.
//   - Ride Recap job (send side): builds photo_hint with buildPhotoHint() for each queued recap.
//   - Apps Script (docs/apps-script/Code.gs hmPickPhotoName_): finds the photo by that hint. Its matcher is a
//     line-for-line copy of pickRidePhotoName() below; tests here pin the behavior both sides rely on.
//
// Drive layout (RECAP_PHOTO_FOLDER_ID = the "Tour Photos" folder):
//   Tour Photos/2026-11-22/Grand Tour 11am - Jake - 01.jpg
//   Tour Photos/2026-11-22/Grand Tour 11am - Jake - 02.jpg
//   Tour Photos/2026-11-22/Grand Tour 1:30pm - Mia - 01.jpg
//   Tour Photos/2026-11-22/Grand Tour 11am - Jake - 01.mp4      (videos live alongside; never put in email)
// Date + time are the ride's START in America/Denver. "- 01" is the cover photo the recap uses.

export const RIDE_MEDIA_TZ = "America/Denver";
export const EMAIL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];   // HEIC/WebP don't render in many mail apps
// What the Guide app must do to a photo before uploading (phone-side): convert to JPEG, shrink, keep it small.
export const PHOTO_UPLOAD_SPEC = { mimeType: "image/jpeg", ext: "jpg", maxEdgePx: 1600, jpegQuality: 0.82, maxBytes: 15 * 1024 * 1024 };
export const VIDEO_EXTS = ["mp4", "mov", "m4v"];

const pad2 = (n) => String(n).padStart(2, "0");

function denverParts(startAt) {
  const d = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(d.getTime())) throw new Error(`rideMedia: invalid start time ${startAt}`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: RIDE_MEDIA_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return parts;
}

/** "2026-11-22" — the date subfolder for a ride (its start, Mountain time). */
export function rideDateFolder(startAt) {
  const p = denverParts(startAt);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "11am", "1:30pm" — the ride's start time as it appears in file names. */
export function formatRideTime(startAt) {
  const p = denverParts(startAt);
  const min = p.minute === "00" ? "" : `:${p.minute}`;
  return `${Number(p.hour)}${min}${String(p.dayPeriod).toLowerCase()}`;
}

/** Strip characters Drive/OSes dislike and collapse spaces. Keeps the label readable. */
export function cleanNamePart(s) {
  return String(s ?? "").replace(/[\\/:*?"<>|#%\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * "Grand Tour 11am - Jake - 01.jpg". label MUST be the recap_tours.label of the ride (that's what recaps search for).
 * index starts at 1 (01 = cover). ext defaults to jpg (the app converts photos to JPEG first).
 */
export function buildRideMediaFileName({ label, startAt, guide = "", index = 1, ext = "jpg" }) {
  const l = cleanNamePart(label);
  if (!l) throw new Error("rideMedia: label is required");
  const e = String(ext || "jpg").toLowerCase().replace(/^\./, "").replace(/^jpeg$/, "jpg");
  const g = cleanNamePart(guide);
  return `${l} ${formatRideTime(startAt)}${g ? ` - ${g}` : ""} - ${pad2(Math.max(1, Number(index) || 1))}.${e}`;
}

/**
 * photo_hint sent with a queued recap. file_id (from the Guide app) is used first; date/label/time are the fallback.
 * season "winter" (every recap ride is on snow) makes the matcher refuse summer/RZR/UTV photos. hosted = the simple
 * template: the Apps Script uploads the photo to the bot (POST /api/v1/recaps/photo) instead of attaching it.
 */
export function buildPhotoHint({ label, startAt, fileId = null, season = null, hosted = false }) {
  const hint = { date: rideDateFolder(startAt), label: cleanNamePart(label), time: formatRideTime(startAt) };
  if (fileId) hint.file_id = String(fileId);
  if (season) hint.season = String(season);
  if (hosted) hint.hosted = true;
  return hint;
}

export function isEmailSafeImageType(mimeType) {
  return EMAIL_IMAGE_TYPES.includes(String(mimeType || "").toLowerCase());
}

// ── ride_media (db2_ride_media.sql): the Guide app's record of which file belongs to which departure / booking ──
/**
 * The photo for one booking's recap, from ride_media rows (pure). booking = { pk: '#392519085', availabilityPk: '123' }.
 * 1) photos tagged with this booking; 2) photos for the whole departure (no booking_pks); never a photo tagged for other
 * bookings, never a video, never a file type mail apps can't show. Cover first, then sort_order, then file name.
 * → the row, or null (then the Apps Script falls back to the strict file-name match).
 */
export function pickRideMediaForBooking(rows, booking) {
  const pk = String(booking?.pk ?? ""), avail = booking?.availabilityPk != null ? String(booking.availabilityPk) : null;
  const ok = (r) => r && r.drive_file_id && (r.kind ?? "photo") === "photo" && (!r.mime_type || isEmailSafeImageType(r.mime_type));
  const rank = (a, b) => (b.cover === true) - (a.cover === true) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.file_name ?? "").localeCompare(String(b.file_name ?? ""));
  const list = (rows ?? []).filter(ok);
  const tagged = pk ? list.filter(r => Array.isArray(r.booking_pks) && r.booking_pks.map(String).includes(pk)) : [];
  if (tagged.length) return tagged.sort(rank)[0];
  const departure = avail ? list.filter(r => String(r.availability_pk ?? "") === avail && !(Array.isArray(r.booking_pks) && r.booking_pks.length)) : [];
  return departure.length ? departure.sort(rank)[0] : null;
}

// ── matcher: KEEP IDENTICAL to hmPickPhotoName_ in docs/apps-script/Code.gs ──
const norm = (s) => String(s || "").toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
const TIME_RE = /\b(\d{1,2})(?::|\s)?(\d{2})?\s?(am|pm)\b/;
function timeOf(n) {
  const m = norm(n).match(TIME_RE);
  return m ? (parseInt(m[1], 10) + (m[2] && m[2] !== "00" ? ":" + m[2] : "") + m[3]) : null;
}

// A winter ride never takes a summer photo (the Jan 29 test send showed a RZR shot on a Grand Tour recap).
const SUMMER_RE = /\b(rzr|utv|atv|sxs|side by side|summer|jeep|xpedition|general)\b/;
const isSummerName = (n) => SUMMER_RE.test(norm(n));
const isSummerDate = (ymd) => { const m = Number(String(ymd || "").slice(5, 7)); return m >= 6 && m <= 9; };

/**
 * Which file name in the day folder belongs to this ride (or null). Names must already be filtered to email-safe images.
 * STRICT: the name must contain the tour label (no loose "first word" fallback any more); with a time, only that time.
 */
export function pickRidePhotoName(names, hint) {
  const label = norm(hint.label);
  if (!label) return null;
  const want = hint.time ? timeOf(hint.time) : null;
  const sorted = names.slice().sort().filter((n) => hint.season !== "winter" || !isSummerName(n));
  const withLabel = sorted.filter((n) => norm(n).includes(label));
  if (want) {
    const exact = withLabel.filter((n) => timeOf(n) === want);
    if (exact.length) return exact[0];
    const otherTimes = withLabel.filter((n) => { const t = timeOf(n); return t && t !== want; });
    const untimed = withLabel.filter((n) => !timeOf(n));
    return (!otherTimes.length && untimed.length) ? untimed[0] : null;
  }
  return withLabel.length ? withLabel[0] : null;
}

/**
 * Server-side gate for an uploaded photo (POST /api/v1/recaps/photo): (a) its Drive day folder IS the ride date,
 * (b) its file name contains the tour label, (c) the season matches (a winter ride never takes a summer/RZR/UTV file or
 * a Jun–Sep folder). No match = no photo; there is never an "any image" fallback.
 */
export function isStrictPhotoMatch({ folderDate, fileName, fileId = null }, hint) {
  // the exact Drive file the Guide app tagged for this booking (ride_media → photo_hint.file_id): no name guessing needed
  if (hint?.file_id && fileId && String(fileId) === String(hint.file_id)) return true;
  if (!hint?.date || !hint?.label || !fileName) return false;
  if (String(folderDate || "") !== String(hint.date)) return false;
  if (!norm(fileName).includes(norm(hint.label))) return false;
  if ((hint.season ?? "winter") === "winter" && (isSummerName(fileName) || isSummerDate(folderDate))) return false;
  return true;
}

// ── simple-template hosted photos (recapSimple.js) ──
const htmlAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
// photos: { hero, full, thumbs:[3 urls] } | null. Keeps exactly one of the photo / no-photo blocks. Idempotent; HTML without
// markers (v1, transactional, already-applied) comes back unchanged.
export function applyHostedPhotos(html, photos) {
  let h = String(html ?? "");
  if (!h.includes("<!--RR_PHOTO-->") && !h.includes("<!--RR_NOPHOTO-->")) return h;
  const ok = photos && /^https:\/\//.test(String(photos.hero ?? "")) && /^https:\/\//.test(String(photos.full ?? ""));
  if (ok) {
    const t = [0, 1, 2].map(i => (/^https:\/\//.test(String(photos.thumbs?.[i] ?? "")) ? photos.thumbs[i] : photos.hero));
    h = h.replace(/<!--RR_NOPHOTO-->[\s\S]*?<!--\/RR_NOPHOTO-->/g, "").replace(/<!--\/?RR_PHOTO-->/g, "")
      .replace(/__RR_HERO__/g, htmlAttr(photos.hero)).replace(/__RR_FULL__/g, htmlAttr(photos.full))
      .replace(/__RR_T1__/g, htmlAttr(t[0])).replace(/__RR_T2__/g, htmlAttr(t[1])).replace(/__RR_T3__/g, htmlAttr(t[2]));
  } else {
    h = h.replace(/<!--RR_PHOTO-->[\s\S]*?<!--\/RR_PHOTO-->/g, "").replace(/<!--\/?RR_NOPHOTO-->/g, "");
  }
  return h;
}
