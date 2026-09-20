// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES — curated starting points + merge-field rendering for the
// CRM Email Marketing feature (newsletters/promos sent via Resend).
//
// Deliberately NOT a drag-and-drop builder (2026-07-08 decision) — a client
// picks one of these, edits the subject/body text, and the merge fields below
// get substituted per-recipient. All helpers here are pure (no I/O) so they're
// safe to unit test directly.
//
// CAN-SPAM note: every rendered email gets buildEmailFooter() appended
// regardless of template — a physical mailing address + a working one-click
// unsubscribe link are legally required on every marketing email, independent
// of whether the recipient's consent is already on file.
// ─────────────────────────────────────────────────────────────────────────────

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Merge fields available in the composer UI + substituted at render time.
export const MERGE_FIELDS = [
  { token: "first_name",    label: "First name",     sample: "Alex" },
  { token: "last_name",     label: "Last name",       sample: "Guest" },
  { token: "business_name", label: "Business name",   sample: "Colorado Sled Rentals" },
];

// Substitutes {{token}} placeholders. Unknown tokens are left as empty string
// rather than throwing, so a typo'd merge field degrades to blank, not a crash.
export function renderMergeFields(text, vars = {}) {
  return String(text ?? "").replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_match, token) => {
    const val = vars[token];
    return val === undefined || val === null ? "" : String(val);
  });
}

// Things in a template that will NOT do what the author expects. Mailchimp placeholders (*|UNSUB|*, *|FNAME|*, …) are only
// replaced by Mailchimp — anywhere else they go out as literal text (and a dead "unsubscribe" link). Unknown {{fields}} render blank.
export const KNOWN_FIELDS = ["first_name", "last_name", "business_name"];
export const BOOKING_FIELDS = [...KNOWN_FIELDS, "activity", "trip_date", "trip_time", "booking_pk"];
export function findTemplateProblems(text, known = KNOWN_FIELDS) {
  const src = String(text ?? "");
  const mailchimp = [...new Set(src.match(/\*\|[A-Za-z0-9_:\-]{1,40}\|\*/g) ?? [])];
  const unknownFields = [...new Set([...src.matchAll(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g)].map(m => m[1]).filter(t => !known.includes(t)))];
  const warnings = [];
  if (mailchimp.length) warnings.push(`This email still contains Mailchimp placeholder(s) ${mailchimp.join(", ")} — they are NOT replaced here and would be sent as literal text (a dead link, for *|UNSUB|*). Delete them; the unsubscribe link + address are added automatically. For a first name use {{first_name}}.`);
  if (unknownFields.length) warnings.push(`Unknown merge field(s) ${unknownFields.map(t => `{{${t}}}`).join(", ")} will be blank. Available: ${known.map(t => `{{${t}}}`).join(", ")}.`);
  return { mailchimp, unknownFields, warnings };
}

export const VALID_TEMPLATE_KEYS = ["newsletter", "promo", "season_announcement", "thank_you"];

// Curated templates — label/description drive the picker UI; defaultSubject/
// defaultPreviewText/defaultBodyHtml pre-fill the composer (fully editable).
export const EMAIL_TEMPLATES = {
  newsletter: {
    key:                "newsletter",
    label:              "Newsletter",
    description:        "General updates — what's new, upcoming events, behind-the-scenes.",
    defaultSubject:     "What's new at {{business_name}}",
    defaultPreviewText: "The latest from our team",
    defaultBodyHtml:
      `<h1>Hi {{first_name}},</h1>` +
      `<p>Here's what's been happening at {{business_name}} lately.</p>` +
      `<p>[Tell your customers what's new — write a couple of short paragraphs here.]</p>` +
      `<p>Thanks for being part of our community!</p>`,
  },
  promo: {
    key:                "promo",
    label:              "Promotion / Discount",
    description:        "A limited-time offer or discount code.",
    defaultSubject:     "A little something for you, {{first_name}}",
    defaultPreviewText: "Limited-time offer inside",
    defaultBodyHtml:
      `<h1>Hey {{first_name}} — here's a deal for you</h1>` +
      `<p>[Describe the offer — e.g. 15% off your next booking with code SAVE15.]</p>` +
      `<p>[Add an expiration date or urgency if applicable.]</p>` +
      `<p>We'd love to have you back at {{business_name}}.</p>`,
  },
  season_announcement: {
    key:                "season_announcement",
    label:              "Season Announcement",
    description:        "Opening/closing dates, new season activities.",
    defaultSubject:     "{{business_name}} — the season is here",
    defaultPreviewText: "Here's what's coming this season",
    defaultBodyHtml:
      `<h1>{{first_name}}, the season is almost here</h1>` +
      `<p>[Announce opening/closing dates, new activities, or seasonal hours.]</p>` +
      `<p>We can't wait to see you out there.</p>`,
  },
  thank_you: {
    key:                "thank_you",
    label:              "Thank You",
    description:        "Post-trip thank-you / review request.",
    defaultSubject:     "Thanks for visiting {{business_name}}!",
    defaultPreviewText: "We'd love your feedback",
    defaultBodyHtml:
      `<h1>Thanks for coming out, {{first_name}}!</h1>` +
      `<p>We hope you had a great time with {{business_name}}.</p>` +
      `<p>[Optionally ask for a review, or point to your next season's offerings.]</p>`,
  },
};

export function getEmailTemplate(templateKey) {
  return EMAIL_TEMPLATES[templateKey] ?? EMAIL_TEMPLATES.newsletter;
}

// Builds the CAN-SPAM required footer — physical address + one-click
// unsubscribe. unsubscribeUrl should always be a real, working link (even in
// previews/test sends, which use a non-functional placeholder token).
export function buildEmailFooter({ businessName, address, unsubscribeUrl }) {
  const addrLine = address ? escapeHtml(address) : "";
  return (
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;` +
    `font-size:12px;line-height:1.6;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 6px;">${escapeHtml(businessName ?? "")}${addrLine ? ` · ${addrLine}` : ""}</p>` +
    `<p style="margin:0;">You're receiving this because you're a customer of ${escapeHtml(businessName ?? "this business")}. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></p>` +
    `</div>`
  );
}

export function buildEmailFooterText({ businessName, address, unsubscribeUrl }) {
  const parts = [businessName, address].filter(Boolean).join(" · ");
  return `${parts}\n\nUnsubscribe: ${unsubscribeUrl}`;
}

// Wraps composed body HTML in a minimal, email-client-safe responsive shell.
// Inline styles throughout — email clients strip <style> blocks unreliably.
export function wrapEmailShell({ previewText, bodyHtml, footerHtml }) {
  // Hidden preheader — the snippet shown next to the subject in inbox lists.
  const preheader = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(previewText)}</div>`
    : "";
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" ` +
    `style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;padding:32px;` +
    `font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:15px;line-height:1.6;">` +
    `<tr><td>${bodyHtml}${footerHtml}</td></tr>` +
    `</table>` +
    `</td></tr>` +
    `</table>` +
    `</body></html>`
  );
}

// Naive HTML→text fallback for the plain-text alternative part.
export function htmlToPlainText(html) {
  return String(html ?? "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")     // hidden preheader
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&middot;/g, "\u00b7").replace(/&#10003;/g, "\u2713")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A pasted design that is already a COMPLETE email document (own <!doctype>/<html>/<head><style>…) must be sent as-is:
// wrapping it in another document nests <html> inside <html> and moves its <style> (its mobile layout) into the body,
// where Gmail discards it. So for those we only inject the required footer just before </body>.
export function isFullHtmlDocument(html) { return /^\s*(<!doctype\s+html|<html[\s>])/i.test(String(html ?? "")); }
export function injectBeforeBodyEnd(html, block) {
  const src = String(html ?? "");
  const i = src.search(/<\/body\s*>/i);
  return i === -1 ? src + block : src.slice(0, i) + block + src.slice(i);
}
const standaloneFooter = (footerHtml) =>
  `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:0 8px 28px;">` +
  `<table role="presentation" width="580" border="0" cellspacing="0" cellpadding="0" style="width:580px;max-width:100%;"><tr><td style="padding:0 28px;">${footerHtml}</td></tr></table>` +
  `</td></tr></table>`;

export function buildUnsubscribeUrl(baseUrl, token) {
  const base = (baseUrl || "").replace(/\/$/, "");
  return `${base}/email/unsubscribe/${token}`;
}

// Full per-recipient render: merges fields into subject/body, appends the
// CAN-SPAM footer with this recipient's real unsubscribe link, wraps in the
// HTML shell, and derives a plain-text alternative.
// `unsubscribeToken` — pass "preview" for previews/test sends (non-functional
// placeholder; there's no real contact row to unsubscribe).
export function renderEmailForRecipient({
  subject, previewText, bodyHtml, businessName, address, baseUrl,
  mergeVars = {}, unsubscribeToken = "preview",
}) {
  const vars = { business_name: businessName, ...mergeVars };
  const renderedSubject = renderMergeFields(subject, vars);
  const renderedBody    = renderMergeFields(bodyHtml, vars);
  const unsubscribeUrl  = buildUnsubscribeUrl(baseUrl, unsubscribeToken);
  const footerHtml      = buildEmailFooter({ businessName, address, unsubscribeUrl });
  const html            = isFullHtmlDocument(renderedBody)
    ? injectBeforeBodyEnd(renderedBody, standaloneFooter(footerHtml))
    : wrapEmailShell({ previewText, bodyHtml: renderedBody, footerHtml });
  const text            = `${htmlToPlainText(renderedBody)}\n\n${buildEmailFooterText({ businessName, address, unsubscribeUrl })}`;
  return { subject: renderedSubject, html, text };
}
