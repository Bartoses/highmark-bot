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

/** photo_hint sent with a queued recap. file_id (from the Guide app) is used first; date/label/time are the fallback. */
export function buildPhotoHint({ label, startAt, fileId = null }) {
  const hint = { date: rideDateFolder(startAt), label: cleanNamePart(label), time: formatRideTime(startAt) };
  if (fileId) hint.file_id = String(fileId);
  return hint;
}

export function isEmailSafeImageType(mimeType) {
  return EMAIL_IMAGE_TYPES.includes(String(mimeType || "").toLowerCase());
}

// ── matcher: KEEP IDENTICAL to hmPickPhotoName_ in docs/apps-script/Code.gs ──
const norm = (s) => String(s || "").toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
const TIME_RE = /\b(\d{1,2})(?::|\s)?(\d{2})?\s?(am|pm)\b/;
function timeOf(n) {
  const m = norm(n).match(TIME_RE);
  return m ? (parseInt(m[1], 10) + (m[2] && m[2] !== "00" ? ":" + m[2] : "") + m[3]) : null;
}

/** Which file name in the day folder belongs to this ride (or null). Names must already be filtered to email-safe images. */
export function pickRidePhotoName(names, hint) {
  const label = norm(hint.label);
  const want = hint.time ? timeOf(hint.time) : null;
  const sorted = names.slice().sort();
  const withLabel = sorted.filter((n) => norm(n).includes(label));
  if (want) {
    const exact = withLabel.filter((n) => timeOf(n) === want);
    if (exact.length) return exact[0];
    const otherTimes = withLabel.filter((n) => { const t = timeOf(n); return t && t !== want; });
    const untimed = withLabel.filter((n) => !timeOf(n));
    return (!otherTimes.length && untimed.length) ? untimed[0] : null;
  }
  if (withLabel.length) return withLabel[0];
  const first = label.split(" ")[0];
  if (first.length > 3) { const loose = sorted.filter((n) => norm(n).includes(first)); if (loose.length) return loose[0]; }
  return null;
}
