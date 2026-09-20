// ─────────────────────────────────────────────────────────────────────────────
// IMPORT LEGACY UNSUBSCRIBES — the old Google-Sheet "Unsubscribe" tab → the database
//
// Anyone who unsubscribed through the old Apps Script/Sheet flow must NEVER be emailed by the new
// system. Each address is suppressed at the ADDRESS level (every contact row carrying it), and an
// address that isn't a contact at all gets a "do not email" record so a later import (waiver,
// FareHarbor) can't quietly re-add it with fresh consent.
//
//   node --env-file=.env importUnsubscribes.js <file.csv>            → plan, writes nothing
//   node --env-file=.env importUnsubscribes.js <file.csv> --apply    → writes
// The CSV's first column is the email address (a header row is skipped automatically).
// ─────────────────────────────────────────────────────────────────────────────
import { parseCsv } from "./waiverImport.js";
import { suppressEmail, normEmail, isEmailAddress } from "./emailSuppression.js";

export function parseUnsubscribeCsv(text) {
  const rows = parseCsv(text);
  const seen = new Set(); const emails = []; const invalid = [];
  let duplicates = 0;
  for (const r of rows) {
    const cell = normEmail(r[0]);
    if (!cell) continue;
    if (!cell.includes("@")) continue;                       // header row ("Email Address") / junk cell
    if (!isEmailAddress(cell)) { invalid.push(cell); continue; }
    if (seen.has(cell)) { duplicates++; continue; }
    seen.add(cell); emails.push(cell);
  }
  return { emails, invalid, duplicates };
}

export async function importUnsubscribes(crm, emails, { dryRun = false, at = new Date().toISOString() } = {}) {
  const summary = { dryRun, addresses: emails.length, alreadySuppressed: 0, contactsSuppressed: 0, wereConsentedUntilNow: 0, doNotEmailRecordsCreated: 0 };
  if (!crm || !emails.length) return summary;

  const rowsByEmail = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await crm.from("contacts")
      .select("id, email, email_marketing_consent, email_unsubscribed_at, email_suppressed_at")
      .not("email", "is", null).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`unsubscribe import: contacts read failed: ${error.message}`);
    for (const c of data ?? []) { const k = normEmail(c.email); (rowsByEmail.get(k) ?? rowsByEmail.set(k, []).get(k)).push(c); }
    if ((data?.length ?? 0) < 1000) break;
  }

  for (const email of emails) {
    const rows = rowsByEmail.get(email) ?? [];
    if (rows.length && rows.every(r => r.email_unsubscribed_at || r.email_suppressed_at)) { summary.alreadySuppressed++; continue; }
    if (rows.some(r => r.email_marketing_consent === true && !r.email_unsubscribed_at)) summary.wereConsentedUntilNow++;
    if (rows.length) summary.contactsSuppressed += rows.filter(r => !(r.email_unsubscribed_at || r.email_suppressed_at)).length; else summary.doNotEmailRecordsCreated++;
    if (!dryRun) await suppressEmail(crm, email, { reason: "legacy_unsubscribe", unsubscribe: true, at });
  }
  return summary;
}

import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) { console.error("usage: node --env-file=.env importUnsubscribes.js <file.csv> [--apply]"); process.exit(1); }
  const fs = await import("fs");
  const { createClient } = await import("@supabase/supabase-js");
  if (!process.env.CRM_SUPABASE_URL || !process.env.CRM_SUPABASE_KEY) { console.error("CRM_SUPABASE_URL/KEY not set"); process.exit(1); }
  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
  const { emails, invalid, duplicates } = parseUnsubscribeCsv(fs.readFileSync(file, "utf8"));
  const s = await importUnsubscribes(crm, emails, { dryRun: !apply });
  console.log(JSON.stringify({ skippedInvalidAddresses: invalid.length, duplicateRows: duplicates, ...s }, null, 2));
  console.log(apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply.");
}
