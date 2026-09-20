// ─────────────────────────────────────────────────────────────────────────────
// SMARTWAIVER IMPORT — waiver signers → DB2 `waivers` + `contacts`
//
// Waiver signers are past/present customers (many are riders who never booked
// themselves, so they aren't in FareHarbor). The Smartwaiver export has an email
// but NO phone number, so:
//   • matching is by EMAIL (case-insensitive) — never by name alone;
//   • new people become EMAIL-ONLY contacts (contacts.phone is nullable since
//     db2_contact_model.sql) and can never be texted;
//   • an existing customer with that email who has a phone gets a phone+email
//     contact (opted_in stays FALSE — a waiver says nothing about SMS).
//
// PRIVACY: date of birth, driver's-licence number/state and gender are NEVER read
// into a record here — not needed to market to or recognise a guest.
//
// EMAIL CONSENT (explicit, from the form's "Marketing Emails Allowed" checkbox):
//   eligible = the person's LATEST waiver ticked it   (blank = not ticked)
//              AND the address is VERIFIED (some waiver for it is "Completed Online")
//   Unverified ("Pending Email Verification") addresses are imported but NOT
//   consented — a typo'd/other-person's address is how you earn bounces + spam
//   complaints. They upgrade automatically on a later import once verified.
//   EXISTING contacts: consent may be UPGRADED false→true by an eligible waiver
//   (an affirmative opt-in) but is NEVER downgraded, and never touched when the
//   contact is unsubscribed or suppressed.  Fills blanks only; never overwrites.
//
// CLI (dry-run by default):
//   node --env-file=.env waiverImport.js <file.csv>            → plan, writes nothing
//   node --env-file=.env waiverImport.js <file.csv> --apply    → writes
// ─────────────────────────────────────────────────────────────────────────────
import { normalizePhone } from "./phoneUtils.js";

const CLIENT_ID = process.env.CLIENT_ID || "csr_rea";
const PAGE = 1000;
const WRITE_CHUNK = 200;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Minimal RFC-4180 parser: quoted fields, "" escapes, CRLF, embedded newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const t = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ""));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Compare instants numerically. The DB returns "…+00:00" while JS writes "…000Z"; comparing
// those as STRINGS says the same moment is "newer" every time (=> a pointless UPDATE per row
// on every run). Unparseable/blank counts as "not later".
export const isLater = (a, b) => {
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && (!Number.isFinite(y) || x > y);
};

// ALL-CAPS or all-lowercase names → Title Case; mixed-case ("McDonald") left alone.
export function tidyName(s) {
  const v = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  const letters = v.replace(/[^A-Za-z]/g, "");
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    return v.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, p, ch) => p + ch.toUpperCase());
  }
  return v;
}

export function docTag(title) {
  const t = String(title ?? "").toLowerCase();
  if (t.includes("trailer")) return "trailer_rental";
  if (t.includes("avalanche")) return "avalanche_gear";
  return null;
}

// Header-driven, so column order / extra columns in future exports don't matter.
// Deliberately never touches Date of Birth / Drivers License* / Gender.
export function normalizeWaiverRow(cols, cells) {
  const get = (name) => (cells[cols.indexOf(name)] ?? "").trim();
  const email = get("Email").toLowerCase();
  const waiverId = get("Waiver ID");
  if (!waiverId || !EMAIL_RE.test(email)) return null;
  const done = get("Date Completed (UTC)");
  const status = /^completed/i.test(get("Status")) ? "completed" : "pending_email_verification";
  return {
    waiverId,
    email,
    firstName: tidyName(get("First")),
    lastName:  tidyName(get("Last")),
    phone:     normalizePhone(get("Phone")),
    signedAt:  done ? new Date(done.replace(" ", "T") + "Z").toISOString() : null,
    status,
    verified:  status === "completed",
    documentTitle: get("Title of Document") || null,
    marketing: /^y/i.test(get("Marketing Emails Allowed")),
  };
}

// Many waivers → one aggregate per email. Latest waiver decides name + marketing flag.
export function aggregateByEmail(waivers) {
  const ms = (w) => { const t = Date.parse(w.signedAt); return Number.isFinite(t) ? t : -Infinity; };
  const sorted = [...waivers].sort((a, b) => ms(a) - ms(b));
  const byEmail = new Map();
  for (const w of sorted) {
    const g = byEmail.get(w.email) ?? {
      email: w.email, firstName: null, lastName: null, phone: null, marketing: false,
      verified: false, verifiedAt: null, lastSignedAt: null, tags: new Set(["waiver", "smartwaiver"]), waivers: [],
    };
    g.firstName = w.firstName ?? g.firstName;
    g.lastName  = w.lastName  ?? g.lastName;
    g.phone     = w.phone     ?? g.phone;
    g.marketing = w.marketing;                                   // latest wins
    if (w.verified) { g.verified = true; g.verifiedAt = w.signedAt; }
    if (w.signedAt) g.lastSignedAt = w.signedAt;
    const tag = docTag(w.documentTitle); if (tag) g.tags.add(tag);
    g.waivers.push(w);
    byEmail.set(w.email, g);
  }
  for (const g of byEmail.values()) g.emailEligible = g.marketing && g.verified;
  return byEmail;
}

// Smartwaiver exports can contain the same waiver more than once (3 of 630 rows in the
// first real file). Postgres rejects an upsert batch that hits one key twice ("ON CONFLICT
// DO UPDATE command cannot affect row a second time"), so collapse by waiver id first.
// Prefer the verified copy, then the latest signature.
export function dedupeWaivers(records) {
  const byId = new Map();
  for (const w of records) {
    const cur = byId.get(w.waiverId);
    if (!cur) { byId.set(w.waiverId, w); continue; }
    const better = (w.verified && !cur.verified) ||
      (w.verified === cur.verified && isLater(w.signedAt, cur.signedAt));
    if (better) byId.set(w.waiverId, w);
  }
  return [...byId.values()];
}

// Insert row for a brand-new contact. opted_in is ALWAYS explicit (the column
// defaults to TRUE and the phone-less CHECK would reject it anyway).
export function buildNewContact(g, { phone = null } = {}) {
  return {
    phone, first_name: g.firstName, last_name: g.lastName, email: g.email,
    source: "smartwaiver", tags: [...g.tags],
    last_activity: g.lastSignedAt ?? new Date().toISOString(), total_bookings: 0, client_id: CLIENT_ID,
    opted_in: false, opted_out_at: null,
    email_marketing_consent: g.emailEligible,
    email_consent_source:   g.emailEligible ? "smartwaiver" : null,
    email_consent_at:       g.emailEligible ? g.lastSignedAt : null,
    email_verified_at:      g.verified ? g.verifiedAt : null,
  };
}

// Patch for an existing contact — blanks + one-way consent upgrade only.
export function planContactEnrichment(g, c) {
  const patch = {};
  if (!c.first_name && g.firstName) patch.first_name = g.firstName;
  if (!c.last_name  && g.lastName)  patch.last_name  = g.lastName;
  if (!c.email) patch.email = g.email;
  const tags = c.tags ?? [];
  const merged = [...new Set([...tags, ...g.tags])];
  if (merged.length !== tags.length) patch.tags = merged;
  if (g.lastSignedAt && isLater(g.lastSignedAt, c.last_activity)) patch.last_activity = g.lastSignedAt;
  const sameEmail = !c.email || c.email.toLowerCase() === g.email;   // never verify/consent someone else's address
  if (sameEmail && g.verified && !c.email_verified_at) patch.email_verified_at = g.verifiedAt;
  const blocked = !!c.email_unsubscribed_at || !!c.email_suppressed_at;
  if (sameEmail && g.emailEligible && c.email_marketing_consent !== true && !blocked) {
    patch.email_marketing_consent = true;
    patch.email_consent_source = "smartwaiver";
    patch.email_consent_at = g.lastSignedAt;
    patch._consentUpgrade = true;                                   // stripped before writing; used for counts
  }
  return patch;
}

// ── DB helpers ───────────────────────────────────────────────────────────────
async function fetchAll(crm, table, cols, filter) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = crm.from(table).select(cols).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`waiver import: reading ${table} failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

export async function importWaivers(crm, rawRecords, { dryRun = false } = {}) {
  const records = dedupeWaivers(rawRecords ?? []);
  const summary = {
    dryRun, waiverRows: (rawRecords ?? []).length, duplicateWaiverRows: (rawRecords ?? []).length - records.length,
    distinctEmails: 0, waiversToUpsert: 0,
    newEmailOnlyContacts: 0, newPhoneContactsViaCustomer: 0, enrichedContacts: 0, consentUpgrades: 0,
    newEmailConsent: 0, newPendingVerificationNoConsent: 0, unchanged: 0, emailConflicts: 0,
    nameOnlyCandidates: 0, insertErrors: 0,
  };
  if (!crm || !records.length) return summary;

  const byEmail = aggregateByEmail(records);
  summary.distinctEmails = byEmail.size;

  const contacts = await fetchAll(crm, "contacts",
    "id, phone, email, first_name, last_name, tags, last_activity, email_marketing_consent, email_unsubscribed_at, email_suppressed_at, email_verified_at",
    q => q);
  const customers = await fetchAll(crm, "customers", "id, name, email, normalized_phone", q => q);

  const contactsByEmail = new Map(), contactByPhone = new Map(), customersByEmail = new Map();
  for (const c of contacts) {
    if (c.email) { const k = c.email.toLowerCase(); (contactsByEmail.get(k) ?? contactsByEmail.set(k, []).get(k)).push(c); }
    if (c.phone) contactByPhone.set(c.phone, c);
  }
  for (const cu of customers) {
    if (cu.email) { const k = cu.email.toLowerCase(); (customersByEmail.get(k) ?? customersByEmail.set(k, []).get(k)).push(cu); }
  }
  // exact "first last" → customers lacking an email (review candidates only; never auto-merged)
  const noEmailByName = new Map();
  for (const cu of customers) {
    if (cu.email || !cu.name) continue;
    const k = cu.name.trim().toLowerCase().replace(/\s+/g, " ");
    noEmailByName.set(k, (noEmailByName.get(k) ?? 0) + 1);
  }

  // An address unsubscribed/suppressed on ANY contact row is off-limits for consent, wherever else it appears.
  const suppressedEmails = new Set(contacts.filter(c => c.email && (c.email_unsubscribed_at || c.email_suppressed_at)).map(c => c.email.toLowerCase()));
  summary.suppressedAddresses = 0;

  const waiverContact = new Map();   // email → { contactId, customerId }
  const inserts = [];                // { g, row }
  const updates = [];                // { id, patch }

  for (const g of byEmail.values()) {
    if (suppressedEmails.has(g.email) && g.emailEligible) { g.emailEligible = false; summary.suppressedAddresses++; }
    const cust = customersByEmail.get(g.email)?.[0] ?? null;
    let matched = contactsByEmail.get(g.email) ?? [];

    // customer (with a phone) but no contact carrying this email → the contact may already exist by phone
    if (!matched.length && cust?.normalized_phone && contactByPhone.has(cust.normalized_phone)) {
      const byPhone = contactByPhone.get(cust.normalized_phone);
      if (byPhone.email && byPhone.email.toLowerCase() !== g.email) summary.emailConflicts++;   // different address on file: don't touch
      else matched = [byPhone];
    }

    if (matched.length) {
      let changed = false;
      for (const c of matched) {
        const patch = planContactEnrichment(g, c);
        const upgrade = patch._consentUpgrade; delete patch._consentUpgrade;
        if (Object.keys(patch).length) { updates.push({ id: c.id, patch }); changed = true; if (upgrade) summary.consentUpgrades++; }
      }
      changed ? summary.enrichedContacts++ : summary.unchanged++;
      waiverContact.set(g.email, { contactId: matched[0].id, customerId: cust?.id ?? null });
      continue;
    }

    const phone = cust?.normalized_phone ?? g.phone ?? null;
    if (phone && contactByPhone.has(phone)) { summary.unchanged++; continue; }       // phone already a contact (email conflict counted above)
    inserts.push({ g, row: buildNewContact(g, { phone }), customerId: cust?.id ?? null });
    phone ? summary.newPhoneContactsViaCustomer++ : summary.newEmailOnlyContacts++;
    if (g.emailEligible) summary.newEmailConsent++; else if (g.marketing && !g.verified) summary.newPendingVerificationNoConsent++;
    const nm = `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
    if (!cust && nm && noEmailByName.get(nm) === 1) summary.nameOnlyCandidates++;
  }

  summary.waiversToUpsert = records.length;
  if (dryRun) return summary;

  // ── writes ──
  for (const u of updates) {
    const { error } = await crm.from("contacts").update(u.patch).eq("id", u.id);
    if (error) throw new Error(`waiver import: contact update failed: ${error.message}`);
  }
  for (const ins of inserts) {
    const { data, error } = await crm.from("contacts").insert(ins.row).select("id").single();
    if (error || !data) {
      // e.g. lost a race on the unique email-only key → fall back to the row that won
      const { data: again } = await crm.from("contacts").select("id").ilike("email", ins.g.email).limit(1).maybeSingle();
      if (again) waiverContact.set(ins.g.email, { contactId: again.id, customerId: ins.customerId });
      else summary.insertErrors++;
      continue;
    }
    waiverContact.set(ins.g.email, { contactId: data.id, customerId: ins.customerId });
  }
  for (let i = 0; i < records.length; i += WRITE_CHUNK) {
    const rows = records.slice(i, i + WRITE_CHUNK).map(w => ({
      provider: "smartwaiver", waiver_id: w.waiverId, client_id: CLIENT_ID,
      first_name: w.firstName, last_name: w.lastName, email: w.email, signed_at: w.signedAt,
      status: w.status, document_title: w.documentTitle, marketing_opt_in: w.marketing,
      contact_id:  waiverContact.get(w.email)?.contactId ?? null,
      customer_id: waiverContact.get(w.email)?.customerId ?? null,
    }));
    const { error } = await crm.from("waivers").upsert(rows, { onConflict: "provider,waiver_id" });
    if (error) throw new Error(`waiver import: waivers upsert failed: ${error.message}`);
  }
  return summary;
}

export function recordsFromCsv(text) {
  const [cols, ...rows] = parseCsv(text);
  if (!cols) return { records: [], skipped: 0 };
  const records = [];
  let skipped = 0;
  for (const cells of rows) {
    const rec = normalizeWaiverRow(cols, cells);
    rec ? records.push(rec) : skipped++;
  }
  return { records, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) { console.error("usage: node --env-file=.env waiverImport.js <file.csv> [--apply]"); process.exit(1); }
  const fs = await import("fs");
  const { createClient } = await import("@supabase/supabase-js");
  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_KEY) { console.error("CRM_SUPABASE_URL/KEY not set"); process.exit(1); }
  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
  const { records, skipped } = recordsFromCsv(fs.readFileSync(file, "utf8"));
  const s = await importWaivers(crm, records, { dryRun: !apply });
  console.log(JSON.stringify({ skippedRows: skipped, ...s }, null, 2));
  console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
}
