// ─────────────────────────────────────────────────────────────────────────────
// EMAIL DOMAINS — per-client Resend sending domain (Email Marketing Phase 2,
// see Roadmap "PLANNED — Email Marketing"). Orchestrates resendDomains.js
// (the Resend API) against the client_email_domains DB1 table.
//
//   getClientDomain()       — read the stored row (or null)
//   createClientDomain()    — register a new domain with Resend + insert row
//   refreshClientDomain()   — re-fetch verification status/records from Resend
//   deleteClientDomain()    — remove the row (does not delete from Resend)
//   resolveSendFrom()       — pure: verified domain → full from-address, else null
//
// Non-breaking: every sender (sendTestEmail, and later the real send
// pipeline) falls back to the existing shared RESEND_FROM_EMAIL whenever a
// client has no row here or isn't verified yet — this module only ever
// ADDS an option, never removes the existing default path.
// ─────────────────────────────────────────────────────────────────────────────

import { registerDomain, fetchDomain, triggerVerify, normalizeDomainStatus } from "./resendDomains.js";

function isMissingTableError(error) {
  if (!error) return false;
  const msg = (error.message ?? "") + " " + (error.details ?? "");
  return error.code === "42P01" || /relation .* does not exist/i.test(msg);
}

// ── getClientDomain ───────────────────────────────────────────────────────────
export async function getClientDomain(supabase, clientId) {
  if (!supabase || !clientId) return null;
  const { data, error } = await supabase
    .from("client_email_domains")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    if (!isMissingTableError(error)) console.error("[EMAIL DOMAINS] getClientDomain error:", error.message);
    return null;
  }
  return data ?? null;
}

// ── createClientDomain ────────────────────────────────────────────────────────
// Registers `domain` with Resend and stores the result. Throws on a real
// failure (portal surfaces this directly — the admin needs to know if the
// domain string was rejected), but a missing table degrades to a clear error
// rather than a raw Postgres message.
export async function createClientDomain(supabase, clientId, domain, fromLocalPart = "hello") {
  if (!supabase)  throw new Error("DB unavailable");
  if (!clientId)  throw new Error("clientId is required");
  if (!domain)    throw new Error("domain is required");

  const result = await registerDomain(domain);
  if (!result.ok) {
    throw new Error(`Resend rejected the domain: ${result.reason ?? "unknown error"}`);
  }
  const rd = result.domain;

  const { data, error } = await supabase
    .from("client_email_domains")
    .upsert({
      client_id:        clientId,
      domain,
      resend_domain_id: rd.id,
      from_local_part:  fromLocalPart || "hello",
      status:            normalizeDomainStatus(rd.status),
      records:           rd.records ?? [],
      region:            rd.region ?? null,
      last_checked_at:   new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    }, { onConflict: "client_id" })
    .select()
    .single();

  if (error) throw new Error(`[EMAIL DOMAINS] save failed: ${error.message}`);
  return data;
}

// ── refreshClientDomain ───────────────────────────────────────────────────────
// Re-checks the domain's verification status against Resend. `forceVerify`
// triggers Resend's active re-check (POST /verify) before reading status —
// use for a user-initiated "Check now" click; omit for a passive page-load read.
export async function refreshClientDomain(supabase, clientId, { forceVerify = false } = {}) {
  const existing = await getClientDomain(supabase, clientId);
  if (!existing) return null;
  if (!existing.resend_domain_id) return existing;

  if (forceVerify) await triggerVerify(existing.resend_domain_id);

  const result = await fetchDomain(existing.resend_domain_id);
  if (!result.ok) return existing; // degrade to the last-known DB row

  const rd = result.domain;
  const { data, error } = await supabase
    .from("client_email_domains")
    .update({
      status:          normalizeDomainStatus(rd.status),
      records:         rd.records ?? existing.records,
      last_checked_at: new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    })
    .eq("client_id", clientId)
    .select()
    .single();

  if (error) {
    console.error("[EMAIL DOMAINS] refresh save failed:", error.message);
    return existing;
  }
  return data;
}

// ── deleteClientDomain ────────────────────────────────────────────────────────
export async function deleteClientDomain(supabase, clientId) {
  if (!supabase || !clientId) return;
  const { error } = await supabase.from("client_email_domains").delete().eq("client_id", clientId);
  if (error) throw new Error(`[EMAIL DOMAINS] delete failed: ${error.message}`);
}

// ── resolveSendFrom ───────────────────────────────────────────────────────────
// Pure. Returns the full "Display Name <local@domain>" to send from once a
// client's own domain is verified, or null to signal "use the shared
// fallback" (emailService.js's default RESEND_FROM_EMAIL). Never returns an
// address for anything short of status==="verified" — the whole point of
// Phase 2 is that an unverified domain must never silently start sending
// (same failure class as the RESEND_FROM_EMAIL invite-delivery incident).
export function resolveSendFrom(domainRow, displayName) {
  if (!domainRow || domainRow.status !== "verified" || !domainRow.domain) return null;
  const local = domainRow.from_local_part || "hello";
  const name  = displayName || domainRow.domain;
  return `${name} <${local}@${domainRow.domain}>`;
}
