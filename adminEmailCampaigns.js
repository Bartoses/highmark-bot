// ─────────────────────────────────────────────────────────────────────────────
// ADMIN EMAIL CAMPAIGNS — Portal API handlers for the CRM Email Marketing
// feature ("email creation" phase — see Roadmap "PLANNED — Email Marketing",
// added 2026-07-08).
//
// All handlers require req.portalUser (set by requirePortalAuth). Client
// scoping is enforced via resolvePortalClientId(req), same convention as the
// SMS campaign handlers in adminPortal.js.
//
// Routes (registered in index.js):
//   GET    /portal/api/email-campaigns
//   POST   /portal/api/email-campaigns
//   GET    /portal/api/email-campaigns/templates
//   GET    /portal/api/email-campaigns/audience-preview
//   GET    /portal/api/email-campaigns/:id
//   PATCH  /portal/api/email-campaigns/:id
//   DELETE /portal/api/email-campaigns/:id
//   POST   /portal/api/email-campaigns/:id/preview
//   POST   /portal/api/email-campaigns/:id/send-test
//   GET    /portal/api/email-domain                (Phase 2 — per-client sending domain)
//   POST   /portal/api/email-domain
//   POST   /portal/api/email-domain/verify
//   DELETE /portal/api/email-domain
//   GET    /email/unsubscribe/:token           (public, no portal auth)
//
// Deliberately absent: a "send to full audience" route. Real sending is a
// later build phase (bounce/complaint handling needs to land first) — this
// module only creates, previews, and test-sends single emails.
// ─────────────────────────────────────────────────────────────────────────────

import { resolvePortalClientId } from "./portalAuth.js";
import { getAllClients } from "./clients.js";
import { isEmailConfigured } from "./emailService.js";
import {
  createEmailCampaign, listEmailCampaigns, getEmailCampaign,
  updateEmailCampaign, deleteEmailCampaign, selectEmailAudience,
  previewEmailCampaign, sendTestEmail, isValidEmail,
} from "./emailCampaigns.js";
import { EMAIL_TEMPLATES, MERGE_FIELDS } from "./emailTemplates.js";
import {
  getClientDomain, createClientDomain, refreshClientDomain, deleteClientDomain,
} from "./emailDomains.js";
import { isResendConfigured } from "./resendDomains.js";

const DOMAIN_REGEX = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function requireClientAdmin(req, res) {
  if (!req.portalUser?.isClientAdmin) {
    res.status(403).json({ error: "Admin access required — client_admin or internal_admin role needed" });
    return false;
  }
  return true;
}

// ── GET /portal/api/email-campaigns/templates ─────────────────────────────────
export function handlePortalEmailTemplates(_req, res) {
  return res.json({
    templates: Object.values(EMAIL_TEMPLATES),
    merge_fields: MERGE_FIELDS,
    email_configured: isEmailConfigured(),
  });
}

// ── GET /portal/api/email-campaigns/audience-preview ──────────────────────────
export async function handlePortalEmailAudiencePreview(req, res, supabase, crmSupabase = null) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const audienceType = req.query.audience_type ?? "crm_contacts";
  let filterConfig = {};
  if (req.query.filter_config) {
    try { filterConfig = JSON.parse(req.query.filter_config); } catch { /* ignore malformed */ }
  }
  try {
    const recipients = await selectEmailAudience(crmSupabase, { clientId, audienceType, filterConfig });
    const sample = recipients.map(r => r.first_name || r.email).filter(Boolean).slice(0, 5);
    return res.json({ count: recipients.length, sample });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/email-campaigns ────────────────────────────────────────────
export async function handlePortalEmailCampaigns(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const { status, limit, offset } = req.query;
  try {
    const result = await listEmailCampaigns(supabase, { clientId, status, limit, offset });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/email-campaigns ──────────────────────────────────────────
export async function handlePortalCreateEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId)  return res.status(400).json({ error: "client_id is required" });

  const {
    name, template_key, subject, preview_text, body_html,
    from_name, reply_to, audience_type, audience_filter,
  } = req.body;

  if (!name)      return res.status(400).json({ error: "name is required" });
  if (!subject)   return res.status(400).json({ error: "subject is required" });
  if (!body_html) return res.status(400).json({ error: "body_html is required" });

  try {
    const campaign = await createEmailCampaign(supabase, {
      clientId,
      name,
      templateKey:    template_key,
      subject,
      previewText:    preview_text ?? null,
      bodyHtml:       body_html,
      fromName:       from_name ?? null,
      replyTo:        reply_to ?? null,
      audienceType:   audience_type,
      audienceFilter: audience_filter ?? {},
    });
    return res.status(201).json({ campaign });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// ── GET /portal/api/email-campaigns/:id ───────────────────────────────────────
export async function handlePortalGetEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;

  const campaign = await getEmailCampaign(supabase, id);
  if (!campaign) return res.status(404).json({ error: "Email campaign not found" });
  if (clientId && campaign.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  return res.json({ campaign });
}

// ── PATCH /portal/api/email-campaigns/:id ─────────────────────────────────────
// Only drafts can be edited.
export async function handlePortalUpdateEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;

  const existing = await getEmailCampaign(supabase, id);
  if (!existing) return res.status(404).json({ error: "Email campaign not found" });
  if (clientId && existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });
  if (existing.status !== "draft") {
    return res.status(409).json({ error: `Cannot edit campaign in status "${existing.status}" — only drafts can be updated` });
  }

  try {
    const campaign = await updateEmailCampaign(supabase, id, req.body ?? {});
    return res.json({ campaign });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── DELETE /portal/api/email-campaigns/:id ────────────────────────────────────
export async function handlePortalDeleteEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;

  const existing = await getEmailCampaign(supabase, id);
  if (!existing) return res.status(404).json({ error: "Email campaign not found" });
  if (clientId && existing.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  try {
    await deleteEmailCampaign(supabase, id);
    console.log(`[PORTAL] email campaign deleted: ${id} (by ${req.portalUser?.email ?? "?"})`);
    return res.json({ deleted: 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST /portal/api/email-campaigns/:id/preview ──────────────────────────────
// Renders subject/html/text for one sample recipient — no send.
export async function handlePortalPreviewEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;

  const campaign = await getEmailCampaign(supabase, id);
  if (!campaign) return res.status(404).json({ error: "Email campaign not found" });
  if (clientId && campaign.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const client = getAllClients()[campaign.client_id] ?? null;
  const rendered = previewEmailCampaign(campaign, client, {
    first_name: req.body?.first_name ?? "Alex",
    last_name:  req.body?.last_name ?? "Guest",
  });
  return res.json(rendered);
}

// ── POST /portal/api/email-campaigns/:id/send-test ────────────────────────────
// Body: { test_email? } — defaults to the requesting portal user's own email.
export async function handlePortalSendTestEmailCampaign(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  const { id } = req.params;

  const campaign = await getEmailCampaign(supabase, id);
  if (!campaign) return res.status(404).json({ error: "Email campaign not found" });
  if (clientId && campaign.client_id !== clientId) return res.status(403).json({ error: "Access denied" });

  const testEmail = req.body?.test_email || req.portalUser?.email;
  if (!testEmail || !isValidEmail(testEmail)) {
    return res.status(400).json({ error: "A valid test_email is required" });
  }

  const client = getAllClients()[campaign.client_id] ?? null;
  try {
    const domainRow = await getClientDomain(supabase, campaign.client_id);
    const result = await sendTestEmail(campaign, client, testEmail, domainRow);
    if (!result.sent) {
      return res.status(502).json({ sent: false, reason: result.reason ?? "unknown" });
    }
    return res.json({ sent: true, to: testEmail });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── GET /portal/api/email-domain ───────────────────────────────────────────────
export async function handlePortalGetEmailDomain(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const domain = await getClientDomain(supabase, clientId);
  return res.json({ domain, resend_configured: isResendConfigured() });
}

// ── POST /portal/api/email-domain ──────────────────────────────────────────────
// Body: { domain, from_local_part? } — registers a new sending domain with
// Resend and returns the DNS records to add at the client's DNS provider.
export async function handlePortalCreateEmailDomain(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const domain = String(req.body?.domain ?? "").trim().toLowerCase();
  if (!domain || !DOMAIN_REGEX.test(domain)) {
    return res.status(400).json({ error: "A valid domain (e.g. yourbusiness.com) is required" });
  }
  const fromLocalPart = String(req.body?.from_local_part ?? "hello").trim().toLowerCase() || "hello";

  try {
    const row = await createClientDomain(supabase, clientId, domain, fromLocalPart);
    console.log(`[PORTAL] email domain registered: ${domain} for ${clientId} (by ${req.portalUser?.email ?? "?"})`);
    return res.status(201).json({ domain: row });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// ── POST /portal/api/email-domain/verify ───────────────────────────────────────
// Re-checks verification status against Resend (triggers an active re-check).
export async function handlePortalVerifyEmailDomain(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  const row = await refreshClientDomain(supabase, clientId, { forceVerify: true });
  if (!row) return res.status(404).json({ error: "No sending domain configured yet" });
  return res.json({ domain: row });
}

// ── DELETE /portal/api/email-domain ────────────────────────────────────────────
// Removes the stored row so the client can register a different domain.
// Does not delete the domain from Resend itself (harmless to leave registered).
export async function handlePortalDeleteEmailDomain(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!requireClientAdmin(req, res)) return;
  const clientId = resolvePortalClientId(req);
  if (!clientId) return res.status(400).json({ error: "client_id is required" });

  await deleteClientDomain(supabase, clientId);
  return res.json({ deleted: 1 });
}

// ── GET /email/unsubscribe/:token ─────────────────────────────────────────────
// Public route (no portal auth) — the one-click unsubscribe link embedded in
// every marketing email footer (CAN-SPAM requirement). Always returns a
// friendly confirmation page, even for an unknown/already-used token, so a
// stale link never shows a broken/technical error to a customer.
export async function handleEmailUnsubscribe(req, res, crmSupabase) {
  const { token } = req.params;
  const page = (message) => res.status(200).type("html").send(
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;` +
    `max-width:480px;margin:80px auto;text-align:center;color:#111827;padding:0 20px;">` +
    `<h2>Unsubscribed</h2><p>${message}</p></body></html>`
  );

  if (!crmSupabase || !token) return page("You've been unsubscribed from marketing emails.");

  try {
    await crmSupabase
      .from("contacts")
      .update({ email_marketing_consent: false, email_unsubscribed_at: new Date().toISOString() })
      .eq("email_unsubscribe_token", token);
  } catch (err) {
    console.error("[EMAIL UNSUBSCRIBE] error:", err.message);
  }
  return page("You've been unsubscribed from marketing emails. You won't receive any more newsletters or promotions from us.");
}
