// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SENDER — queue → Resend batches → delivery tracking → suppression
//
//   enqueueCampaignSends()  writes one `email_sends` row (status 'queued') per recipient
//   processEmailQueue()     claims queued rows, RE-CHECKS eligibility at send time (consent
//                           may have changed since queueing), renders per recipient, sends in
//                           Resend batches, records the Resend id. Run by the cron worker
//                           every tick AND kicked immediately by the API.
//   handleResendWebhook()   Resend → delivered / bounced / complained; hard bounces and spam
//                           complaints SUPPRESS the address so it is never mailed again.
//
// Reliability:
//   • claim = conditional UPDATE queued→sending, so the web process and the cron worker can
//     never send the same row twice;
//   • rows stuck in 'sending' (a crashed worker) return to 'queued' after 10 minutes;
//   • every batch carries an Idempotency-Key derived from its row ids, so a retry after a
//     crash cannot double-email;
//   • a bad address fails the whole Resend batch, so a failed batch is retried one-by-one to
//     isolate it; after 3 attempts a row is marked 'failed'.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import { sendEmailBatch, fromAddress, RESEND_BATCH_MAX } from "./emailService.js";
import { renderEmailForRecipient, renderMergeFields, wrapEmailShell, htmlToPlainText, buildUnsubscribeUrl, escapeHtml } from "./emailTemplates.js";
import { resolveSendFrom, getClientDomain } from "./emailDomains.js";
import { resolveClientById } from "./clients.js";
import { suppressEmail, loadSuppressionSets, normEmail } from "./emailSuppression.js";

const STUCK_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const CHUNK = 200;

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

// RFC 8058 one-click unsubscribe: mailbox providers show a native "Unsubscribe" button and
// (for bulk senders) increasingly REQUIRE it. Points at the POST-capable public route.
export function buildListUnsubscribeHeaders(baseUrl, token) {
  if (!token) return {};
  const url = buildUnsubscribeUrl(baseUrl, token);
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

// Absolute URL for unsubscribe links. A relative link in an email goes nowhere, so never let this be empty.
export function resolveBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return "https://highmark-bot-production.up.railway.app";
}

// CAN-SPAM requires a physical postal address in every commercial email.
export const resolveMailingAddress = (client) => (client?.address || process.env.MAILING_ADDRESS || "").trim() || null;

// Where replies go. With a shared sender address (news@usehighmark.com) nobody reads that inbox, so an outbound email
// must ALWAYS carry a real Reply-To: explicit → the client's support email → OUTBOUND_REPLY_TO.
export const resolveReplyTo = (explicit, client) => explicit || client?.supportEmail || (process.env.OUTBOUND_REPLY_TO || "").trim() || null;

// Precedence: the client's OWN verified domain (client_email_domains) → OUTBOUND_FROM_EMAIL (the sender address for
// campaigns + booking emails on a verified shared domain, e.g. news@usehighmark.com) → RESEND_FROM_EMAIL (which the
// portal-invite emails also use, so it is left alone). The display name is always the client's/campaign's.
export function resolveFrom({ displayName, domainRow = null }) {
  const own = resolveSendFrom(domainRow, displayName);
  if (own) return own;
  const shared = (process.env.OUTBOUND_FROM_EMAIL || "").trim();
  if (shared) {
    const m = shared.match(/<(.+)>/);
    const address = m ? m[1] : shared;
    return displayName ? `${displayName} <${address}>` : address;
  }
  return fromAddress(displayName);
}

export function renderCampaignEmail({ campaign, client, recipient, baseUrl, domainRow = null }) {
  const businessName = client?.name ?? "Your Business";
  const rendered = renderEmailForRecipient({
    subject: campaign.subject, previewText: campaign.preview_text, bodyHtml: campaign.body_html,
    businessName, address: resolveMailingAddress(client), baseUrl,
    mergeVars: { first_name: recipient.first_name ?? "there", last_name: recipient.last_name ?? "" },
    unsubscribeToken: recipient.unsubscribe_token ?? "preview",
  });
  const displayName = campaign.from_name || businessName;
  return {
    from: resolveFrom({ displayName, domainRow }),
    to: [recipient.email],
    subject: rendered.subject, html: rendered.html, text: rendered.text,
    ...(resolveReplyTo(campaign.reply_to, client) ? { reply_to: resolveReplyTo(campaign.reply_to, client) } : {}),
    headers: buildListUnsubscribeHeaders(baseUrl, recipient.unsubscribe_token),
    tags: [{ name: "category", value: "marketing" }, ...(campaign.id ? [{ name: "campaign", value: String(campaign.id).replace(/[^A-Za-z0-9_-]/g, "_") }] : [])],
  };
}

// A booking email: no unsubscribe link (it's about their own booking) but still identifies the business.
export function renderTransactionalEmail({ row, client, mergeVars = {}, domainRow = null, replyTo = null }) {
  const businessName = client?.name ?? "Your Business";
  const address = resolveMailingAddress(client);
  const vars = { business_name: businessName, ...mergeVars };
  const body = renderMergeFields(row.body_html ?? "", vars);
  const footer =
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 6px;">${escapeHtml(businessName)}${address ? ` · ${escapeHtml(address)}` : ""}</p>` +
    `<p style="margin:0;">You're receiving this message about your booking with ${escapeHtml(businessName)}.</p></div>`;
  return {
    from: resolveFrom({ displayName: businessName, domainRow }),
    to: [row.email],
    subject: renderMergeFields(row.subject ?? "", vars),
    html: wrapEmailShell({ previewText: null, bodyHtml: body, footerHtml: footer }),
    text: `${htmlToPlainText(body)}\n\n${businessName}${address ? ` · ${address}` : ""}`,
    ...(resolveReplyTo(replyTo, client) ? { reply_to: resolveReplyTo(replyTo, client) } : {}),
    tags: [{ name: "category", value: "transactional" }],
  };
}

export const batchIdempotencyKey = (ids) => "eq-" + crypto.createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 40);

// Svix (Resend) webhook signature. secret = "whsec_<base64>"; signed payload = `${id}.${timestamp}.${rawBody}`;
// header may carry several space-separated "v1,<base64>" signatures (key rotation).
export function verifySvixSignature({ secret, id, timestamp, signature, body, toleranceSec = 300, nowMs = Date.now() }) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSec) return false;   // replay protection
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${typeof body === "string" ? body : Buffer.from(body).toString("utf8")}`).digest();
  for (const part of String(signature).split(" ")) {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
  }
  return false;
}

// ── queueing ─────────────────────────────────────────────────────────────────
export async function enqueueCampaignSends(crm, { campaignId, clientId, recipients, transport = "resend" }) {
  let queued = 0;
  for (let i = 0; i < recipients.length; i += CHUNK) {
    const rows = recipients.slice(i, i + CHUNK).map(r => ({
      campaign_id: campaignId, client_id: clientId, contact_id: r.contact_id ?? null,
      email: normEmail(r.email), category: "marketing", status: "queued", transport,
    }));
    // ignoreDuplicates: re-queueing the same campaign can never create a second send for an address
    const { error } = await crm.from("email_sends").upsert(rows, { onConflict: "campaign_id,email", ignoreDuplicates: true });
    if (error) throw new Error(`enqueue failed: ${error.message}`);
    queued += rows.length;
  }
  return queued;
}

// One-off booking email. Returns { row, duplicate } — a repeated idempotencyKey is a no-op.
export async function enqueueTransactional(crm, { clientId, contactId = null, email, subject, bodyHtml, reference, idempotencyKey, transport = "resend" }) {
  const row = {
    campaign_id: null, client_id: clientId, contact_id: contactId, email: normEmail(email), category: "transactional",
    status: "queued", transport, subject, body_html: bodyHtml, reference: reference ?? null, idempotency_key: idempotencyKey,
  };
  const { data, error } = await crm.from("email_sends").insert(row).select("id").single();
  if (!error && data) return { row: data, duplicate: false };
  const { data: existing } = await crm.from("email_sends").select("id, status").eq("idempotency_key", idempotencyKey).limit(1).maybeSingle();
  if (existing) return { row: existing, duplicate: true };
  throw new Error(`enqueue transactional failed: ${error?.message}`);
}

// The same wiring for the web process and the cron worker, so a send behaves identically
// whichever one happens to drain the queue.
export function defaultQueueDeps() {
  return {
    resolveClient: (id) => resolveClientById(id),
    getCampaign: async (db1, id) => (db1 ? (await db1.from("email_campaigns").select("*").eq("id", id).maybeSingle()).data : null),
    getDomain: (db1, id) => (db1 ? getClientDomain(db1, id) : null),   // null/throws while client_email_domains isn't applied → shared sender
  };
}

// ── processing ───────────────────────────────────────────────────────────────
// Shared by BOTH transports (Resend worker + Gmail pull): given rows already claimed ('sending'), re-check
// eligibility against the CURRENT database state (consent may have changed since queueing; an address may have been
// unsubscribed on another row), then render — or skip/hold. One code path ⇒ the rules cannot drift between transports.
async function prepareRows(crm, db1, claimed, { resolveClient, getCampaign, getDomain, baseUrl, setRow, release, out }) {
  // 3. current facts about each recipient + address-level suppression
  const contactIds = [...new Set(claimed.map(r => r.contact_id).filter(Boolean))];
  const contacts = new Map();
  for (let i = 0; i < contactIds.length; i += 100) {
    const { data } = await crm.from("contacts")
      .select("id, first_name, last_name, email, email_marketing_consent, email_unsubscribed_at, email_suppressed_at, email_unsubscribe_token")
      .in("id", contactIds.slice(i, i + 100));
    for (const c of data ?? []) contacts.set(c.id, c);
  }
  const sup = await loadSuppressionSets(crm);

  // 4. render (or skip)
  const campaigns = new Map(); const domains = new Map();
  const ready = [];   // { row, item }
  for (const row of claimed) {
    const email = normEmail(row.email);
    const contact = row.contact_id ? contacts.get(row.contact_id) : null;
    const client = resolveClient(row.client_id);
    let item = null, skipReason = null;

    if (row.category === "transactional") {
      if (sup.hard.has(email)) skipReason = "address_suppressed";
      else item = renderTransactionalEmail({ row: { ...row, email }, client, mergeVars: { first_name: contact?.first_name ?? "there" } });
    } else {
      if (!campaigns.has(row.campaign_id)) campaigns.set(row.campaign_id, getCampaign ? await getCampaign(db1, row.campaign_id) : null);
      const campaign = campaigns.get(row.campaign_id);
      if (!campaign) skipReason = "campaign_missing";
      else if (!resolveMailingAddress(client)) {
        // Defence in depth (the API also refuses up front): a marketing email without a postal address breaks
        // CAN-SPAM. The worker that drains the queue may be a different service from the one that queued it,
        // so check here too. Hold the row — nothing is lost — and surface it.
        out.blocked = "no_mailing_address"; await release([row]); continue;
      }
      else if (sup.all.has(email)) skipReason = "no_longer_eligible";
      else if (!contact || contact.email_marketing_consent !== true) skipReason = "no_longer_eligible";
      else {
        if (!domains.has(row.client_id)) domains.set(row.client_id, await getDomain(db1, row.client_id).catch(() => null));
        item = renderCampaignEmail({
          campaign, client, baseUrl, domainRow: domains.get(row.client_id),
          // NB: the contacts column is email_unsubscribe_token; the renderer reads unsubscribe_token.
          recipient: { email, first_name: contact.first_name, last_name: contact.last_name, unsubscribe_token: contact.email_unsubscribe_token },
        });
      }
    }
    if (skipReason) { await setRow(row.id, { status: "skipped", error: skipReason }); out.skipped++; }
    else ready.push({ row, item });
  }
  return { ready, campaigns };
}

async function finishCampaigns(crm, db1, campaignIds, getCampaign, iso) {
  if (!getCampaign || !db1) return;
  for (const campaignId of campaignIds) {
    if (!campaignId) continue;
    const { data: rows } = await crm.from("email_sends").select("status").eq("campaign_id", campaignId);
    const st = (rows ?? []).map(r => r.status);
    if (st.length && !st.some(x => x === "queued" || x === "sending")) {
      const total = st.filter(x => ["sent", "delivered", "bounced", "complained"].includes(x)).length;
      await db1.from("email_campaigns").update({ status: "sent", sent_at: iso, total_sent: total, updated_at: iso }).eq("id", campaignId);
    }
  }
}


export async function processEmailQueue(crm, db1, {
  limit = RESEND_BATCH_MAX, sendBatch = sendEmailBatch, resolveClient = () => null, getCampaign = null,
  getDomain = async () => null, baseUrl = resolveBaseUrl(), nowMs = Date.now(),
} = {}) {
  const out = { claimed: 0, sent: 0, skipped: 0, failed: 0, requeued: 0, blocked: null };
  if (!crm) return out;
  const iso = () => new Date(nowMs).toISOString();

  // 0. crashed-worker recovery
  await crm.from("email_sends").update({ status: "queued", updated_at: iso() })
    .eq("status", "sending").neq("transport", "gmail").lt("updated_at", new Date(nowMs - STUCK_MINUTES * 60000).toISOString());

  // 1. candidates → 2. atomic claim (only rows still 'queued' flip to 'sending' for us)
  const { data: cand, error: cErr } = await crm.from("email_sends").select("id").eq("status", "queued").neq("transport", "gmail").order("queued_at", { ascending: true }).limit(limit);
  if (cErr) throw new Error(`queue read failed: ${cErr.message}`);
  if (!cand?.length) return out;
  const { data: claimed, error: clErr } = await crm.from("email_sends").update({ status: "sending", updated_at: iso() })
    .in("id", cand.map(c => c.id)).eq("status", "queued").neq("transport", "gmail").select();
  if (clErr) throw new Error(`queue claim failed: ${clErr.message}`);
  if (!claimed?.length) return out;
  out.claimed = claimed.length;

  const setRow = (id, patch) => crm.from("email_sends").update({ ...patch, updated_at: iso() }).eq("id", id);
  const release = async (rows, patch = {}) => { for (const r of rows) await setRow(r.id, { status: "queued", ...patch }); };

  const { ready, campaigns } = await prepareRows(crm, db1, claimed, { resolveClient, getCampaign, getDomain, baseUrl, setRow, release, out });

  // 5. send in batches; on a whole-batch validation failure retry one-by-one to isolate the bad address
  const settle = async (entries, result) => {
    if (result.sent) {
      for (let i = 0; i < entries.length; i++) {
        await setRow(entries[i].row.id, { status: "sent", provider_id: result.ids[i], sent_at: iso(), error: null, attempts: (entries[i].row.attempts ?? 0) + 1 });
        out.sent++;
      }
      return true;
    }
    if (["test_mode", "not_configured"].includes(result.reason)) { out.blocked = result.reason; await release(entries.map(e => e.row)); return false; }
    return null;   // real failure → caller decides
  };
  const failOrRequeue = async (entry, detail) => {
    const attempts = (entry.row.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) { await setRow(entry.row.id, { status: "failed", attempts, error: String(detail).slice(0, 300) }); out.failed++; }
    else { await setRow(entry.row.id, { status: "queued", attempts, error: String(detail).slice(0, 300) }); out.requeued++; }
  };

  for (let i = 0; i < ready.length; i += RESEND_BATCH_MAX) {
    const entries = ready.slice(i, i + RESEND_BATCH_MAX);
    const result = await sendBatch(entries.map(e => e.item), { idempotencyKey: batchIdempotencyKey(entries.map(e => e.row.id)) });
    const done = await settle(entries, result);
    if (done === false) { for (const rest of ready.slice(i + RESEND_BATCH_MAX)) await release([rest.row]); break; }
    if (done === true) continue;
    if (result.status >= 400 && result.status < 500 && entries.length > 1) {
      for (const e of entries) {                        // isolate the bad address
        const one = await sendBatch([e.item], { idempotencyKey: batchIdempotencyKey([e.row.id]) });
        const r = await settle([e], one);                 // true = sent, false = blocked (already released), null = real failure
        if (r === null) await failOrRequeue(e, one.detail ?? one.reason ?? "send failed");
      }
    } else {
      for (const e of entries) await failOrRequeue(e, result.detail ?? result.reason ?? "send failed");
    }
  }

  // 6. finish any campaign with nothing left to send
  await finishCampaigns(crm, db1, [...campaigns.keys()], getCampaign, iso());
  return out;
}

// ── Gmail transport ──────────────────────────────────────────────────────────
// For a client that can't authenticate its own domain with Resend (no DNS access), the SYSTEM still decides who may be
// emailed and renders every message (consent re-check, suppression, CAN-SPAM footer, unsubscribe link) — but DELIVERY is done
// by the owner's Gmail via Apps Script, which is the only thing that can send "as" info@<their domain> without DNS:
//   POST /email/send {transport:"gmail"}  → rows queue with transport='gmail' (the Resend worker never touches them)
//   POST /email/pull                       → Apps Script claims up to N rendered messages
//   (Apps Script sends each with GmailApp, from the info@ alias)
//   POST /email/report                     → Apps Script reports sent / failed per message
//   POST /email/bounces                    → Apps Script reports addresses that bounced → suppressed
// Gmail caps recipients per day (≈100 free, ≈1,500 Workspace) so a big send spans days: pull only what today's quota allows.
const GMAIL_STUCK_MINUTES = 30;
const PERMANENT_FAILURE = /invalid|not a valid|no recipient|couldn'?t be found|does not exist|no such|unknown user/i;

export async function pullGmailMessages(crm, db1, {
  campaignId = null, sendIds = null, limit = 90, resolveClient = () => null, getCampaign = null,
  baseUrl = resolveBaseUrl(), nowMs = Date.now(),
} = {}) {
  const out = { claimed: 0, skipped: 0, blocked: null, messages: [], remaining: 0 };
  if (!crm) return out;
  const iso = new Date(nowMs).toISOString();
  const setRow = (id, patch) => crm.from("email_sends").update({ ...patch, updated_at: iso }).eq("id", id);
  const release = async (rows) => { for (const r of rows) await setRow(r.id, { status: "queued" }); };
  const cap = Math.max(0, Math.min(Number(limit) || 0, 500));

  // recover rows a crashed/aborted script run left in 'sending'
  await crm.from("email_sends").update({ status: "queued", updated_at: iso })
    .eq("transport", "gmail").eq("status", "sending").lt("updated_at", new Date(nowMs - GMAIL_STUCK_MINUTES * 60000).toISOString());

  if (cap > 0) {
    let q = crm.from("email_sends").select("id").eq("transport", "gmail").eq("status", "queued").order("queued_at", { ascending: true }).limit(cap);
    if (campaignId) q = q.eq("campaign_id", campaignId);
    if (sendIds?.length) q = q.in("id", sendIds);
    const { data: cand, error } = await q;
    if (error) throw new Error(`gmail queue read failed: ${error.message}`);
    if (cand?.length) {
      const { data: claimed, error: clErr } = await crm.from("email_sends").update({ status: "sending", updated_at: iso })
        .in("id", cand.map(c => c.id)).eq("status", "queued").eq("transport", "gmail").select();
      if (clErr) throw new Error(`gmail queue claim failed: ${clErr.message}`);
      out.claimed = claimed?.length ?? 0;
      if (out.claimed) {
        const { ready } = await prepareRows(crm, db1, claimed, { resolveClient, getCampaign, getDomain: async () => null, baseUrl, setRow, release, out });
        out.messages = ready.map(({ row, item }) => ({
          send_id: row.id, campaign_id: row.campaign_id, category: row.category,
          to: item.to[0], subject: item.subject, html: item.html, text: item.text, reply_to: item.reply_to ?? null,
        }));
      }
    }
  }
  let rq = crm.from("email_sends").select("id").eq("transport", "gmail").eq("status", "queued");
  if (campaignId) rq = rq.eq("campaign_id", campaignId);
  out.remaining = ((await rq).data ?? []).length;
  await finishCampaigns(crm, db1, campaignId ? [campaignId] : [], getCampaign, iso);
  return out;
}

// results: [{ send_id, ok, error? }]. Only rows currently 'sending' are touched, so a repeated report is a harmless no-op.
export async function reportGmailResults(crm, db1, results, { getCampaign = null, nowMs = Date.now() } = {}) {
  const out = { sent: 0, failed: 0, requeued: 0, ignored: 0 };
  if (!crm || !Array.isArray(results)) return out;
  const iso = new Date(nowMs).toISOString(); const touched = new Set();
  for (const r of results) {
    if (!r?.send_id) { out.ignored++; continue; }
    const { data } = await crm.from("email_sends").select("id, status, attempts, campaign_id").eq("id", r.send_id).eq("transport", "gmail").limit(1);
    const row = data?.[0];
    if (!row || row.status !== "sending") { out.ignored++; continue; }
    if (row.campaign_id) touched.add(row.campaign_id);
    if (r.deferred === true) {   // the caller ran out of daily quota before reaching this one: back in line, no attempt burned
      await crm.from("email_sends").update({ status: "queued", updated_at: iso }).eq("id", row.id); out.deferred = (out.deferred ?? 0) + 1; continue;
    }
    const attempts = (row.attempts ?? 0) + 1;
    if (r.ok === true) {
      await crm.from("email_sends").update({ status: "sent", provider_id: "gmail", sent_at: iso, error: null, attempts, updated_at: iso }).eq("id", row.id); out.sent++;
    } else {
      const err = String(r.error ?? "send failed").slice(0, 300);
      if (PERMANENT_FAILURE.test(err) || attempts >= MAX_ATTEMPTS) { await crm.from("email_sends").update({ status: "failed", error: err, attempts, updated_at: iso }).eq("id", row.id); out.failed++; }
      else { await crm.from("email_sends").update({ status: "queued", error: err, attempts, updated_at: iso }).eq("id", row.id); out.requeued++; }
    }
  }
  await finishCampaigns(crm, db1, [...touched], getCampaign, iso);
  return out;
}

// Addresses that bounced (found by scanning the Gmail inbox for delivery failures). Only addresses WE emailed through Gmail are
// acted on, and a bounce suppresses the address everywhere.
export async function reportGmailBounces(crm, emails, { nowMs = Date.now() } = {}) {
  const out = { suppressed: 0, unknown: 0 };
  if (!crm || !Array.isArray(emails)) return out;
  const at = new Date(nowMs).toISOString();
  for (const raw of [...new Set(emails.map(normEmail))]) {
    const { data } = await crm.from("email_sends").select("id, status").eq("email", raw).eq("transport", "gmail").in("status", ["sent", "delivered"]);
    if (!data?.length) { out.unknown++; continue; }
    for (const row of data) await crm.from("email_sends").update({ status: "bounced", bounced_at: at, bounce_type: "Permanent", updated_at: at }).eq("id", row.id);
    await suppressEmail(crm, raw, { reason: "bounce", suppress: true, at });
    out.suppressed++;
  }
  return out;
}

// Keep processing until the queue is empty (or nothing is making progress). Resend's default
// limit is 2 requests/second, hence the pause between batches.
export async function drainEmailQueue(crm, db1, deps = {}, { maxRuns = 30, sleepMs = 600 } = {}) {
  const total = { claimed: 0, sent: 0, skipped: 0, failed: 0, requeued: 0, blocked: null };
  for (let i = 0; i < maxRuns; i++) {
    const r = await processEmailQueue(crm, db1, deps);
    for (const k of ["claimed", "sent", "skipped", "failed", "requeued"]) total[k] += r[k];
    if (r.blocked) { total.blocked = r.blocked; break; }
    if (!r.claimed || (!r.sent && !r.skipped)) break;   // empty, or failing — retry on the next tick, don't hot-loop
    if (sleepMs) await new Promise(res => setTimeout(res, sleepMs));
  }
  return total;
}

// ── delivery events (Resend webhook) ─────────────────────────────────────────
export async function applyResendEvent(crm, event, { nowMs = Date.now() } = {}) {
  const type = event?.type, d = event?.data ?? {}, providerId = d.email_id;
  if (!providerId) return { handled: false, reason: "no_email_id" };
  const { data: rows } = await crm.from("email_sends").select("id, email, status, category").eq("provider_id", providerId).limit(1);
  const row = rows?.[0];
  if (!row) return { handled: false, reason: "unknown_email_id" };
  const at = new Date(nowMs).toISOString();
  const upd = (patch) => crm.from("email_sends").update({ ...patch, updated_at: at }).eq("id", row.id);

  if (type === "email.delivered") {
    if (["sent", "sending"].includes(row.status)) await upd({ status: "delivered", delivered_at: at });   // never downgrade a bounce/complaint
    return { handled: true, type };
  }
  if (type === "email.bounced") {
    const bounceType = d.bounce?.type ?? "Permanent";
    await upd({ status: "bounced", bounced_at: at, bounce_type: bounceType });
    // Resend only emits email.bounced for failures it gave up on; suppress unless it says transient.
    if (!/transient/i.test(String(bounceType))) await suppressEmail(crm, row.email, { reason: "bounce", suppress: true, at });
    return { handled: true, type, suppressed: !/transient/i.test(String(bounceType)) };
  }
  if (type === "email.complained") {
    await upd({ status: "complained", complained_at: at });
    await suppressEmail(crm, row.email, { reason: "complaint", unsubscribe: true, suppress: true, at });   // a spam report is also an unsubscribe
    return { handled: true, type, suppressed: true };
  }
  if (type === "email.failed") { await upd({ status: "failed", error: String(d.reason ?? "provider failure").slice(0, 300) }); return { handled: true, type }; }
  return { handled: false, reason: "ignored_event" };
}

// Express handler — mount with express.raw({ type: "application/json" }) BEFORE express.json().
export async function handleResendWebhook(req, res, { crm, secret = process.env.RESEND_WEBHOOK_SECRET } = {}) {
  if (!secret) return res.status(503).json({ error: "RESEND_WEBHOOK_SECRET not configured" });   // never accept unverified events
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
  const ok = verifySvixSignature({
    secret, id: req.get("svix-id"), timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature"), body: raw,
  });
  if (!ok) return res.status(400).json({ error: "invalid signature" });
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: "invalid json" }); }
  try { const r = await applyResendEvent(crm, event); return res.status(200).json({ ok: true, ...r }); }
  catch (err) { console.error("[RESEND WEBHOOK] error:", err.message); return res.status(500).json({ error: "processing failed" }); }   // 5xx → Resend retries
}
