// ─────────────────────────────────────────────────────────────────────────────
// RESEND DOMAINS — thin wrapper around the Resend Domain API (per-client
// sending domain verification, Email Marketing Phase 2 — see Roadmap
// "PLANNED — Email Marketing"). Mirrors emailService.js's shape: no SDK
// dependency, degrades gracefully ({ ok:false, reason }) instead of throwing
// so a Resend outage never breaks the portal page around it.
//
// Docs: https://resend.com/docs/api-reference/domains
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_DOMAINS_URL = "https://api.resend.com/domains";

function authHeaders() {
  return {
    Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export function isResendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Registers a new sending domain with Resend. Returns Resend's domain object
// (id, status, records[], region) on success.
export async function registerDomain(domain, region = "us-east-1") {
  if (process.env.TEST_MODE === "true") return { ok: false, reason: "test_mode" };
  if (!process.env.RESEND_API_KEY)      return { ok: false, reason: "not_configured" };

  try {
    const res = await fetch(RESEND_DOMAINS_URL, {
      method:  "POST",
      headers: authHeaders(),
      body:    JSON.stringify({ name: domain, region }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[RESEND DOMAINS] register failed (${res.status}):`, body.slice(0, 300));
      return { ok: false, reason: "provider_error", status: res.status };
    }
    const data = await res.json();
    return { ok: true, domain: data };
  } catch (err) {
    console.error("[RESEND DOMAINS] register error:", err.message);
    return { ok: false, reason: "network_error" };
  }
}

// Fetches current verification status + DNS records for a domain already
// registered with Resend.
export async function fetchDomain(resendDomainId) {
  if (process.env.TEST_MODE === "true") return { ok: false, reason: "test_mode" };
  if (!process.env.RESEND_API_KEY)      return { ok: false, reason: "not_configured" };

  try {
    const res = await fetch(`${RESEND_DOMAINS_URL}/${resendDomainId}`, {
      method:  "GET",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[RESEND DOMAINS] fetch failed (${res.status}):`, body.slice(0, 300));
      return { ok: false, reason: "provider_error", status: res.status };
    }
    const data = await res.json();
    return { ok: true, domain: data };
  } catch (err) {
    console.error("[RESEND DOMAINS] fetch error:", err.message);
    return { ok: false, reason: "network_error" };
  }
}

// Asks Resend to re-check DNS and re-run verification now (rather than
// waiting for its background poll). Follow with fetchDomain() to read the
// resulting status.
export async function triggerVerify(resendDomainId) {
  if (process.env.TEST_MODE === "true") return { ok: false, reason: "test_mode" };
  if (!process.env.RESEND_API_KEY)      return { ok: false, reason: "not_configured" };

  try {
    const res = await fetch(`${RESEND_DOMAINS_URL}/${resendDomainId}/verify`, {
      method:  "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[RESEND DOMAINS] verify failed (${res.status}):`, body.slice(0, 300));
      return { ok: false, reason: "provider_error", status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error("[RESEND DOMAINS] verify error:", err.message);
    return { ok: false, reason: "network_error" };
  }
}

// Normalizes a Resend domain status into ours. Resend uses "not_started" |
// "pending" | "verified" | "failed" | "temporary_failure" today; pass
// through unknowns rather than erroring so a future Resend status addition
// degrades to "unrecognized" instead of throwing.
const KNOWN_STATUSES = ["not_started", "pending", "verified", "failed", "temporary_failure"];
export function normalizeDomainStatus(status) {
  return KNOWN_STATUSES.includes(status) ? status : "not_started";
}
