// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SUPPRESSION — "never email this address again", enforced per ADDRESS
//
// A person can appear as several `contacts` rows (a phone contact from a booking, an
// email-only contact from a waiver, …). Opting out on ONE row must silence the
// address everywhere, so suppression is keyed by lowercased email, not by row:
//   • unsubscribed  (email_unsubscribed_at)  — the person asked us to stop marketing
//   • suppressed    (email_suppressed_at)    — hard bounce / spam complaint / manual
//
// Marketing mail skips BOTH. Transactional mail (booking confirmations) skips only
// `suppressed` — an address that bounced or complained is not deliverable/safe, but
// someone who unsubscribed from newsletters still gets mail about their own booking.
//
// suppressEmail() also creates an email-only "do not email" record when the address
// isn't a contact at all, so a later import (waiver, FareHarbor) can never quietly
// re-add it with fresh consent.
// ─────────────────────────────────────────────────────────────────────────────
const PAGE = 1000;

export const normEmail = (e) => String(e ?? "").trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const isEmailAddress = (e) => EMAIL_RE.test(normEmail(e));

// ilike treats _ and % as wildcards; "john_smith@x.com" must not match "johnXsmith@x.com".
export const escapeLike = (s) => String(s).replace(/[\\_%]/g, (m) => "\\" + m);

// { all: Set (unsubscribed OR suppressed), hard: Set (suppressed only) }
export async function loadSuppressionSets(crm) {
  const all = new Set(), hard = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await crm.from("contacts")
      .select("email, email_unsubscribed_at, email_suppressed_at")
      .not("email", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`suppression list read failed: ${error.message}`);
    for (const r of data ?? []) {
      const e = normEmail(r.email);
      if (!e) continue;
      if (r.email_unsubscribed_at || r.email_suppressed_at) all.add(e);
      if (r.email_suppressed_at) hard.add(e);
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  return { all, hard };
}

// Mark an address unsubscribed and/or suppressed on EVERY contact row that carries it.
//   reason:      'unsubscribe' | 'bounce' | 'complaint' | 'manual' | 'legacy_unsubscribe'
//   unsubscribe: also set email_unsubscribed_at (an unsubscribe, or a spam complaint)
//   suppress:    set email_suppressed_at (bounce / complaint / manual block)
export async function suppressEmail(crm, email, { reason, unsubscribe = false, suppress = false, at = new Date().toISOString(), clientId = process.env.CLIENT_ID || "csr_rea" } = {}) {
  const e = normEmail(email);
  if (!isEmailAddress(e)) return { updated: 0, created: false };
  const patch = { email_marketing_consent: false };
  if (unsubscribe) patch.email_unsubscribed_at = at;
  if (suppress) { patch.email_suppressed_at = at; patch.email_suppressed_reason = reason ?? "manual"; }

  const { data, error } = await crm.from("contacts").update(patch).ilike("email", escapeLike(e)).select("id");
  if (error) throw new Error(`suppressEmail update failed: ${error.message}`);
  if ((data?.length ?? 0) > 0) return { updated: data.length, created: false };

  // Not a contact yet → record the do-not-email so nothing can re-add it with consent.
  const row = {
    phone: null, email: e, source: reason === "legacy_unsubscribe" ? "legacy_unsubscribe" : `suppressed_${reason ?? "manual"}`,
    client_id: clientId, tags: [], total_bookings: 0,
    opted_in: false, email_marketing_consent: false, ...patch,
  };
  const ins = await crm.from("contacts").insert(row).select("id").single();
  if (ins.error) {
    // lost a race on the email-only unique key → someone created it; apply the patch to it
    const retry = await crm.from("contacts").update(patch).ilike("email", escapeLike(e)).select("id");
    if (retry.error) throw new Error(`suppressEmail failed: ${ins.error.message}`);
    return { updated: retry.data?.length ?? 0, created: false };
  }
  return { updated: 0, created: true };
}
