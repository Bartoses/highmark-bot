// ─────────────────────────────────────────────────────────────────────────────
// FAREHARBOR BOOKING NORMALIZER — makes raw FareHarbor rows visible to the CRM
//
// FareHarbor bookings reach DB2 `bookings` through an external webhook writer
// (the "Supabase" webhook → separate Railway service, NOT this repo). It stores
// the raw FH payload plus a few columns but leaves `customer_id` and
// `activity_id` NULL. `daily_manifest` INNER JOINs customers + activities, so a
// row missing either is invisible to the ops board, briefings and revenue.
//
// This module fills the gaps from the stored `raw_payload`, and ONLY ever fills
// a column that is currently NULL — it never overwrites a value (earlier imports
// mapped ~8% of activities by hand; those stay as they are).
//   customer_id → find/create a `customers` row from payload contact (phone key)
//   activity_id → activities.fareharbor_item_name == payload availability.item.name
//                 (only when exactly one activity matches — ambiguous = skipped)
//   total_cents / total_paid_cents → mirror receipt_total / amount_paid (MPWR does
//                 the same); the view reads receipt_total_cents/amount_paid_cents,
//                 which the writer already populates.
//
// Deliberately NOT done: mirroring into CRM `contacts`. That table drives SMS
// campaigns and upsertContact opts new contacts in — a consent decision, not a
// data-hygiene one, so it stays out of an automated backfill.
//
// Two modes (cron-worker.js):
//   "recent" — every tick: rows updated in the last 7 days (the webhook trickle;
//              self-heals if the external writer re-upserts a row and nulls it)
//   "full"   — daily + one-off backfill: every candidate row since `since`
// ─────────────────────────────────────────────────────────────────────────────
import { normalizePhone } from "./phoneUtils.js";

// Older history (2021–22) was never linked by the original import; leave it be
// unless someone widens this on purpose.
export const FH_NORMALIZE_SINCE = "2025-01-01";
const RECENT_DAYS = 7;

const SELECT_COLS =
  "fareharbor_pk, company, start_at, customer_id, activity_id, receipt_total_cents, " +
  "total_cents, amount_paid_cents, total_paid_cents, raw_payload";

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Bulk-loaded rows store the booking object directly; webhook rows wrap it as
// { booking: {...} }. Returns the booking object or null.
export function unwrapFhPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const b = raw.booking && typeof raw.booking === "object" ? raw.booking : raw;
  return b.pk != null || b.contact || b.availability ? b : null;
}

function toCents(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function extractFhBookingFields(raw) {
  const b = unwrapFhPayload(raw);
  if (!b) return null;
  const name  = typeof b.contact?.name  === "string" ? b.contact.name.trim()  : "";
  const email = typeof b.contact?.email === "string" ? b.contact.email.trim() : "";
  return {
    contactName:       name || null,
    contactPhone:      normalizePhone(b.contact?.phone),
    contactEmail:      email || null,
    itemName:          b.availability?.item?.name ?? null,
    receiptTotalCents: toCents(b.receipt_total),
    amountPaidCents:   toCents(b.amount_paid),
  };
}

// item name → activity id, only where the match is unambiguous. If several
// activities share a name, a single non-archived one wins; otherwise no entry.
export function buildActivityIndex(activities = []) {
  const byName = new Map();
  for (const a of activities) {
    if (!a?.fareharbor_item_name) continue;
    if (!byName.has(a.fareharbor_item_name)) byName.set(a.fareharbor_item_name, []);
    byName.get(a.fareharbor_item_name).push(a);
  }
  const index = new Map();
  for (const [name, list] of byName) {
    if (list.length === 1) { index.set(name, list[0].id); continue; }
    const live = list.filter(a => !a.is_archived);
    if (live.length === 1) index.set(name, live[0].id);
  }
  return index;
}

// The UPDATE patch for one row — only columns that are currently NULL.
export function planBookingPatch(row, fields, { customerId = null, activityId = null } = {}) {
  const patch = {};
  if (row.customer_id == null && customerId) patch.customer_id = customerId;
  if (row.activity_id == null && activityId) patch.activity_id = activityId;
  if (fields?.receiptTotalCents != null && row.total_cents == null)     patch.total_cents = fields.receiptTotalCents;
  if (fields?.amountPaidCents   != null && row.total_paid_cents == null) patch.total_paid_cents = fields.amountPaidCents;
  return patch;
}

// ── Customer resolution ──────────────────────────────────────────────────────
// Find-or-create by phone (the customers unique key), else by name with a null
// phone. Existing rows are reused as-is — never renamed or re-companied.
async function findOrCreateCustomer(crm, { name, phone, email, company }, { create }) {
  if (phone) {
    const { data: hit } = await crm.from("customers").select("id, email").eq("normalized_phone", phone).maybeSingle();
    if (hit) {
      if (create && email && !hit.email) await crm.from("customers").update({ email }).eq("id", hit.id);
      return { id: hit.id, created: false };
    }
  } else if (name) {
    const { data: hit } = await crm.from("customers").select("id").eq("name", name).is("normalized_phone", null).maybeSingle();
    if (hit) return { id: hit.id, created: false };
  } else {
    return { id: null, created: false };
  }
  if (!create) return { id: "(new)", created: true }; // dry run: would create

  const row = { name, normalized_phone: phone ?? null, company: company ?? null, ...(email ? { email } : {}) };
  const { data: made, error } = await crm.from("customers").insert(row).select("id").single();
  if (!error && made) return { id: made.id, created: true };
  // Lost a race on the unique phone key → someone else just created it.
  if (phone) {
    const { data: again } = await crm.from("customers").select("id").eq("normalized_phone", phone).maybeSingle();
    if (again) return { id: again.id, created: false };
  }
  throw new Error(error?.message ?? "customer insert failed");
}

// ── Main entry ───────────────────────────────────────────────────────────────
// PostgREST caps a single response at 1000 rows, so candidates are listed in
// stable pages (ordered by pk, no writes yet — updating mid-paging would shift
// the filter and skip rows), then processed in chunks that fetch the heavy
// raw_payload.
const PAGE = 1000;
const CHUNK = 150;

async function listCandidatePks(crm, { mode, since, maxRows }) {
  const pks = [];
  for (let from = 0; pks.length < maxRows; from += PAGE) {
    let q = crm.from("bookings").select("fareharbor_pk")
      .like("fareharbor_pk", "#%")
      .gte("start_at", since)
      .or("customer_id.is.null,activity_id.is.null,total_cents.is.null,total_paid_cents.is.null")
      .order("fareharbor_pk", { ascending: true })
      .range(from, from + PAGE - 1);
    if (mode === "recent") q = q.gte("updated_at", new Date(Date.now() - RECENT_DAYS * 864e5).toISOString());
    const { data, error } = await q;
    if (error) throw new Error(`fareharbor normalizer query failed: ${error.message}`);
    pks.push(...(data ?? []).map(r => r.fareharbor_pk));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return pks.slice(0, maxRows);
}

export async function normalizeFareHarborBookings(crm, {
  mode = "recent", since = FH_NORMALIZE_SINCE, maxRows = 10000, dryRun = false,
} = {}) {
  const summary = {
    mode, dryRun, scanned: 0, updated: 0,
    customersLinked: 0, customersCreated: 0, activitiesLinked: 0, totalsFilled: 0,
    unresolved: [], samples: [],
  };
  if (!crm) return summary;

  const pks = await listCandidatePks(crm, { mode, since, maxRows });
  if (!pks.length) return summary;

  const { data: acts, error: actErr } = await crm.from("activities").select("id, fareharbor_item_name, is_archived");
  if (actErr) throw new Error(`fareharbor normalizer activities query failed: ${actErr.message}`);
  const activityIndex = buildActivityIndex(acts ?? []);

  const customerCache = new Map();

  const processRow = async (row) => {
    summary.scanned++;
    const f = extractFhBookingFields(row.raw_payload);
    if (!f) { summary.unresolved.push({ pk: row.fareharbor_pk, reason: "no_payload" }); return; }

    let customerId = null, customerCreated = false;
    if (row.customer_id == null) {
      const key = f.contactPhone ?? `name:${f.contactName ?? ""}`;
      if (!f.contactPhone && !f.contactName) {
        summary.unresolved.push({ pk: row.fareharbor_pk, reason: "no_contact" });
      } else {
        if (!customerCache.has(key)) {
          customerCache.set(key, await findOrCreateCustomer(crm, {
            name: f.contactName, phone: f.contactPhone, email: f.contactEmail, company: row.company,
          }, { create: !dryRun }));
        }
        const c = customerCache.get(key);
        customerId = c.id;
        // Count a creation once (the first row that triggered it), not per booking.
        if (c.created && !c.counted) { c.counted = true; customerCreated = true; }
      }
    }

    let activityId = null;
    if (row.activity_id == null) {
      activityId = f.itemName ? activityIndex.get(f.itemName) ?? null : null;
      if (!activityId) summary.unresolved.push({ pk: row.fareharbor_pk, reason: `no_activity_match:${f.itemName ?? "none"}` });
    }

    const patch = planBookingPatch(row, f, { customerId, activityId });
    if (!Object.keys(patch).length) return;

    if (!dryRun) {
      const { error: upErr } = await crm.from("bookings").update(patch).eq("fareharbor_pk", row.fareharbor_pk);
      if (upErr) { summary.unresolved.push({ pk: row.fareharbor_pk, reason: `update_failed:${upErr.message}` }); return; }
    }
    summary.updated++;
    if (patch.customer_id) summary.customersLinked++;
    if (customerCreated)   summary.customersCreated++;
    if (patch.activity_id) summary.activitiesLinked++;
    if (patch.total_cents != null || patch.total_paid_cents != null) summary.totalsFilled++;
    if (summary.samples.length < 10) summary.samples.push({ pk: row.fareharbor_pk, fields: Object.keys(patch) });
  };

  for (let i = 0; i < pks.length; i += CHUNK) {
    const { data, error } = await crm.from("bookings").select(SELECT_COLS).in("fareharbor_pk", pks.slice(i, i + CHUNK));
    if (error) throw new Error(`fareharbor normalizer fetch failed: ${error.message}`);
    for (const row of data ?? []) await processRow(row);
  }
  return summary;
}

// ── CLI: one-off / manual run ────────────────────────────────────────────────
//   node --env-file=.env fareharborNormalizer.js            → dry run (writes nothing)
//   node --env-file=.env fareharborNormalizer.js --apply    → apply, full window
//   flags: --recent (recent mode), --since=YYYY-MM-DD
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args  = process.argv.slice(2);
  const apply = args.includes("--apply");
  const since = args.find(a => a.startsWith("--since="))?.split("=")[1] ?? FH_NORMALIZE_SINCE;
  const mode  = args.includes("--recent") ? "recent" : "full";
  const { createClient } = await import("@supabase/supabase-js");
  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_KEY) {
    console.error("CRM_SUPABASE_URL / CRM_SUPABASE_KEY not set"); process.exit(1);
  }
  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
  const s = await normalizeFareHarborBookings(crm, { mode, since, dryRun: !apply });
  const reasons = {};
  for (const u of s.unresolved) { const k = u.reason.replace(/:.*/, ""); reasons[k] = (reasons[k] || 0) + 1; }
  console.log(JSON.stringify({ ...s, unresolved: reasons, unresolvedExamples: s.unresolved.slice(0, 5) }, null, 2));
  console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
}
