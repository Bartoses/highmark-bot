// ─────────────────────────────────────────────────────────────────────────────
// PHONE UTILITIES — normalization, validation, display formatting
//
// Canonical format for operational storage: E.164 (e.g. +19704391707)
//
// Uses:
//   normalizePhone(raw)     — strip display chars, convert to E.164 or null
//   isValidPhone(raw)       — returns boolean
//   formatPhoneForDisplay   — +19704391707 → (970) 439-1707  (US only)
//
// Scope: Phase 1 applies normalization to operational paths (lead storage,
// CRM dedup, Twilio send targets). Display-purpose phones (supportPhone,
// handoffPhone) are left as human-readable — they appear in bot messages.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number to E.164 format.
 * Strips spaces, dashes, parentheses, and periods.
 * Handles 10-digit US, 11-digit US (starting with 1), and valid E.164 input.
 * Returns null for anything that can't be recognized.
 */
export function normalizePhone(raw, defaultCountry = "US") {
  if (!raw) return null;
  // Strip common display characters (but keep + for E.164 detection)
  const stripped = String(raw).replace(/[\s\-().]/g, "");
  // Already valid E.164: starts with + followed by 7-15 digits
  if (/^\+\d{7,15}$/.test(stripped)) return stripped;
  if (defaultCountry === "US") {
    // 10 digits → +1XXXXXXXXXX
    if (/^\d{10}$/.test(stripped)) return `+1${stripped}`;
    // 11 digits starting with 1 → +1XXXXXXXXXX
    if (/^1\d{10}$/.test(stripped)) return `+${stripped}`;
  }
  return null;
}

/**
 * Returns true if the input can be normalized to a valid phone number.
 */
export function isValidPhone(raw, defaultCountry = "US") {
  return normalizePhone(raw, defaultCountry) !== null;
}

/**
 * Format an E.164 US number for human-readable display: +19704391707 → (970) 439-1707
 * Non-US or non-E.164 values are returned unchanged.
 */
export function formatPhoneForDisplay(e164) {
  if (!e164) return e164;
  const m = String(e164).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * True for synthetic/test phone numbers — the fictional 555 / 999 area codes
 * used by the test suite + testing portal (e.g. +15550009999, +15559999999).
 * Never real customers, so they're excluded from lead reporting in production.
 */
export function isTestPhone(phone) {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1); // drop US country code
  return /^(555|999)/.test(d);
}
