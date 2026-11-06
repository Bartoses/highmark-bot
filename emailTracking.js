// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TRACKING — opens + clicks for marketing email (both transports: Resend and Gmail/Apps Script)
//
//   At render time (renderCampaignEmail) every http(s) link in the body is pointed at
//     GET /e/c/<send_id>/<sig>?u=<destination>   → records a click, 302s to the destination (UTMs untouched)
//   and a 1×1 image is added next to the footer:
//     GET /e/o/<send_id>/<sig>.gif               → records an open, returns a transparent GIF
//   <sig> is an HMAC (EMAIL_TRACKING_SECRET) over the send id (+ destination for clicks), so a link can't be
//   re-pointed at another site (no open redirect) and nobody can forge hits for someone else.
//
// Honest limits:
//   • Opens are approximate. Apple Mail Privacy Protection loads every image on delivery (inflates opens) and
//     clients that block images never report one (deflates them). Clicks are the reliable number.
//   • Link scanners (corporate mail filters, Safe Links…) "click" everything; hits whose user agent looks like a
//     scanner are stored with is_bot = true and left out of the stats.
//   • Tracking is OFF unless EMAIL_TRACKING_SECRET is set — emails then render exactly as before. Rotating the
//     secret breaks every tracked link in emails already sent, so don't.
//   • Previews / test sends have no send row, so they're never tracked. Booking (transactional) emails aren't either.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";

const MIN_SECRET = 16;
const MAX_URL = 2000;
const SEND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export function resolveTrackingSecret() {
  const s = (process.env.EMAIL_TRACKING_SECRET || "").trim();
  return s.length >= MIN_SECRET ? s : null;
}

// ── signing (pure) ───────────────────────────────────────────────────────────
const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("base64url").slice(0, 22);
const sameSig = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const isTrackableUrl = (u) => typeof u === "string" && u.length <= MAX_URL && /^https?:\/\/[^\s"'<>]+$/i.test(u);

export function buildClickUrl({ baseUrl, secret, sendId, url }) {
  return `${String(baseUrl).replace(/\/$/, "")}/e/c/${sendId}/${sign(secret, `c:${sendId}:${url}`)}?u=${encodeURIComponent(url)}`;
}
export function buildOpenUrl({ baseUrl, secret, sendId }) {
  return `${String(baseUrl).replace(/\/$/, "")}/e/o/${sendId}/${sign(secret, `o:${sendId}`)}.gif`;
}
export const verifyClick = (secret, sendId, url, sig) => !!secret && SEND_ID.test(sendId ?? "") && isTrackableUrl(url) && sameSig(sig, sign(secret, `c:${sendId}:${url}`));
export const verifyOpen  = (secret, sendId, sig) => !!secret && SEND_ID.test(sendId ?? "") && sameSig(sig, sign(secret, `o:${sendId}`));

// ── html rewriting (pure) ────────────────────────────────────────────────────
const decodeAttr = (v) => v.replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'");
const encodeAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// Points every http(s) <a href> at rewrite(url). Leaves alone: mailto:/tel:/#anchors, unsubscribe links, and any
// link marked data-notrack. Attribute order, quoting and the rest of the tag are preserved.
export function rewriteLinks(html, rewrite) {
  return String(html ?? "").replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])([\s\S]*?)\2([^>]*)>/gi, (tag, before, _q, raw, after) => {
    if (/\bdata-notrack\b/i.test(before + after)) return tag;
    const url = decodeAttr(raw.trim());
    if (!isTrackableUrl(url) || /\/email\/unsubscribe\//i.test(url)) return tag;
    return `<a${before}href="${encodeAttr(rewrite(url))}"${after}>`;
  });
}

export const openPixelHtml = (src) =>
  `<img src="${encodeAttr(src)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;

// Scanners, prefetchers, scripts. Gmail's GoogleImageProxy is a real person opening the email, so it is NOT here.
const BOT_UA = /bot\b|crawl|spider|slurp|scanner|preview|python|curl\/|wget|go-http|java\/|okhttp|headless|phantom|barracuda|proofpoint|mimecast|safelinks|urldefense|forcepoint|symantec|trendmicro/i;
export const isLikelyBot = (ua) => !ua || BOT_UA.test(ua);

// ── recording ────────────────────────────────────────────────────────────────
export async function recordEmailEvent(crm, { sendId, type, url = null, userAgent = "", nowMs = Date.now() }) {
  if (!crm) return { recorded: false };
  const { data: row } = await crm.from("email_sends").select("id, campaign_id, client_id, opened_at, clicked_at").eq("id", sendId).maybeSingle();
  if (!row) return { recorded: false };
  const iso = new Date(nowMs).toISOString();
  const bot = isLikelyBot(userAgent);
  await crm.from("email_events").insert({
    send_id: row.id, campaign_id: row.campaign_id, client_id: row.client_id, type,
    url: type === "click" ? url : null, user_agent: String(userAgent || "").slice(0, 300) || null, is_bot: bot,
  });
  if (!bot) {   // first human open / click — a click proves an open too
    if (type === "click" && !row.clicked_at) await crm.from("email_sends").update({ clicked_at: iso }).eq("id", row.id).is("clicked_at", null);
    if (!row.opened_at) await crm.from("email_sends").update({ opened_at: iso }).eq("id", row.id).is("opened_at", null);
  }
  return { recorded: true, bot };
}

// ── public routes ────────────────────────────────────────────────────────────
export async function handleTrackClick(req, res, { crm, secret = resolveTrackingSecret() } = {}) {
  const { sendId, sig } = req.params ?? {};
  const url = typeof req.query?.u === "string" ? req.query.u : "";
  res.set("Cache-Control", "no-store");
  if (!verifyClick(secret, sendId, url, sig)) {
    return res.status(404).type("html").send("<!doctype html><meta name=viewport content='width=device-width'><p style='font-family:sans-serif;padding:24px'>This link isn't valid anymore.</p>");
  }
  res.redirect(302, url);   // the person never waits on the database
  recordEmailEvent(crm, { sendId, type: "click", url, userAgent: req.get?.("user-agent") }).catch(e => console.error("[TRACK/CLICK]", e.message));
}

export async function handleTrackOpen(req, res, { crm, secret = resolveTrackingSecret() } = {}) {
  const { sendId } = req.params ?? {};
  const sig = String(req.params?.sig ?? "").replace(/\.gif$/i, "");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", Pragma: "no-cache" });
  res.status(200).send(PIXEL_GIF);   // always an image — a broken-image icon would look wrong in the email
  if (verifyOpen(secret, sendId, sig)) {
    recordEmailEvent(crm, { sendId, type: "open", userAgent: req.get?.("user-agent") }).catch(e => console.error("[TRACK/OPEN]", e.message));
  }
}

// ── stats ────────────────────────────────────────────────────────────────────
async function selectAll(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}

const REACHED = ["sent", "delivered"];
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// Per-campaign engagement for the owner: rates, top links, and who clicked (for a follow-up).
export async function computeCampaignEngagement(crm, campaignId) {
  const sends = await selectAll(() => crm.from("email_sends").select("id, email, status, contact_id, sent_at, opened_at, clicked_at").eq("campaign_id", campaignId).order("id"));
  const events = await selectAll(() => crm.from("email_events").select("send_id, type, url, is_bot, created_at").eq("campaign_id", campaignId).order("id"));

  const reached = sends.filter(s => REACHED.includes(s.status)).length;
  const bounced = sends.filter(s => s.status === "bounced" || s.status === "complained").length;
  const opened  = sends.filter(s => s.opened_at).length;
  const clicked = sends.filter(s => s.clicked_at).length;

  const human = events.filter(e => !e.is_bot);
  const links = new Map(); const perSend = new Map();
  for (const e of human) {
    if (e.type !== "click" || !e.url) continue;
    const l = links.get(e.url) ?? { url: e.url, clicks: 0, people: new Set() };
    l.clicks++; l.people.add(e.send_id); links.set(e.url, l);
    perSend.set(e.send_id, (perSend.get(e.send_id) ?? 0) + 1);
  }
  const byId = new Map(sends.map(s => [s.id, s]));
  const clickers = [...perSend.entries()].map(([id, clicks]) => ({ email: byId.get(id)?.email ?? null, clicks, first_clicked_at: byId.get(id)?.clicked_at ?? null }))
    .filter(c => c.email).sort((a, b) => String(a.first_clicked_at).localeCompare(String(b.first_clicked_at))).slice(0, 500);

  // unsubscribed after this email went out (any time later — the footer link is the usual path)
  let unsubscribed = 0;
  const firstSent = sends.map(s => s.sent_at).filter(Boolean).sort()[0];
  const contactIds = [...new Set(sends.map(s => s.contact_id).filter(Boolean))];
  if (firstSent) {
    for (let i = 0; i < contactIds.length; i += 100) {
      const { data } = await crm.from("contacts").select("id, email_unsubscribed_at").in("id", contactIds.slice(i, i + 100));
      unsubscribed += (data ?? []).filter(c => c.email_unsubscribed_at && c.email_unsubscribed_at >= firstSent).length;
    }
  }

  return {
    reached, bounced, opened, clicked, unsubscribed,
    open_rate: pct(opened, reached), click_rate: pct(clicked, reached), click_to_open: pct(clicked, opened),
    total_clicks: human.filter(e => e.type === "click").length,
    bot_hits: events.length - human.length,
    links: [...links.values()].map(l => ({ url: l.url, clicks: l.clicks, people: l.people.size })).sort((a, b) => b.people - a.people || b.clicks - a.clicks),
    clickers,
  };
}
