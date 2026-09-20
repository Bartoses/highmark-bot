// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND AUDIENCE — who may be emailed / texted, and why not (pure + one DB read)
//
// The single definition of "eligible" used by the send API, so a caller (Apps Script,
// the portal, anything) can never send to someone the rules exclude.
//
// EMAIL (marketing) — a contact is eligible only when ALL hold:
//   • valid address, not unsubscribed / suppressed ANYWHERE (address-level, see emailSuppression.js)
//   • email_marketing_consent = true
//   • the consent is EXPLICIT (source ≠ 'grandfathered') unless the caller sets
//     segment.include_grandfathered = true for that send
//   • matches the segment filter
//   One send per address (family members sharing an address get one email).
// SMS (marketing) — opted_in, has a phone, not opted out (DB1 + mirror), and the consent is
//   EXPLICIT (fareharbor_flag / keyword_yes / …) unless segment.include_assumed_sms = true.
//
// Unknown segment keys are REJECTED: a typo like "tag_any" would otherwise silently widen a
// send to everybody.
// ─────────────────────────────────────────────────────────────────────────────
import { loadSuppressionSets, normEmail, isEmailAddress } from "./emailSuppression.js";

const PAGE = 1000;

export class SegmentError extends Error {}

export const EXPLICIT_SMS_SOURCES = ["fareharbor_flag", "keyword_yes", "web_signup", "portal_manual", "waiver_checkbox"];
export const isExplicitEmailConsent = (source) => !!source && source !== "grandfathered";
export const isExplicitSmsConsent   = (source) => EXPLICIT_SMS_SOURCES.includes(source);

const SEGMENT_KEYS = ["tags_any", "tags_all", "exclude_tags", "sources", "min_bookings", "active_since", "include_grandfathered", "include_assumed_sms"];

export function normalizeSegment(input) {
  const s = input ?? {};
  if (typeof s !== "object" || Array.isArray(s)) throw new SegmentError("segment must be an object");
  const unknown = Object.keys(s).filter(k => !SEGMENT_KEYS.includes(k));
  if (unknown.length) throw new SegmentError(`unknown segment field(s): ${unknown.join(", ")} (allowed: ${SEGMENT_KEYS.join(", ")})`);

  const list = (name) => {
    const v = s[name];
    if (v == null) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw new SegmentError(`segment.${name} must be an array of strings`);
    return [...new Set(v.map(x => x.trim().toLowerCase()).filter(Boolean))].slice(0, 25);
  };
  let minBookings = null;
  if (s.min_bookings != null) {
    minBookings = Number(s.min_bookings);
    if (!Number.isInteger(minBookings) || minBookings < 0) throw new SegmentError("segment.min_bookings must be a non-negative integer");
  }
  let activeSince = null;
  if (s.active_since != null) {
    const t = Date.parse(s.active_since);
    if (!Number.isFinite(t)) throw new SegmentError("segment.active_since must be a date (YYYY-MM-DD)");
    activeSince = new Date(t).toISOString();
  }
  for (const b of ["include_grandfathered", "include_assumed_sms"]) {
    if (s[b] != null && typeof s[b] !== "boolean") throw new SegmentError(`segment.${b} must be true or false`);
  }
  return {
    tags_any: list("tags_any"), tags_all: list("tags_all"), exclude_tags: list("exclude_tags"), sources: list("sources"),
    min_bookings: minBookings, active_since: activeSince,
    include_grandfathered: s.include_grandfathered === true, include_assumed_sms: s.include_assumed_sms === true,
  };
}

export function matchesSegment(c, seg) {
  const tags = (c.tags ?? []).map(t => String(t).toLowerCase());
  if (seg.tags_any.length && !seg.tags_any.some(t => tags.includes(t))) return false;
  if (seg.tags_all.length && !seg.tags_all.every(t => tags.includes(t))) return false;
  if (seg.exclude_tags.length && seg.exclude_tags.some(t => tags.includes(t))) return false;
  if (seg.sources.length && !seg.sources.includes(String(c.source ?? "").toLowerCase())) return false;
  if (seg.min_bookings != null && (c.total_bookings ?? 0) < seg.min_bookings) return false;
  if (seg.active_since && !(Date.parse(c.last_activity) >= Date.parse(seg.active_since))) return false;
  return true;
}

export function maskEmail(e) {
  const [u, d] = String(e ?? "").split("@");
  return d ? `${(u ?? "").slice(0, 1)}***@${d}` : "***";
}
export function maskPhone(p) { const s = String(p ?? ""); return s.length > 4 ? `${s.slice(0, 2)}***${s.slice(-2)}` : "***"; }

async function fetchContacts(crm, clientId, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await crm.from("contacts").select(cols).eq("client_id", clientId)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`audience read failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

const rankForDedupe = (c) => [isExplicitEmailConsent(c.email_consent_source) ? 1 : 0, c.total_bookings ?? 0, Date.parse(c.last_activity) || 0];
const better = (a, b) => { const x = rankForDedupe(a), y = rankForDedupe(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

export async function selectEmailRecipients(crm, { clientId, segment }) {
  const seg = normalizeSegment(segment);
  const rows = await fetchContacts(crm, clientId,
    "id, email, first_name, last_name, tags, source, total_bookings, last_activity, email_marketing_consent, email_unsubscribed_at, email_suppressed_at, email_consent_source, email_unsubscribe_token");
  const sup = await loadSuppressionSets(crm);   // address-level, across ALL clients' rows

  const stats = { contacts_scanned: rows.length, eligible: 0, excluded: { no_email: 0, invalid_email: 0, suppressed: 0, unsubscribed: 0, not_in_segment: 0, no_consent: 0, grandfathered: 0, duplicate_address: 0 } };
  const best = new Map();
  for (const c of rows) {
    if (!c.email) { stats.excluded.no_email++; continue; }
    const key = normEmail(c.email);
    if (!isEmailAddress(key)) { stats.excluded.invalid_email++; continue; }
    if (sup.all.has(key)) { sup.hard.has(key) ? stats.excluded.suppressed++ : stats.excluded.unsubscribed++; continue; }
    if (!matchesSegment(c, seg)) { stats.excluded.not_in_segment++; continue; }
    if (c.email_marketing_consent !== true) { stats.excluded.no_consent++; continue; }
    if (!isExplicitEmailConsent(c.email_consent_source) && !seg.include_grandfathered) { stats.excluded.grandfathered++; continue; }
    const prev = best.get(key);
    if (!prev) best.set(key, c);
    else { stats.excluded.duplicate_address++; if (better(c, prev)) best.set(key, c); }
  }
  const recipients = [...best.entries()].map(([email, c]) => ({
    contact_id: c.id, email, first_name: c.first_name ?? null, last_name: c.last_name ?? null,
    unsubscribe_token: c.email_unsubscribe_token ?? null, consent_source: c.email_consent_source ?? null,
  }));
  stats.eligible = recipients.length;
  return { recipients, stats, segment: seg };
}

// Every phone that opted out anywhere we can see. Throws if the authoritative DB1 list is
// unreadable — a text send must FAIL CLOSED, never guess.
export async function loadSmsOptOuts(crm, db1) {
  if (!db1) throw new Error("opt-out list unavailable (no DB1 client)");
  const blocked = new Set();
  const { data, error } = await db1.from("opt_outs").select("phone");
  if (error) throw new Error(`opt-out list unreadable: ${error.message}`);
  for (const r of data ?? []) blocked.add(r.phone);
  try { const m = await crm.from("opt_outs").select("phone"); for (const r of m.data ?? []) blocked.add(r.phone); } catch { /* mirror absent */ }
  return blocked;
}

export async function selectSmsRecipients(crm, db1, { clientId, segment }) {
  const seg = normalizeSegment(segment);
  const rows = await fetchContacts(crm, clientId,
    "id, phone, first_name, last_name, tags, source, total_bookings, last_activity, opted_in, opted_out_at, sms_consent_source");
  const optOuts = await loadSmsOptOuts(crm, db1);

  const stats = { contacts_scanned: rows.length, eligible: 0, excluded: { no_phone: 0, opted_out: 0, not_in_segment: 0, not_opted_in: 0, assumed_consent: 0 } };
  const recipients = [];
  for (const c of rows) {
    if (!c.phone) { stats.excluded.no_phone++; continue; }
    if (c.opted_out_at || optOuts.has(c.phone)) { stats.excluded.opted_out++; continue; }
    if (!matchesSegment(c, seg)) { stats.excluded.not_in_segment++; continue; }
    if (c.opted_in !== true) { stats.excluded.not_opted_in++; continue; }
    if (!isExplicitSmsConsent(c.sms_consent_source) && !seg.include_assumed_sms) { stats.excluded.assumed_consent++; continue; }
    recipients.push({ contact_id: c.id, phone: c.phone, first_name: c.first_name ?? null, consent_source: c.sms_consent_source ?? null });
  }
  stats.eligible = recipients.length;
  return { recipients, stats, segment: seg };
}
