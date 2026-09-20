// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR → CRM CONTACTS MIRROR — consent-safe
//
// Makes FareHarbor guests known contacts in DB2 `contacts`, so the bot
// recognizes them when they text in and they can be segmented. Complements
// fareharborNormalizer.js (which links `bookings` → `customers`/`activities`).
//
// WHY THIS IS NOT JUST upsertContact():
//   `contacts.opted_in` and `contacts.email_marketing_consent` both DEFAULT TRUE,
//   and upsertContact() opts every new contact in. FareHarbor, however, records
//   each guest's own choice on the booking form — and 88% of bookings have SMS
//   updates switched OFF. Texting/emailing marketing to those guests would
//   override an explicit "no". So consent here comes ONLY from FareHarbor's flags:
//
//   NEW contact
//     opted_in                = booking.is_subscribed_for_sms_updates === true   (latest booking wins)
//                               AND phone is not in opt_outs / customers.sms_opt_out
//     email_marketing_consent = contact.is_subscribed_for_email_updates === true
//                               AND an email address exists
//     Both are written EXPLICITLY (never left to the column default of TRUE).
//     No flag / false → the guest is still a recognized contact, just not
//     campaign-eligible.
//   EXISTING contact
//     Consent is NEVER touched (no upgrade, no downgrade) — they may have opted
//     in or out through another channel (texting in, STOP, MPWR, imports). Only
//     blanks are filled (name, email), tags are unioned, total_bookings only
//     rises, last_activity only advances.
//   FAIL CLOSED: if the opt-out list can't be read, every NEW contact is created
//     opted_in=false.
//
// Modes (cron-worker.js): "recent" every tick (bookings updated in the last 7
// days) · "full" daily sweep + one-off CLI. CLI dry-runs unless --apply.
// ─────────────────────────────────────────────────────────────────────────────
import { normalizePhone } from "./phoneUtils.js";
import { unwrapFhPayload, FH_NORMALIZE_SINCE } from "./fareharborNormalizer.js";

const CLIENT_ID = process.env.CLIENT_ID || "csr_rea";
const COMPANY_TAG = { coloradosledrentals: "csr", rabbitearsadventures: "rea" };
const RECENT_DAYS = 7;
const PAGE = 1000;
const FETCH_CHUNK = 100;
const WRITE_CHUNK = 200;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// One booking row → the guest facts it carries (or null when there's no usable phone).
export function extractGuestFromBooking(row) {
  const b = unwrapFhPayload(row?.raw_payload);
  if (!b) return null;
  const phone = normalizePhone(b.contact?.normalized_phone) ?? normalizePhone(b.contact?.phone);
  if (!phone) return null;
  const name  = typeof b.contact?.name  === "string" ? b.contact.name.trim()  : "";
  const email = typeof b.contact?.email === "string" ? b.contact.email.trim().toLowerCase() : "";
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  return {
    phone,
    firstName: first || null,
    lastName:  rest.join(" ") || null,
    email:     email || null,
    smsYes:    b.is_subscribed_for_sms_updates === true,
    emailYes:  b.contact?.is_subscribed_for_email_updates === true,
    bookedAt:  row.booked_at ?? b.created_at ?? null,
    isBooked:  row.status === "booked",
    tag:       COMPANY_TAG[row.company] ?? null,
  };
}

// Many booking rows → one aggregate per phone. Rows are applied oldest→newest so
// the guest's LATEST booking decides consent flags, name and email.
export function aggregateGuests(rows) {
  const facts = rows.map(extractGuestFromBooking).filter(Boolean)
    .sort((a, b) => String(a.bookedAt ?? "").localeCompare(String(b.bookedAt ?? "")));
  const guests = new Map();
  for (const f of facts) {
    const g = guests.get(f.phone) ?? {
      phone: f.phone, firstName: null, lastName: null, email: null,
      smsYes: false, emailYes: false, bookings: 0, tags: new Set(["fareharbor"]), lastActivity: null,
    };
    g.firstName = f.firstName ?? g.firstName;
    g.lastName  = f.lastName  ?? g.lastName;
    g.email     = f.email     ?? g.email;
    g.smsYes    = f.smsYes;
    g.emailYes  = f.emailYes;
    if (f.isBooked) { g.bookings++; g.tags.add("booked"); }
    if (f.tag) g.tags.add(f.tag);
    if (f.bookedAt && (!g.lastActivity || f.bookedAt > g.lastActivity)) g.lastActivity = f.bookedAt;
    guests.set(f.phone, g);
  }
  return guests;
}

// What to write for one guest. `existing` = current contacts row or null;
// `blocked` = phone is on an opt-out list (or the list is unknown → fail closed).
export function planContact(guest, { existing = null, blocked = false, nowIso = new Date().toISOString() } = {}) {
  if (!existing) {
    return {
      action: "insert",
      row: {
        phone: guest.phone,
        first_name: guest.firstName,
        last_name:  guest.lastName,
        email:      guest.email,
        source:     "fareharbor_booking",
        tags:       [...guest.tags],
        last_activity:  guest.lastActivity ?? nowIso,
        total_bookings: guest.bookings,
        client_id:  CLIENT_ID,
        // Explicit — the column defaults are TRUE.
        opted_in:                guest.smsYes && !blocked,
        opted_out_at:            blocked ? nowIso : null,
        email_marketing_consent: guest.emailYes && !!guest.email,
        // Provenance (db2_contact_model.sql): where + when each opt-in came from.
        sms_consent_source:   guest.smsYes && !blocked ? "fareharbor_flag" : null,
        sms_consent_at:       guest.smsYes && !blocked ? (guest.lastActivity ?? nowIso) : null,
        email_consent_source: guest.emailYes && guest.email ? "fareharbor_flag" : null,
        email_consent_at:     guest.emailYes && guest.email ? (guest.lastActivity ?? nowIso) : null,
      },
    };
  }
  // Existing contact: fill blanks only. Consent columns are deliberately absent.
  const patch = {};
  if (!existing.first_name && guest.firstName) patch.first_name = guest.firstName;
  if (!existing.last_name  && guest.lastName)  patch.last_name  = guest.lastName;
  if (!existing.email      && guest.email)     patch.email      = guest.email;
  const tags = existing.tags ?? [];
  const merged = [...new Set([...tags, ...guest.tags])];
  if (merged.length !== tags.length) patch.tags = merged;
  if (guest.bookings > (existing.total_bookings ?? 0)) patch.total_bookings = guest.bookings;
  if (guest.lastActivity && (!existing.last_activity || guest.lastActivity > existing.last_activity)) patch.last_activity = guest.lastActivity;
  return Object.keys(patch).length ? { action: "update", patch } : { action: "none" };
}

// ── DB helpers ───────────────────────────────────────────────────────────────
async function listCandidatePks(crm, { mode, since, maxRows }) {
  const pks = [];
  for (let from = 0; pks.length < maxRows; from += PAGE) {
    let q = crm.from("bookings").select("fareharbor_pk")
      .like("fareharbor_pk", "#%").gte("start_at", since)
      .order("fareharbor_pk", { ascending: true }).range(from, from + PAGE - 1);
    if (mode === "recent") q = q.gte("updated_at", new Date(Date.now() - RECENT_DAYS * 864e5).toISOString());
    const { data, error } = await q;
    if (error) throw new Error(`fareharbor contacts query failed: ${error.message}`);
    pks.push(...(data ?? []).map(r => r.fareharbor_pk));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return pks.slice(0, maxRows);
}

// Every phone that has opted out anywhere we can see. `known` is false when the
// authoritative DB1 list couldn't be read — callers then fail closed.
async function loadBlockedPhones(crm, db1) {
  const blocked = new Set();
  let known = false;
  if (db1) {
    const { data, error } = await db1.from("opt_outs").select("phone");
    if (!error) { known = true; for (const r of data ?? []) blocked.add(r.phone); }
  }
  // DB2 mirror + customers flag are best-effort extras (tables/columns may be absent).
  try {
    const { data } = await crm.from("opt_outs").select("phone");
    for (const r of data ?? []) blocked.add(r.phone);
  } catch { /* mirror absent */ }
  try {
    const { data } = await crm.from("customers").select("normalized_phone").eq("sms_opt_out", true);
    for (const r of data ?? []) if (r.normalized_phone) blocked.add(r.normalized_phone);
  } catch { /* column absent */ }
  return { blocked, known };
}

export async function mirrorFareHarborContacts(crm, db1, {
  mode = "recent", since = FH_NORMALIZE_SINCE, maxRows = 10000, dryRun = false,
} = {}) {
  const summary = {
    mode, dryRun, bookingsScanned: 0, guests: 0,
    newContacts: 0, newSmsOptedIn: 0, newEmailConsent: 0, newBlockedByOptOut: 0,
    existingUpdated: 0, existingUnchanged: 0, optOutListKnown: null,
  };
  if (!crm) return summary;

  const pks = await listCandidatePks(crm, { mode, since, maxRows });
  if (!pks.length) return summary;

  const rows = [];
  for (let i = 0; i < pks.length; i += FETCH_CHUNK) {
    const { data, error } = await crm.from("bookings")
      .select("fareharbor_pk, company, status, booked_at, raw_payload")
      .in("fareharbor_pk", pks.slice(i, i + FETCH_CHUNK));
    if (error) throw new Error(`fareharbor contacts fetch failed: ${error.message}`);
    rows.push(...(data ?? []));
  }
  summary.bookingsScanned = rows.length;

  const guests = aggregateGuests(rows);
  summary.guests = guests.size;
  if (!guests.size) return summary;

  const { blocked, known } = await loadBlockedPhones(crm, db1);
  summary.optOutListKnown = known;

  const phones = [...guests.keys()];
  const existingByPhone = new Map();
  for (let i = 0; i < phones.length; i += FETCH_CHUNK) {
    const { data, error } = await crm.from("contacts")
      .select("phone, first_name, last_name, email, tags, total_bookings, last_activity")
      .in("phone", phones.slice(i, i + FETCH_CHUNK));
    if (error) throw new Error(`fareharbor contacts lookup failed: ${error.message}`);
    for (const c of data ?? []) existingByPhone.set(c.phone, c);
  }

  const inserts = [];
  const updates = [];
  for (const g of guests.values()) {
    // Fail closed: opt-out list unreadable → nobody new is opted in.
    const isBlocked = blocked.has(g.phone) || !known;
    const plan = planContact(g, { existing: existingByPhone.get(g.phone) ?? null, blocked: isBlocked });
    if (plan.action === "insert") {
      inserts.push(plan.row);
      summary.newContacts++;
      if (plan.row.opted_in) summary.newSmsOptedIn++;
      if (plan.row.email_marketing_consent) summary.newEmailConsent++;
      if (blocked.has(g.phone)) summary.newBlockedByOptOut++;
    } else if (plan.action === "update") {
      updates.push({ phone: g.phone, patch: plan.patch });
      summary.existingUpdated++;
    } else {
      summary.existingUnchanged++;
    }
  }

  if (!dryRun) {
    for (let i = 0; i < inserts.length; i += WRITE_CHUNK) {
      // ignoreDuplicates: if a contact appeared since we looked (e.g. the guest just
      // texted in), keep theirs — never overwrite a row with our default view of it.
      const { error } = await crm.from("contacts")
        .upsert(inserts.slice(i, i + WRITE_CHUNK), { onConflict: "phone", ignoreDuplicates: true });
      if (error) throw new Error(`fareharbor contacts insert failed: ${error.message}`);
    }
    for (const u of updates) {
      const { error } = await crm.from("contacts").update(u.patch).eq("phone", u.phone);
      if (error) throw new Error(`fareharbor contacts update failed: ${error.message}`);
    }
  }
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//   node --env-file=.env fareharborContacts.js            → dry run (writes nothing)
//   node --env-file=.env fareharborContacts.js --apply    → apply, full window
//   flags: --recent, --since=YYYY-MM-DD
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args  = process.argv.slice(2);
  const apply = args.includes("--apply");
  const since = args.find(a => a.startsWith("--since="))?.split("=")[1] ?? FH_NORMALIZE_SINCE;
  const mode  = args.includes("--recent") ? "recent" : "full";
  const { createClient } = await import("@supabase/supabase-js");
  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("CRM_SUPABASE_URL/KEY and SUPABASE_URL/KEY (DB1, for opt-outs) must be set"); process.exit(1);
  }
  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
  const db1 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const s = await mirrorFareHarborContacts(crm, db1, { mode, since, dryRun: !apply });
  console.log(JSON.stringify(s, null, 2));
  console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
}
