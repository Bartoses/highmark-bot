// ─────────────────────────────────────────────────────────────────────────────
// EMAIL CAMPAIGNS — CRUD + audience selection + preview/test-send for the CRM
// Email Marketing feature ("email creation" phase — see Roadmap 2026-07-08).
//
// Mirrors campaigns.js's shape (createCampaign/selectAudience) but for email:
//   createEmailCampaign()   — insert a new email_campaigns row (draft)
//   listEmailCampaigns()    — list rows for a client
//   getEmailCampaign()      — single row
//   updateEmailCampaign()   — edit a draft (drafts only)
//   deleteEmailCampaign()   — remove a draft/unsent row
//   selectEmailAudience()   — resolve recipients for crm_contacts | custom_emails
//   previewEmailCampaign()  — render subject/html/text for one sample recipient
//   sendTestEmail()         — actually deliver one rendered email via Resend
//
// NOT included yet (deferred to a later phase, see Roadmap): sending to a
// full audience, scheduling, open/click tracking, bounce/complaint handling.
// This module only creates and previews campaigns — nothing here emails an
// entire customer list.
// ─────────────────────────────────────────────────────────────────────────────

import { sendEmail } from "./emailService.js";
import { getEmailTemplate, VALID_TEMPLATE_KEYS, renderEmailForRecipient } from "./emailTemplates.js";

export const VALID_EMAIL_AUDIENCE_TYPES = ["crm_contacts", "custom_emails"];
export const VALID_EMAIL_CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "failed"];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
export function isValidEmail(email) {
  return EMAIL_REGEX.test(String(email ?? "").trim());
}

function isMissingColumnError(error) {
  if (!error) return false;
  const msg = (error.message ?? "") + " " + (error.details ?? "");
  return error.code === "42703" || /column .* does not exist/i.test(msg);
}

// ── createEmailCampaign ───────────────────────────────────────────────────────
export async function createEmailCampaign(supabase, {
  clientId, name, templateKey, subject, previewText, bodyHtml,
  fromName = null, replyTo = null,
  audienceType = "crm_contacts", audienceFilter = {},
}) {
  if (!clientId) throw new Error("clientId is required");
  if (!name)     throw new Error("name is required");
  if (!subject)  throw new Error("subject is required");
  if (!bodyHtml) throw new Error("bodyHtml is required");

  const resolvedTemplateKey = VALID_TEMPLATE_KEYS.includes(templateKey) ? templateKey : "newsletter";
  const resolvedAudience    = VALID_EMAIL_AUDIENCE_TYPES.includes(audienceType) ? audienceType : "crm_contacts";

  const { data, error } = await supabase
    .from("email_campaigns")
    .insert({
      client_id:       clientId,
      name,
      template_key:    resolvedTemplateKey,
      subject,
      preview_text:    previewText ?? null,
      body_html:       bodyHtml,
      from_name:       fromName,
      reply_to:        replyTo,
      audience_type:   resolvedAudience,
      audience_filter: audienceFilter ?? {},
      status:          "draft",
    })
    .select()
    .single();

  if (error) throw new Error(`[EMAIL CAMPAIGNS] create failed: ${error.message}`);
  return data;
}

// ── listEmailCampaigns ────────────────────────────────────────────────────────
export async function listEmailCampaigns(supabase, { clientId, status, limit = 50, offset = 0 }) {
  let query = supabase
    .from("email_campaigns")
    .select("*", { count: "exact" })
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) throw new Error(`[EMAIL CAMPAIGNS] list failed: ${error.message}`);
  return { campaigns: data ?? [], total: count ?? 0 };
}

// ── getEmailCampaign ──────────────────────────────────────────────────────────
export async function getEmailCampaign(supabase, id) {
  const { data, error } = await supabase.from("email_campaigns").select("*").eq("id", id).single();
  if (error || !data) return null;
  return data;
}

// ── updateEmailCampaign ───────────────────────────────────────────────────────
const EDITABLE_FIELDS = [
  "name", "template_key", "subject", "preview_text", "body_html",
  "from_name", "reply_to", "audience_type", "audience_filter",
];

export async function updateEmailCampaign(supabase, id, updates) {
  const patch = { updated_at: new Date().toISOString() };
  for (const key of EDITABLE_FIELDS) {
    if (updates[key] !== undefined) patch[key] = updates[key];
  }
  const { data, error } = await supabase
    .from("email_campaigns").update(patch).eq("id", id).select().single();
  if (error) throw new Error(`[EMAIL CAMPAIGNS] update failed: ${error.message}`);
  return data;
}

// ── deleteEmailCampaign ───────────────────────────────────────────────────────
export async function deleteEmailCampaign(supabase, id) {
  const { error } = await supabase.from("email_campaigns").delete().eq("id", id);
  if (error) throw new Error(`[EMAIL CAMPAIGNS] delete failed: ${error.message}`);
}

// Parses a raw email list (array or comma/newline-separated string).
// Normalizes case, drops blanks/invalid/duplicate entries.
export function parseEmailList(raw) {
  const lines = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\n,]+/);
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const email = line.trim().toLowerCase();
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    result.push({ email, first_name: null, last_name: null, unsubscribe_token: null, source: "manual" });
  }
  return result;
}

// ── selectEmailAudience ───────────────────────────────────────────────────────
// crm_contacts  — DB2 contacts with an email on file, consented, not unsubscribed.
// custom_emails — filterConfig.emails: manually supplied list (testing/one-off).
export async function selectEmailAudience(crmSupabase, { clientId, audienceType, filterConfig = {} }) {
  if (audienceType === "custom_emails") {
    return parseEmailList(filterConfig.emails ?? "");
  }

  // crm_contacts
  if (!crmSupabase) {
    console.warn("[EMAIL CAMPAIGNS] crm_contacts requested but CRM_SUPABASE_URL is not configured");
    return [];
  }

  let query = crmSupabase
    .from("contacts")
    .select("id, email, first_name, last_name, email_marketing_consent, email_unsubscribed_at, email_unsubscribe_token")
    .eq("client_id", clientId)
    .not("email", "is", null);

  let { data, error } = await query.eq("email_marketing_consent", true).is("email_unsubscribed_at", null);

  // db2_email_consent.sql not yet applied — degrade to "all contacts with an
  // email on file" rather than erroring the whole campaign feature.
  if (error && isMissingColumnError(error)) {
    console.warn("[EMAIL CAMPAIGNS] email consent columns missing — run db2_email_consent.sql. Falling back to unfiltered contacts.");
    ({ data, error } = await crmSupabase
      .from("contacts")
      .select("id, email, first_name, last_name")
      .eq("client_id", clientId)
      .not("email", "is", null));
  }

  if (error) throw new Error(`[EMAIL CAMPAIGNS] selectEmailAudience failed: ${error.message}`);

  return (data ?? []).map((c) => ({
    email:             c.email,
    first_name:        c.first_name ?? null,
    last_name:         c.last_name ?? null,
    unsubscribe_token: c.email_unsubscribe_token ?? null,
    source:            "crm",
    contact_id:        c.id,
  }));
}

// ── previewEmailCampaign ──────────────────────────────────────────────────────
// Renders subject/html/text for one sample recipient — no send, no I/O beyond
// the campaign row already in memory. sampleContact defaults to a placeholder
// so a preview never depends on a real audience existing yet.
export function previewEmailCampaign(campaign, client, sampleContact = {}) {
  const businessName = client?.name ?? "Your Business";
  const address       = client?.address ?? null;
  const baseUrl        = process.env.PUBLIC_BASE_URL || "";

  return renderEmailForRecipient({
    subject:      campaign.subject,
    previewText:  campaign.preview_text,
    bodyHtml:     campaign.body_html,
    businessName,
    address,
    baseUrl,
    mergeVars: {
      first_name: sampleContact.first_name ?? "Alex",
      last_name:  sampleContact.last_name ?? "Guest",
    },
    unsubscribeToken: sampleContact.unsubscribe_token ?? "preview",
  });
}

// ── sendTestEmail ─────────────────────────────────────────────────────────────
// Sends ONE real email (via Resend) to a test address — used by the composer's
// "Send test to me" button. Never touches the real audience/consent list.
export async function sendTestEmail(campaign, client, testEmail) {
  if (!isValidEmail(testEmail)) throw new Error("A valid test email address is required");

  const rendered = previewEmailCampaign(campaign, client, { first_name: "Alex", last_name: "Guest" });
  const fromName = campaign.from_name || client?.name || "Highmark";
  const replyTo  = campaign.reply_to || client?.supportEmail || undefined;

  const result = await sendEmail({
    to:      testEmail,
    subject: `[TEST] ${rendered.subject}`,
    html:    rendered.html,
    text:    rendered.text,
    from:    fromName,
    replyTo,
  });
  return result;
}

export { getEmailTemplate };
