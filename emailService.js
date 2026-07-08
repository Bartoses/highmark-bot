// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SERVICE — Resend-backed transactional email (portal invites, etc.)
//
// Thin wrapper around the Resend REST API (no SDK dependency). Degrades
// gracefully when unconfigured: sendEmail() returns { sent:false } instead of
// throwing, so callers can always fall back to another delivery channel
// (SMS) or a manual copy-link.
//
// Env: RESEND_API_KEY (required to actually send), RESEND_FROM_EMAIL
// (optional, defaults to a Resend sandbox sender — replace once a sending
// domain is verified in the Resend dashboard).
//
// TEST_MODE guard: mirrors the pattern used for outbound SMS elsewhere in
// this codebase (selfSignup.js notifyTeam, campaigns.js enqueueCampaign) —
// the integration test suite runs against the live DB with real credentials
// in .env, so sendEmail() must never fire for real during `npm test`.
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_API_URL = "https://api.resend.com/emails";

export function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// displayName lets a caller show e.g. "Colorado Sled Rentals" in the From
// field while still sending from the one Resend-verified address configured
// via RESEND_FROM_EMAIL. fromOverride (a full "Name <local@domain>" string)
// takes precedence over both — used once a client's own domain is verified
// in Resend (emailDomains.js resolveSendFrom(), Email Marketing Phase 2).
function fromAddress(displayName, fromOverride) {
  if (fromOverride) return fromOverride;
  const configured = process.env.RESEND_FROM_EMAIL || "Highmark <onboarding@resend.dev>";
  if (!displayName) return configured;
  const match = configured.match(/<(.+)>/);
  const address = match ? match[1] : configured;
  return `${displayName} <${address}>`;
}

/**
 * Sends a transactional email via Resend.
 * Returns { sent: true, id } on success, or { sent: false, reason } — never throws.
 * `from` (optional) — display name shown in the From field (see fromAddress above).
 * `replyTo` (optional) — Reply-To address; lets a client's replies land in their real inbox.
 * `fromOverride` (optional) — full "Name <local@domain>" address; wins over `from`/RESEND_FROM_EMAIL.
 */
export async function sendEmail({ to, subject, html, text, from, replyTo, fromOverride }) {
  if (process.env.TEST_MODE === "true") return { sent: false, reason: "test_mode" };
  if (!process.env.RESEND_API_KEY)      return { sent: false, reason: "not_configured" };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(from, fromOverride),
        to: [to],
        subject, html, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[EMAIL] Resend send failed (${res.status}):`, body.slice(0, 300));
      return { sent: false, reason: "provider_error", status: res.status };
    }

    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data.id ?? null };
  } catch (err) {
    console.error("[EMAIL] Resend send error:", err.message);
    return { sent: false, reason: "network_error" };
  }
}

const ROLE_LABELS = {
  internal_admin: "an internal admin",
  client_admin:   "a manager",
  client_user:    "a team member",
};

/**
 * Builds the subject/html/text for a portal invite email.
 * Pure — no I/O, safe to unit test directly.
 */
export function buildInviteEmail({ email, inviteUrl, role, clientName }) {
  const roleLabel = ROLE_LABELS[role] ?? "a team member";
  const forClient  = clientName ? ` for ${clientName}` : "";

  const subject = clientName
    ? `You're invited to the ${clientName} Highmark portal`
    : "You're invited to the Highmark portal";

  const text = `You've been invited to the Highmark portal${forClient} as ${roleLabel}.

Set up your account (expires in 72 hours, one-time use):
${inviteUrl}

If you weren't expecting this invite, you can safely ignore this email.`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <p style="font-size:18px;font-weight:700;letter-spacing:.03em;margin:0 0 24px">High<span style="color:#10b981">mark</span></p>
  <h1 style="font-size:19px;margin:0 0 10px">You're invited${forClient}</h1>
  <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px">
    You've been invited to the Highmark portal as ${roleLabel}. Click below to set a password and activate your account.
  </p>
  <p style="margin:0 0 24px">
    <a href="${inviteUrl}" style="background:#10b981;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px">Activate your account</a>
  </p>
  <p style="color:#999;font-size:12px;line-height:1.5">
    This link expires in 72 hours and can only be used once. If you weren't expecting this invite, you can safely ignore this email.
  </p>
</div>`;

  return { subject, html, text };
}

export const _internal = { fromAddress };
