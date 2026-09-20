// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND API  (/api/v1) — for Google Apps Script, automations, anything with the key
//
// One authenticated door for "email or text these customers". Consent, unsubscribes,
// bounces and STOP are enforced HERE, server-side — a caller cannot bypass them.
//
//   GET  /api/v1/health
//   POST /api/v1/email/audience        { segment }                         → who would get it
//   POST /api/v1/email/send            { subject, html, segment, idempotency_key, dry_run:false }
//   GET  /api/v1/email/campaigns/:id                                       → delivery counts
//   POST /api/v1/email/transactional   { booking_pk, subject, html, idempotency_key, dry_run:false }
//   ── Gmail transport (send AS info@yourdomain with no DNS access; see emailSender.js) ──
//   POST /api/v1/email/send|transactional  + { transport: "gmail" }   queue only; delivery is done by Apps Script
//   POST /api/v1/email/preview         { subject, html }              → the fully rendered message (for a test to yourself)
//   POST /api/v1/email/pull            { campaign_id?, limit }        → claim rendered messages to send with GmailApp
//   POST /api/v1/email/report          { results:[{send_id, ok, error?}] }
//   POST /api/v1/email/bounces         { emails:[...] }               → addresses that bounced → suppressed
//   POST /api/v1/sms/audience          { segment }
//   POST /api/v1/sms/send              { body, segment, idempotency_key, dry_run:false }
//   POST /api/v1/sms/transactional     { booking_pk, body, idempotency_key, dry_run:false }
//
// Safety rails
//   • Bearer key (env OUTBOUND_API_KEY, constant-time compare); 503 if unset — never open.
//   • EVERY send defaults to dry_run — a real send needs an explicit `dry_run: false`.
//   • Real sends need an idempotency_key: a retry (Apps Script re-runs!) returns the original
//     result instead of sending twice.
//   • Marketing email needs a physical mailing address (CAN-SPAM) — refused (422) without one.
//   • Marketing goes only to EXPLICIT consent unless the segment opts into grandfathered /
//     assumed audiences; unknown segment fields are rejected.
//   • Transactional = booking-related mail to the booking's OWN guest (looked up from the
//     booking — the caller cannot supply an arbitrary address). It ignores a marketing
//     unsubscribe but never a bounce/complaint suppression or a STOP.
//   • Hard cap on recipients per send (OUTBOUND_MAX_RECIPIENTS, default 5000) and an optional
//     `expected_recipients` tripwire (409 if the audience is far bigger than you expected).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import express from "express";
import { normalizeSegment, SegmentError, selectEmailRecipients, selectSmsRecipients, loadSmsOptOuts, maskEmail, maskPhone } from "./outboundAudience.js";
import { enqueueCampaignSends, enqueueTransactional, drainEmailQueue, resolveMailingAddress, resolveReplyTo, resolveFrom, resolveBaseUrl, renderCampaignEmail, pullGmailMessages, reportGmailResults, reportGmailBounces } from "./emailSender.js";
import { createEmailCampaign } from "./emailCampaigns.js";
import { isEmailConfigured, sendEmail } from "./emailService.js";
import { renderMergeFields, findTemplateProblems, BOOKING_FIELDS } from "./emailTemplates.js";
import { normEmail, isEmailAddress, loadSuppressionSets } from "./emailSuppression.js";
import { scheduleMessage } from "./scheduler.js";
import { normalizePhone } from "./phoneUtils.js";

const MAX_HTML = 500_000;
const DEFAULT_MAX_RECIPIENTS = 5000;

// ── auth ─────────────────────────────────────────────────────────────────────
export function keysMatch(provided, expected) {
  if (!provided || !expected) return false;
  const h = (v) => crypto.createHash("sha256").update(String(v)).digest();   // fixed length → timingSafeEqual is safe
  return crypto.timingSafeEqual(h(provided), h(expected));
}
export function requireApiKey(req, res, next) {
  const expected = process.env.OUTBOUND_API_KEY;
  if (!expected) return res.status(503).json({ error: "Outbound API is not configured (set OUTBOUND_API_KEY)" });
  const auth = req.get("authorization") || "";
  const provided = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.get("x-api-key");
  if (!keysMatch(provided, expected)) return res.status(401).json({ error: "invalid API key" });
  next();
}

// ── small helpers ────────────────────────────────────────────────────────────
const bad = (res, msg, status = 400, extra = {}) => res.status(status).json({ error: msg, ...extra });
const maxRecipients = () => Number(process.env.OUTBOUND_MAX_RECIPIENTS) || DEFAULT_MAX_RECIPIENTS;
export const isDryRun = (body) => body?.dry_run !== false;          // must be the literal boolean false to send
// "expected_recipients" tripwire: refuse when the audience is more than 10% (or +3) larger than the caller expected.
export const overExpected = (actual, expected) => expected != null && Number.isFinite(Number(expected)) && actual > Math.max(Number(expected) * 1.1, Number(expected) + 3);
const validKey = (k) => typeof k === "string" && k.length >= 8 && k.length <= 100;

// Trip facts for merge fields, in the business's timezone (Mountain).
function tripMergeVars(booking, customerName, activityName) {
  const tz = "America/Denver";
  const d = booking.start_at ? new Date(booking.start_at) : null;
  return {
    first_name: (customerName ?? "").trim().split(/\s+/)[0] || "there",
    activity: activityName ?? "your trip",
    trip_date: d ? d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "",
    trip_time: d ? d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "",
    booking_pk: booking.fareharbor_pk,
  };
}

async function loadBooking(crm, bookingPk) {
  const { data: booking } = await crm.from("bookings")
    .select("fareharbor_pk, status, start_at, customer_id, activity_id, company, raw_payload").eq("fareharbor_pk", bookingPk).maybeSingle();
  if (!booking) return null;
  const cust = booking.customer_id ? (await crm.from("customers").select("name, email, normalized_phone").eq("id", booking.customer_id).maybeSingle()).data : null;
  const act  = booking.activity_id ? (await crm.from("activities").select("display_name").eq("id", booking.activity_id).maybeSingle()).data : null;
  const payload = booking.raw_payload?.booking ?? booking.raw_payload ?? {};
  return {
    booking,
    email: normEmail(cust?.email || payload?.contact?.email || ""),
    phone: cust?.normalized_phone || normalizePhone(payload?.contact?.normalized_phone) || normalizePhone(payload?.contact?.phone) || null,
    name: cust?.name || payload?.contact?.name || "",
    activity: act?.display_name || payload?.availability?.item?.name || null,
  };
}

// TCPA: marketing texts only between 8am and 9pm in the RECIPIENT's local time. Every guest here is in
// the Mountain time zone, so that's the window enforced (the safe choice for a Colorado business).
export function isQuietHours(date = new Date(), tz = "America/Denver") {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(date)) % 24;
  return h < 8 || h >= 21;
}

// ── router factory (deps injected → testable with mocks) ─────────────────────
export function buildOutboundRouter({ crm, db1, getClient, sendOne = sendEmail, drain = drainEmailQueue, kick = true, processDeps = () => ({}), now = () => new Date() }) {
  const router = express.Router();
  router.use(requireApiKey);

  const clientId = () => process.env.CLIENT_ID || "csr_rea";
  const client = async () => (await getClient?.(clientId())) ?? { name: "Your Business" };
  const transportOf = (b) => (b?.transport === "gmail" ? "gmail" : "resend");
  const queueDeps = async () => { const c = await client();
    return { getCampaign: async (d, id) => (d ? (await d.from("email_campaigns").select("*").eq("id", id).maybeSingle()).data : null), ...processDeps(), resolveClient: () => c }; };
  const afterResponse = (fn) => { if (kick) setImmediate(() => fn().catch(e => console.error("[OUTBOUND] background send error:", e.message))); };

  router.get("/health", async (_req, res) => {
    const c = await client();
    res.json({
      ok: true, client_id: clientId(), business: c.name ?? null,
      email_configured: isEmailConfigured(), webhook_secret_configured: !!process.env.RESEND_WEBHOOK_SECRET,
      mailing_address_configured: !!resolveMailingAddress(c), gmail_transport: true, email_from: resolveFrom({ displayName: c.name }), reply_to: resolveReplyTo(null, c), sms_from_number: c.outboundPhone || process.env.TWILIO_PHONE_NUMBER || null,
    });
  });

  // ── email: audience preview ──
  router.post("/email/audience", async (req, res) => {
    try {
      const a = await selectEmailRecipients(crm, { clientId: clientId(), segment: req.body?.segment });
      res.json({ eligible: a.stats.eligible, excluded: a.stats.excluded, segment: a.segment,
        by_consent_source: a.recipients.reduce((m, r) => (m[r.consent_source ?? "unknown"] = (m[r.consent_source ?? "unknown"] ?? 0) + 1, m), {}),
        sample: a.recipients.slice(0, 5).map(r => ({ email: maskEmail(r.email), first_name: r.first_name })) });
    } catch (e) { return e instanceof SegmentError ? bad(res, e.message) : bad(res, "audience lookup failed", 500); }
  });

  // ── email: marketing send ──
  router.post("/email/send", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.subject !== "string" || !b.subject.trim() || b.subject.length > 200) return bad(res, "subject is required (max 200 chars)");
    if (typeof b.html !== "string" || !b.html.trim()) return bad(res, "html is required");
    if (b.html.length > MAX_HTML) return bad(res, `html too large (max ${MAX_HTML} chars)`);
    if (b.transport != null && !["resend", "gmail"].includes(b.transport)) return bad(res, 'transport must be "resend" or "gmail"');
    const transport = transportOf(b);
    const problems = findTemplateProblems(`${b.subject}\n${b.html}`);
    try {
      const c = await client();

      // one-off test to a single address (no audience touched)
      if (b.test_to != null) {
        if (!isEmailAddress(b.test_to)) return bad(res, "test_to must be a valid email");
        if (!isEmailConfigured()) return bad(res, "email is not configured", 503);
        const r = await sendOne({ to: normEmail(b.test_to), subject: `[TEST] ${renderMergeFields(b.subject, { first_name: "Alex", business_name: c.name })}`,
          html: renderMergeFields(b.html, { first_name: "Alex", last_name: "Guest", business_name: c.name }), from: b.from_name || c.name, replyTo: resolveReplyTo(b.reply_to, c) ?? undefined });
        return res.status(r.sent ? 200 : 502).json({ test: true, sent: r.sent, reason: r.reason ?? null, warnings: problems.warnings });
      }

      const a = await selectEmailRecipients(crm, { clientId: clientId(), segment: b.segment });
      const summary = { eligible: a.stats.eligible, excluded: a.stats.excluded, segment: a.segment, warnings: problems.warnings,
        sample: a.recipients.slice(0, 5).map(r => ({ email: maskEmail(r.email), first_name: r.first_name })) };
      if (isDryRun(b)) return res.json({ dry_run: true, ...summary, note: 'Nothing sent. Pass "dry_run": false to send.' });

      // ── real send: guards ──
      if (problems.mailchimp.length) return bad(res, problems.warnings[0], 422, summary);
      if (!validKey(b.idempotency_key)) return bad(res, "idempotency_key (8-100 chars) is required for a real send");
      if (transport === "resend" && !isEmailConfigured()) return bad(res, "email is not configured (RESEND_API_KEY)", 503);
      if (!resolveMailingAddress(c)) return bad(res, "Marketing email requires a physical mailing address (CAN-SPAM). Set the client address or MAILING_ADDRESS.", 422);

      const { data: prior } = await db1.from("email_campaigns").select("id, status, total_sent, created_at").contains("metadata", { idempotency_key: b.idempotency_key }).limit(1);
      if (prior?.length) return res.json({ already_created: true, campaign_id: prior[0].id, status: prior[0].status });

      if (a.stats.eligible === 0) return bad(res, "No eligible recipients for this segment", 422, summary);
      if (a.stats.eligible > maxRecipients()) return bad(res, `Audience of ${a.stats.eligible} exceeds the ${maxRecipients()} per-send cap`, 422, summary);
      if (overExpected(a.stats.eligible, b.expected_recipients))
        return bad(res, `Audience is ${a.stats.eligible}, more than the ${b.expected_recipients} you expected — refusing. Check your segment.`, 409, summary);

      const campaign = await createEmailCampaign(db1, {
        clientId: clientId(), name: (b.name || b.subject).slice(0, 120), templateKey: "newsletter", subject: b.subject,
        previewText: b.preview_text ?? null, bodyHtml: b.html, fromName: b.from_name ?? null, replyTo: b.reply_to ?? null,
        audienceType: "crm_contacts", audienceFilter: a.segment,
      });
      await db1.from("email_campaigns").update({ status: "sending", metadata: { idempotency_key: b.idempotency_key, via: "api", transport }, updated_at: new Date().toISOString() }).eq("id", campaign.id);
      const queued = await enqueueCampaignSends(crm, { campaignId: campaign.id, clientId: clientId(), recipients: a.recipients, transport });
      if (transport === "resend") afterResponse(() => drain(crm, db1, processDeps()));    // gmail rows wait for Apps Script to pull them
      return res.status(202).json({ campaign_id: campaign.id, queued, status: "sending", transport, ...summary });
    } catch (e) {
      if (e instanceof SegmentError) return bad(res, e.message);
      console.error("[OUTBOUND] email/send error:", e.message);
      return bad(res, "send failed", 500);
    }
  });

  // ── Gmail transport endpoints ──
  router.post("/email/preview", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.subject !== "string" || !b.subject.trim() || typeof b.html !== "string" || !b.html.trim()) return bad(res, "subject and html are required");
    if (b.html.length > MAX_HTML) return bad(res, `html too large (max ${MAX_HTML} chars)`);
    const c = await client();
    const m = renderCampaignEmail({ campaign: { subject: b.subject, preview_text: b.preview_text ?? null, body_html: b.html, from_name: b.from_name ?? null, reply_to: b.reply_to ?? null },
      client: c, recipient: { email: "preview@example.com", first_name: "Alex", last_name: "Guest", unsubscribe_token: "preview" }, baseUrl: resolveBaseUrl() });
    res.json({ subject: `[TEST] ${m.subject}`, html: m.html, text: m.text, reply_to: m.reply_to ?? null, mailing_address_configured: !!resolveMailingAddress(c),
      warnings: findTemplateProblems(`${b.subject}\n${b.html}`).warnings });
  });

  router.post("/email/pull", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.body?.limit ?? 90, 10) || 0, 0), 500);
      const r = await pullGmailMessages(crm, db1, { campaignId: req.body?.campaign_id ?? null, limit, ...(await queueDeps()) });
      res.json({ messages: r.messages, claimed: r.claimed, skipped: r.skipped, remaining: r.remaining, blocked: r.blocked });
    } catch (e) { console.error("[OUTBOUND] email/pull error:", e.message); return bad(res, "pull failed", 500); }
  });

  router.post("/email/report", async (req, res) => {
    if (!Array.isArray(req.body?.results) || req.body.results.length > 500) return bad(res, "results must be an array (max 500)");
    try { res.json(await reportGmailResults(crm, db1, req.body.results, await queueDeps())); }
    catch (e) { console.error("[OUTBOUND] email/report error:", e.message); return bad(res, "report failed", 500); }
  });

  router.post("/email/bounces", async (req, res) => {
    if (!Array.isArray(req.body?.emails) || req.body.emails.length > 500 || req.body.emails.some(e => typeof e !== "string")) return bad(res, "emails must be an array of strings (max 500)");
    try { res.json(await reportGmailBounces(crm, req.body.emails)); }
    catch (e) { console.error("[OUTBOUND] email/bounces error:", e.message); return bad(res, "report failed", 500); }
  });

  router.get("/email/campaigns/:id", async (req, res) => {
    try {
      const { data: rows } = await crm.from("email_sends").select("status").eq("campaign_id", req.params.id);
      const counts = (rows ?? []).reduce((m, r) => (m[r.status] = (m[r.status] ?? 0) + 1, m), {});
      const { data: camp } = await db1.from("email_campaigns").select("id, name, subject, status, sent_at, created_at").eq("id", req.params.id).maybeSingle();
      if (!camp && !rows?.length) return bad(res, "campaign not found", 404);
      res.json({ campaign: camp ?? null, total: rows?.length ?? 0, counts });
    } catch { return bad(res, "lookup failed", 500); }
  });

  // ── email: booking-related (transactional) ──
  router.post("/email/transactional", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.booking_pk !== "string" || !b.booking_pk) return bad(res, "booking_pk is required");
    if (typeof b.subject !== "string" || !b.subject.trim() || b.subject.length > 200) return bad(res, "subject is required (max 200 chars)");
    if (typeof b.html !== "string" || !b.html.trim() || b.html.length > MAX_HTML) return bad(res, "html is required");
    if (b.transport != null && !["resend", "gmail"].includes(b.transport)) return bad(res, 'transport must be "resend" or "gmail"');
    const transport = transportOf(b);
    try {
      const found = await loadBooking(crm, b.booking_pk);
      if (!found) return bad(res, "booking not found", 404);
      if (!isEmailAddress(found.email)) return bad(res, "no valid email on file for this booking's guest", 422);
      const sup = await loadSuppressionSets(crm);
      if (sup.hard.has(found.email)) return bad(res, "this address bounced or filed a complaint and can no longer be emailed", 422);

      const vars = tripMergeVars(found.booking, found.name, found.activity);
      const txProblems = findTemplateProblems(`${b.subject}\n${b.html}`, BOOKING_FIELDS);
      const preview = { to: maskEmail(found.email), subject: renderMergeFields(b.subject, vars), warnings: txProblems.warnings };
      if (!isDryRun(b) && txProblems.mailchimp.length) return bad(res, txProblems.warnings[0], 422);
      if (isDryRun(b)) return res.json({ dry_run: true, ...preview, note: 'Nothing sent. Pass "dry_run": false to send.' });

      if (!validKey(b.idempotency_key)) return bad(res, "idempotency_key (8-100 chars) is required for a real send");
      if (transport === "resend" && !isEmailConfigured()) return bad(res, "email is not configured (RESEND_API_KEY)", 503);
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: recent } = await crm.from("email_sends").select("id").eq("reference", b.booking_pk).eq("category", "transactional").gte("queued_at", since);
      if ((recent?.length ?? 0) >= 5) return bad(res, "too many emails for this booking in 24h (limit 5)", 429);

      const { data: contact } = await crm.from("contacts").select("id").ilike("email", found.email.replace(/[\\_%]/g, m => "\\" + m)).limit(1);
      // Merge the booking's own fields (trip date, activity, …) NOW: the sender only knows the guest's first name later,
      // so leaving {{trip_date}} for send time would render it blank.
      const { row, duplicate } = await enqueueTransactional(crm, {
        clientId: clientId(), contactId: contact?.[0]?.id ?? null, email: found.email, subject: renderMergeFields(b.subject, vars), bodyHtml: renderMergeFields(b.html, vars),
        reference: b.booking_pk, idempotencyKey: b.idempotency_key, transport,
      });
      if (transport === "gmail") {
        // Delivery is done by the caller's Gmail: hand back the rendered message (claimed now) to send + report.
        const pulled = duplicate ? { messages: [] } : await pullGmailMessages(crm, db1, { sendIds: [row.id], limit: 1, ...(await queueDeps()) });
        return res.status(202).json({ send_id: row.id, duplicate, transport, messages: pulled.messages, ...preview });
      }
      if (!duplicate) afterResponse(() => drain(crm, db1, processDeps()));
      return res.status(202).json({ send_id: row.id, duplicate, ...preview });
    } catch (e) { console.error("[OUTBOUND] email/transactional error:", e.message); return bad(res, "send failed", 500); }
  });

  // ── sms ──
  const smsBody = (body) => {
    if (typeof body !== "string" || !body.trim()) return null;
    const t = body.trim();
    return /\bstop\b/i.test(t) ? t : `${t} Reply STOP to opt out.`;   // TCPA: every marketing text carries opt-out language
  };
  const fromNumber = async () => { const c = await client(); return c.outboundPhone || process.env.TWILIO_PHONE_NUMBER || null; };

  router.post("/sms/audience", async (req, res) => {
    try {
      const a = await selectSmsRecipients(crm, db1, { clientId: clientId(), segment: req.body?.segment });
      res.json({ eligible: a.stats.eligible, excluded: a.stats.excluded, segment: a.segment, from_number: await fromNumber(),
        sample: a.recipients.slice(0, 5).map(r => ({ phone: maskPhone(r.phone), first_name: r.first_name })) });
    } catch (e) {
      if (e instanceof SegmentError) return bad(res, e.message);
      return bad(res, /opt-out/i.test(e.message) ? "opt-out list unreadable — refusing (fail closed)" : "audience lookup failed", /opt-out/i.test(e.message) ? 503 : 500);
    }
  });

  router.post("/sms/send", async (req, res) => {
    const b = req.body ?? {};
    const text = smsBody(b.body);
    if (!text) return bad(res, "body is required");
    if (text.length > 320) return bad(res, "message too long (max 320 chars including the opt-out line)");
    try {
      const a = await selectSmsRecipients(crm, db1, { clientId: clientId(), segment: b.segment });
      const from = await fromNumber();
      const summary = { eligible: a.stats.eligible, excluded: a.stats.excluded, segment: a.segment, from_number: from, message: text,
        sample: a.recipients.slice(0, 5).map(r => ({ phone: maskPhone(r.phone), first_name: r.first_name })) };
      if (isDryRun(b)) return res.json({ dry_run: true, ...summary, note: 'Nothing sent. Pass "dry_run": false to send.' });

      if (!validKey(b.idempotency_key)) return bad(res, "idempotency_key (8-100 chars) is required for a real send");
      if (!from) return bad(res, "no SMS from-number configured", 503);
      if (isQuietHours(now())) return bad(res, "Marketing texts may only be sent between 8am and 9pm Mountain time (TCPA quiet hours). Try again later.", 409);
      if (process.env.TEST_MODE === "true") return res.json({ blocked: "test_mode", would_queue: a.stats.eligible });   // same guard as campaigns/follow-ups
      const { data: prior } = await db1.from("scheduled_messages").select("id").contains("metadata", { idempotency_key: b.idempotency_key }).limit(1);
      if (prior?.length) return res.json({ already_created: true });
      if (a.stats.eligible === 0) return bad(res, "No eligible recipients for this segment", 422, summary);
      if (a.stats.eligible > maxRecipients()) return bad(res, `Audience exceeds the ${maxRecipients()} per-send cap`, 422, summary);
      if (overExpected(a.stats.eligible, b.expected_recipients))
        return bad(res, `Audience is ${a.stats.eligible}, more than the ${b.expected_recipients} you expected — refusing.`, 409, summary);

      const sendAt = new Date().toISOString();
      for (const r of a.recipients) {
        await scheduleMessage(db1, { phone: r.phone, body: renderMergeFields(text, { first_name: r.first_name ?? "there" }), message_type: "api_broadcast",
          send_at: sendAt, client_id: clientId(), metadata: { from_phone: from, idempotency_key: b.idempotency_key, contact_id: r.contact_id, via: "api" } });
      }
      return res.status(202).json({ queued: a.recipients.length, ...summary });
    } catch (e) {
      if (e instanceof SegmentError) return bad(res, e.message);
      console.error("[OUTBOUND] sms/send error:", e.message);
      return bad(res, /opt-out/i.test(e.message) ? "opt-out list unreadable — refusing (fail closed)" : "send failed", /opt-out/i.test(e.message) ? 503 : 500);
    }
  });

  router.post("/sms/transactional", async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.booking_pk !== "string" || !b.booking_pk) return bad(res, "booking_pk is required");
    if (typeof b.body !== "string" || !b.body.trim() || b.body.length > 320) return bad(res, "body is required (max 320 chars)");
    try {
      const found = await loadBooking(crm, b.booking_pk);
      if (!found) return bad(res, "booking not found", 404);
      if (!found.phone) return bad(res, "no phone on file for this booking's guest", 422);
      const optOuts = await loadSmsOptOuts(crm, db1);
      if (optOuts.has(found.phone)) return bad(res, "this number has opted out (STOP) and cannot be texted", 422);   // STOP silences everything
      const from = await fromNumber();
      const text = renderMergeFields(b.body.trim(), tripMergeVars(found.booking, found.name, found.activity));
      const preview = { to: maskPhone(found.phone), from_number: from, message: text };
      if (isDryRun(b)) return res.json({ dry_run: true, ...preview, note: 'Nothing sent. Pass "dry_run": false to send.' });

      if (!validKey(b.idempotency_key)) return bad(res, "idempotency_key (8-100 chars) is required for a real send");
      if (!from) return bad(res, "no SMS from-number configured", 503);
      if (process.env.TEST_MODE === "true") return res.json({ blocked: "test_mode" });
      const { data: prior } = await db1.from("scheduled_messages").select("id").contains("metadata", { idempotency_key: b.idempotency_key }).limit(1);
      if (prior?.length) return res.json({ already_created: true });
      await scheduleMessage(db1, { phone: found.phone, body: text, message_type: "api_transactional", send_at: new Date().toISOString(),
        client_id: clientId(), metadata: { from_phone: from, idempotency_key: b.idempotency_key, booking_pk: b.booking_pk, via: "api" } });
      return res.status(202).json({ queued: 1, ...preview });
    } catch (e) {
      console.error("[OUTBOUND] sms/transactional error:", e.message);
      return bad(res, /opt-out/i.test(e.message) ? "opt-out list unreadable — refusing (fail closed)" : "send failed", /opt-out/i.test(e.message) ? 503 : 500);
    }
  });

  return router;
}
