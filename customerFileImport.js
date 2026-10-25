// ─────────────────────────────────────────────────────────────────────────────
// POLARIS / MPWR CUSTOMER-FILE IMPORT — "everyone who has ever ridden" → DB2 `contacts`
//
// Polaris (Mike Keehn, 2026-10-22) sent CSR an export of every passenger (Adult) and driver
// (Primary) since the beginning: name, email, phone, address, DOB (from the licence scan),
// store, program (mpwr | arrival), vehicle type, last-activity date. This loads them into the
// CRM so they can be emailed/marketed to — with NO duplicates.
//
// PRIVACY: date of birth and the street address / postal code are NEVER read into a record
// (not needed to market to or recognise a guest — same rule as waiverImport.js). For .xlsx input
// the CLI also strips those columns at conversion time, so they never reach this process.
//
// DEDUPE (one real person → one contact):
//   1. within the file   — grouped by lowercased email (a person listed on 3 rides, or a family
//                          sharing one address, becomes ONE group; the most recent row wins the
//                          name/phone). Rows without an email group by phone. A phone-only row is
//                          folded into an email group that has the same phone.
//   2. phone uniqueness  — a phone can belong to only one contact; if two email-groups share one,
//                          the most recent keeps it and the other becomes email-only.
//   3. against the CRM   — match by EMAIL first (any contact carrying it), then by PHONE. Matched
//                          contacts are only ENRICHED (blanks filled, tags unioned, last_activity
//                          advanced) — never duplicated, never renamed, consent never touched.
//                          A phone whose contact has a DIFFERENT email is left alone + counted.
//   Re-running the same file is a no-op.
//
// CONSENT — be honest about what this file is: these people never ticked a marketing box with us.
//   NEW contact with an email → email_marketing_consent=true, email_consent_source='grandfathered'
//     (the existing "past customer, not explicit" class): the send pipeline EXCLUDES them unless the
//     sender sets segment.include_grandfathered=true for that send, and every email carries the
//     CAN-SPAM footer + one-click unsubscribe. An address already unsubscribed/suppressed anywhere
//     in the CRM is imported WITHOUT consent.
//   SMS: opted_in is ALWAYS written false (never texted — no TCPA consent exists in this file).
//   Junk addresses (placeholders, internal domains, obvious domain typos) are dropped to protect
//   sender reputation; the person is still imported if they have a usable phone.
//
// CLI (dry-run by default):
//   node --env-file=.env customerFileImport.js <file.xlsx|file.csv>            → plan, writes nothing
//   node --env-file=.env customerFileImport.js <file.xlsx|file.csv> --apply    → writes
// ─────────────────────────────────────────────────────────────────────────────
import { normalizePhone, isValidPhone, isTestPhone } from "./phoneUtils.js";
import { parseCsv, tidyName, isLater } from "./waiverImport.js";

const CLIENT_ID = process.env.CLIENT_ID || "csr_rea";
export const SOURCE = "polaris_customer_file";
const PAGE = 1000;
const INSERT_CHUNK = 200;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Our own staff/test addresses are not customers.
const INTERNAL_DOMAINS = new Set(["coloradosledrentals.com", "usehighmark.com", "polaris.com"]);
// Common keyboard slips. Dropping beats bouncing (a bounce suppresses the address AND dents reputation).
const TYPO_DOMAINS = new Set(["gmial.com", "gmal.com", "gmai.com", "gnail.com", "gmail.con", "gmail.co", "gmail.cm", "gamil.com",
  "yaho.com", "yahooo.com", "yahoo.con", "yahoo.co", "hotmial.com", "hotmai.com", "hotmail.con", "outlok.com", "outlook.con", "icloud.con", "iclould.com", "comcast.con"]);
const JUNK_LOCALS = new Set(["noemail", "none", "no", "na", "n/a", "nomail", "test", "tester", "unknown", "noreply", "no-reply", "donotreply", "null", "email", "x", "xx", "xxx"]);

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// → { email|null, dropped: null | 'invalid' | 'junk' | 'internal' | 'typo_domain' }
export function cleanEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "").replace(/[;,\s]+$/, "");
  if (!e) return { email: null, dropped: null };
  if (!EMAIL_RE.test(e)) return { email: null, dropped: "invalid" };
  const [local, domain] = e.split("@");
  if (JUNK_LOCALS.has(local) || /^(no|none|na)\d*$/.test(local)) return { email: null, dropped: "junk" };
  if (INTERNAL_DOMAINS.has(domain)) return { email: null, dropped: "internal" };
  if (TYPO_DOMAINS.has(domain)) return { email: null, dropped: "typo_domain" };
  return { email: e, dropped: null };
}

// Excel hands numbers back as 5419685982 / "5419685982.0"; fake/test numbers are dropped.
export function cleanPhone(raw) {
  const s = String(raw ?? "").trim().replace(/\.0+$/, "");
  const p = normalizePhone(s);
  if (!p || !isValidPhone(p) || isTestPhone(p)) return null;
  const d = p.replace(/^\+1/, "");
  if (/^(\d)\1{9}$/.test(d) || d === "1234567890" || /^[01]/.test(d)) return null;    // 0000000000, 1234567890, impossible area codes
  return p;
}

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const VEHICLE_TAG = { sxs: "rzr", rzr: "rzr", snowmobile: "snowmobile", sled: "snowmobile", snow: "snowmobile" };

export function storeTags(store) {
  const s = String(store ?? "");
  const tags = [];
  if (/rabbit ears/i.test(s)) tags.push("rea"); else if (/colorado sled/i.test(s)) tags.push("csr");
  const loc = s.includes("-") ? slug(s.split("-").pop()) : "";
  if (loc) tags.push(loc);
  return tags;
}

// Header-driven (case-insensitive) so column order / extra columns in a future export don't matter.
// Deliberately never reads DOB / Address1 / Address2 / Postal Code.
export function normalizeCustomerRow(cols, cells) {
  const idx = new Map(cols.map((c, i) => [String(c).trim().toLowerCase(), i]));
  const get = (name) => String(cells[idx.get(name.toLowerCase())] ?? "").trim();
  const { email, dropped } = cleanEmail(get("Email"));
  const phone = cleanPhone(get("Phone"));
  if (!email && !phone) return { rec: null, dropped };
  const la = get("Last Activity");
  const t = la ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(la) ? `${la}T12:00:00Z` : la) : NaN;
  const state = slug(get("State"));
  const veh = slug(get("Vehicle Type"));
  const tags = new Set(["customer", SOURCE, ...storeTags(get("Store"))]);
  const program = slug(get("Program")); if (program) tags.add(program);
  if (veh) tags.add(VEHICLE_TAG[veh] ?? veh);
  if (state.length === 2 && /^united states|^us/i.test(get("Country") || "united states")) tags.add(`state_${state}`);
  const risk = get("High Risk Customer?");
  if (risk && !/^(n|no|false|0)$/i.test(risk)) tags.add("high_risk");
  return {
    rec: {
      email, phone,
      firstName: tidyName(get("firstName")), lastName: tidyName(get("lastName")),
      lastActivity: Number.isFinite(t) ? new Date(t).toISOString() : null,
      tags: [...tags],
    },
    dropped,
  };
}

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : -Infinity; };

// Many rows → one group per person (see DEDUPE above). Returns { groups, stats }.
export function aggregateCustomers(records) {
  const sorted = [...records].sort((a, b) => ms(a.lastActivity) - ms(b.lastActivity));   // oldest first → newest wins
  const byEmail = new Map(), phoneOnly = [];
  const fold = (g, r, { names = true } = {}) => {
    if (names) { g.firstName = r.firstName ?? g.firstName; g.lastName = r.lastName ?? g.lastName; }
    else { g.firstName ??= r.firstName; g.lastName ??= r.lastName; }    // a no-email row only fills blanks: it may be someone else on a shared phone
    g.phone = r.phone ?? g.phone;
    if (r.lastActivity && ms(r.lastActivity) >= ms(g.lastActivity)) g.lastActivity = r.lastActivity;
    for (const t of r.tags) g.tags.add(t);
    g.rows++;
  };
  const fresh = (r) => ({ email: r.email, phone: null, firstName: null, lastName: null, lastActivity: null, tags: new Set(), rows: 0 });
  for (const r of sorted) {
    if (r.email) { const g = byEmail.get(r.email) ?? fresh(r); fold(g, r); byEmail.set(r.email, g); }
    else phoneOnly.push(r);
  }
  const stats = { phoneOnlyFolded: 0, phoneReassigned: 0 };
  // fold phone-only rows into the email group that already has that phone
  const groupByPhone = new Map();
  for (const g of byEmail.values()) if (g.phone) {
    const cur = groupByPhone.get(g.phone);
    if (!cur) groupByPhone.set(g.phone, g);
    else if (ms(g.lastActivity) > ms(cur.lastActivity)) { cur.phone = null; stats.phoneReassigned++; groupByPhone.set(g.phone, g); }   // newest keeps the phone
    else { g.phone = null; stats.phoneReassigned++; }
  }
  const phoneGroups = new Map();
  for (const r of phoneOnly) {
    const host = groupByPhone.get(r.phone);
    if (host) { fold(host, { ...r, phone: null }, { names: false }); stats.phoneOnlyFolded++; continue; }
    const g = phoneGroups.get(r.phone) ?? { ...fresh(r), phone: r.phone };
    fold(g, r); phoneGroups.set(r.phone, g);
  }
  return { groups: [...byEmail.values(), ...phoneGroups.values()], stats };
}

// Insert row for a brand-new contact. opted_in / consent are ALWAYS explicit (columns default TRUE).
export function buildNewContact(g, { suppressed = false } = {}) {
  const consent = !!g.email && !suppressed;
  return {
    phone: g.phone ?? null, first_name: g.firstName, last_name: g.lastName, email: g.email ?? null,
    source: SOURCE, tags: [...g.tags],
    last_activity: g.lastActivity ?? new Date().toISOString(), total_bookings: 0, client_id: CLIENT_ID,
    opted_in: false, opted_out_at: null, sms_consent_source: null, sms_consent_at: null,
    email_marketing_consent: consent,
    email_consent_source: consent ? "grandfathered" : null,
    email_consent_at: null, email_verified_at: null,
  };
}

// Patch for an existing contact — blanks, tags and recency only. Consent is NEVER touched.
export function planEnrichment(g, c, { phoneFree = false } = {}) {
  const patch = {};
  if (!c.first_name && g.firstName) patch.first_name = g.firstName;
  if (!c.last_name && g.lastName) patch.last_name = g.lastName;
  if (!c.email && g.email) patch.email = g.email;
  if (!c.phone && g.phone && phoneFree) patch.phone = g.phone;       // email-only contact gains a number; never opts in
  const tags = c.tags ?? [];
  const merged = [...new Set([...tags, ...g.tags])];
  if (merged.length !== tags.length) patch.tags = merged;
  if (g.lastActivity && isLater(g.lastActivity, c.last_activity)) patch.last_activity = g.lastActivity;
  return patch;
}

// ── DB ───────────────────────────────────────────────────────────────────────
async function fetchAll(crm, table, cols) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await crm.from(table).select(cols).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`customer import: reading ${table} failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

export async function importCustomers(crm, records, { dryRun = false, rawRows = records?.length ?? 0, droppedEmails = {} } = {}) {
  const summary = {
    dryRun, fileRows: rawRows, usableRows: (records ?? []).length, distinctPeople: 0, duplicateRowsCollapsed: 0,
    phoneOnlyRowsFolded: 0, phonesReassigned: 0, droppedEmails,
    newContacts: 0, newWithEmail: 0, newEmailOnly: 0, newPhoneOnly: 0, newWithoutConsentSuppressed: 0,
    enrichedContacts: 0, alreadyUpToDate: 0, phoneMatchedDifferentEmail: 0, insertErrors: 0,
  };
  if (!crm || !records?.length) return summary;

  const { groups, stats } = aggregateCustomers(records);
  summary.distinctPeople = groups.length;
  summary.duplicateRowsCollapsed = records.length - groups.length;
  summary.phoneOnlyRowsFolded = stats.phoneOnlyFolded;
  summary.phonesReassigned = stats.phoneReassigned;

  const contacts = await fetchAll(crm, "contacts",
    "id, phone, email, first_name, last_name, tags, last_activity, email_unsubscribed_at, email_suppressed_at");
  const byEmail = new Map(), byPhone = new Map();
  for (const c of contacts) {
    if (c.email) { const k = c.email.toLowerCase(); (byEmail.get(k) ?? byEmail.set(k, []).get(k)).push(c); }
    if (c.phone) byPhone.set(c.phone, c);
  }
  // An address unsubscribed/suppressed on ANY contact row is off-limits for consent, wherever else it appears.
  const suppressed = new Set(contacts.filter(c => c.email && (c.email_unsubscribed_at || c.email_suppressed_at)).map(c => c.email.toLowerCase()));

  const inserts = [], updates = [];
  const claimedPhones = new Set();
  for (const g of groups) {
    let matched = g.email ? (byEmail.get(g.email) ?? []) : [];
    if (!matched.length && g.phone && byPhone.has(g.phone)) {
      const hit = byPhone.get(g.phone);
      if (hit.email && g.email && hit.email.toLowerCase() !== g.email) { summary.phoneMatchedDifferentEmail++; continue; }   // someone else's/other address on that number: leave it
      matched = [hit];
    }
    if (matched.length) {
      let changed = false;
      for (const c of matched) {
        const phoneFree = !!g.phone && !byPhone.has(g.phone) && !claimedPhones.has(g.phone);
        const patch = planEnrichment(g, c, { phoneFree });
        if (patch.phone) claimedPhones.add(patch.phone);
        if (Object.keys(patch).length) { updates.push({ id: c.id, patch }); changed = true; }
      }
      changed ? summary.enrichedContacts++ : summary.alreadyUpToDate++;
      continue;
    }
    // genuinely new — never let two new rows claim the same phone
    const gg = g.phone && claimedPhones.has(g.phone) ? { ...g, phone: null } : g;
    if (!gg.email && !gg.phone) continue;
    if (gg.phone) claimedPhones.add(gg.phone);
    const isSupp = !!gg.email && suppressed.has(gg.email);
    if (isSupp) summary.newWithoutConsentSuppressed++;
    inserts.push(buildNewContact(gg, { suppressed: isSupp }));
    summary.newContacts++;
    gg.email && gg.phone ? summary.newWithEmail++ : gg.email ? summary.newEmailOnly++ : summary.newPhoneOnly++;
  }
  if (dryRun) return summary;

  for (const u of updates) {
    const { error } = await crm.from("contacts").update(u.patch).eq("id", u.id);
    if (error) throw new Error(`customer import: contact update failed: ${error.message}`);
  }
  for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
    const chunk = inserts.slice(i, i + INSERT_CHUNK);
    const { error } = await crm.from("contacts").insert(chunk);
    if (!error) continue;
    // one bad row (e.g. a contact created mid-run) fails the whole batch → retry row by row so only it is skipped
    for (const row of chunk) {
      const { error: e1 } = await crm.from("contacts").insert(row);
      if (e1) summary.insertErrors++;
    }
  }
  return summary;
}

export function recordsFromCsv(text) {
  const [cols, ...rows] = parseCsv(text);
  if (!cols) return { records: [], rawRows: 0, droppedEmails: {}, skippedRows: 0 };
  const records = [], droppedEmails = {};
  let skippedRows = 0;
  for (const cells of rows) {
    const { rec, dropped } = normalizeCustomerRow(cols, cells);
    if (dropped) droppedEmails[dropped] = (droppedEmails[dropped] ?? 0) + 1;
    rec ? records.push(rec) : skippedRows++;
  }
  return { records, rawRows: rows.length, droppedEmails, skippedRows };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) { console.error("usage: node --env-file=.env customerFileImport.js <file.xlsx|file.csv> [--apply]"); process.exit(1); }
  const fs = await import("fs");
  let text;
  if (/\.xlsx$/i.test(file)) {
    // Convert with python/openpyxl, EMITTING ONLY the columns we use — DOB and street address never enter this process.
    const { execFileSync } = await import("child_process");
    const py = `
import sys, csv, openpyxl, datetime
keep = ["Store","High Risk Customer?","guestType","firstName","lastName","Email","Phone","City","State","Country","Program","Vehicle Type","Last Activity"]
ws = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True).worksheets[0]
rows = ws.iter_rows(values_only=True); head = [str(h).strip() if h is not None else "" for h in next(rows)]
ix = [head.index(k) for k in keep if k in head]
w = csv.writer(sys.stdout); w.writerow([head[i] for i in ix])
def fmt(v):
    if v is None: return ""
    if isinstance(v, datetime.datetime): return v.date().isoformat()
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)
for r in rows: w.writerow([fmt(r[i]) for i in ix])
`;
    text = execFileSync("python3", ["-I", "-c", py, file], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  } else text = fs.readFileSync(file, "utf8");
  const { createClient } = await import("@supabase/supabase-js");
  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_KEY) { console.error("CRM_SUPABASE_URL/KEY not set"); process.exit(1); }
  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
  const { records, rawRows, droppedEmails, skippedRows } = recordsFromCsv(text);
  const s = await importCustomers(crm, records, { dryRun: !apply, rawRows, droppedEmails });
  console.log(JSON.stringify({ skippedRowsNoEmailNoPhone: skippedRows, ...s }, null, 2));
  console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
}
