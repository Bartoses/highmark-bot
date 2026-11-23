// ─────────────────────────────────────────────────────────────────────────────
// GUIDE RIDE LOG — slice 1 (sprint: docs/sprints/sprint-guide-app.md)
//
// A phone-first page (/guide, public/guide.html) where guides, shop staff and managers see today's FareHarbor departures,
// claim "this is my ride", upload photos and add the ride's details. Everything is keyed by the FareHarbor departure id
// (bookings.raw_payload…availability.pk), so a photo reaches exactly the guests on that ride, and the evening Ride Recap
// uses it directly (photo_hint.hosted_photo, no Apps Script photo step).
//
// Access: a signed link (HMAC of operator phone + local date) sent in the morning briefing. The phone must still be an
// operator_phones row (DB1) at request time; its role decides what the page shows. Guest emails and phone numbers are
// never sent to the page (first names only).
//
// DB2 tables: ride_logs, ride_assignments, ride_media (db2_ride_logs.sql). Storage: recap-photos (same as recaps).
// Slice 1 = departures, claim, photos, ride details. Later: videos, rider tags, manager board, Drive sync.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import { bookingFacts, matchTour, localDate, addDays, localHour, cleanFirstName } from "./rideRecap.js";
import { processRidePhoto, uploadRidePhotos, PHOTO_SPEC } from "./recapSimple.js";

export const GUIDE_TZ = "America/Denver";
export const MANAGER_ROLES = ["owner", "general_manager", "operations_manager", "manager"];
export const SHOP_ROLES = ["reservations", "sales"];
export const GUIDE_ROLES = ["guide", "staff"];
export const CONDITIONS = ["fresh_snow", "bluebird", "snowing", "windy", "cold"];

export function accessFor(role) {
  const r = String(role ?? "").toLowerCase();
  if (MANAGER_ROLES.includes(r)) return "manager";
  if (SHOP_ROLES.includes(r)) return "shop";
  if (GUIDE_ROLES.includes(r)) return "guide";
  return null;                                                         // fleet / mechanic / marketing: no ride log
}

// ── signed links ─────────────────────────────────────────────────────────────
const linkSecret = () => (process.env.GUIDE_LINK_SECRET || process.env.EMAIL_TRACKING_SECRET || process.env.OUTBOUND_API_KEY || "").trim() || null;
const b64u = (s) => Buffer.from(s).toString("base64url");
const sig = (body, secret) => crypto.createHmac("sha256", secret).update(`guide:${body}`).digest("base64url").slice(0, 32);

export function signGuideToken({ phone, date, secret = linkSecret() }) {
  if (!secret || !/^\+\d{8,15}$/.test(String(phone ?? "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  const body = b64u(JSON.stringify({ p: phone, d: date }));
  return `${body}.${sig(body, secret)}`;
}

// Valid on its date, and until 3 am the next morning (late logging). → { phone, date } | null
export function verifyGuideToken(token, { now = new Date(), secret = linkSecret() } = {}) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const want = sig(body, secret);
  if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!p?.p || !p?.d) return null;
  const today = localDate(now, GUIDE_TZ);
  const ok = p.d === today || (p.d === addDays(today, -1) && localHour(now, GUIDE_TZ) < 3);
  return ok ? { phone: p.p, date: p.d } : null;
}

export function guideLinkUrl(baseUrl, { phone, now = new Date(), secret = linkSecret() }) {
  const t = signGuideToken({ phone, date: localDate(now, GUIDE_TZ), secret });
  return t ? `${String(baseUrl).replace(/\/$/, "")}/guide?t=${encodeURIComponent(t)}` : null;
}

// The line added to the morning briefing (GUIDE_APP_LINKS=true). null = no line for this person/time.
export function guideBriefingLine({ baseUrl, phone, role, timeOfDay = "morning", now = new Date(), enabled = process.env.GUIDE_APP_LINKS === "true" }) {
  if (!enabled || timeOfDay !== "morning" || !accessFor(role)) return null;
  const url = guideLinkUrl(baseUrl, { phone, now });
  return url ? `📸 Log today's rides + photos: ${url}` : null;
}

// ── FareHarbor guide field (if they start using it): a custom field named guide/staff, else the headline ──
export function fareharborGuideName(row) {
  const b = row?.raw_payload?.booking ?? row?.raw_payload ?? {};
  const av = b.availability ?? {};
  for (const f of av.custom_field_instances ?? []) {
    const name = String(f?.custom_field?.name ?? f?.name ?? "");
    if (!/guide|staff/i.test(name)) continue;
    const v = String(f?.display_value ?? f?.value ?? f?.custom_field?.display_value ?? "").trim();
    if (v) return v;
  }
  const h = String(av.headline ?? "").trim();
  const m = h.match(/(?:guide|staff)\s*[:\-–]\s*([A-Za-z][A-Za-z .'\-]{1,40})/i);
  return m ? m[1].trim() : (h && /^[A-Za-z][A-Za-z .'\-]{1,30}$/.test(h) ? h : null);
}

// Match a free-text name to ONE staff member (display_name / label; full or first name). Ambiguous or none → null.
export function matchStaffName(name, staff) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return null;
  const nameOf = (s) => String(s.display_name ?? s.label ?? "").trim().toLowerCase();
  const full = (staff ?? []).filter(s => nameOf(s) && nameOf(s) === n);
  if (full.length === 1) return full[0];
  const first = (staff ?? []).filter(s => nameOf(s) && nameOf(s).split(/\s+/)[0] === n.split(/\s+/)[0]);
  return first.length === 1 ? first[0] : null;
}

// ── departures (pure) ────────────────────────────────────────────────────────
// bookingRows: DB2 rows for one local day. → [{ availability_pk, label, type, item, start_at, end_at, riders, names[], booking_pks[], tour, fh_guide }]
export function groupDepartures(bookingRows, tours, { tz = GUIDE_TZ } = {}) {
  const byPk = new Map();
  for (const row of bookingRows ?? []) {
    const f = bookingFacts(row);
    if (!f.pk.startsWith("#") || f.status !== "booked" || !f.availabilityPk) continue;
    const prev = byPk.get(f.pk);
    if (!prev || String(f.updatedAt ?? "") > String(prev.f.updatedAt ?? "")) byPk.set(f.pk, { f, row });
  }
  const deps = new Map();
  for (const { f, row } of byPk.values()) {
    const tour = matchTour(f.item, tours);
    if (!tour) continue;                                                 // trailers, fuel, gift cards… are not rides
    const d = deps.get(f.availabilityPk) ?? { availability_pk: f.availabilityPk, label: tour.label, type: tour.type, item: f.item,
      start_at: f.startAt, end_at: f.endAt, riders: 0, names: [], booking_pks: [], bookings: [], tour, fh_guide: null, ride_date: f.startAt ? localDate(f.startAt, tz) : null };
    d.riders += f.pax || 0;
    const first = cleanFirstName(f.name);
    if (first && !d.names.includes(first)) d.names.push(first);
    d.booking_pks.push(f.pk);
    d.bookings.push({ pk: f.pk, name: first || "Guest", pax: f.pax || 0 });  // first names only, never email/phone
    d.fh_guide = d.fh_guide ?? fareharborGuideName(row);
    deps.set(f.availabilityPk, d);
  }
  return [...deps.values()].sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)) || a.label.localeCompare(b.label));
}

// Who's on each departure: FareHarbor guide field → manager assignment → guide claim. assignments: ride_assignments rows.
export function resolveAssignees(dep, assignments, staff) {
  const out = [];
  const fh = dep.fh_guide ? matchStaffName(dep.fh_guide, staff) : null;
  if (fh) out.push({ phone: fh.phone, name: fh.display_name ?? fh.label ?? null, source: "fareharbor", booking_pks: [] });
  for (const a of assignments ?? []) {
    if (String(a.availability_pk) !== String(dep.availability_pk) || out.some(o => o.phone === a.operator_phone)) continue;
    out.push({ phone: a.operator_phone, name: a.guide_name ?? null, source: a.source ?? "claim", booking_pks: a.booking_pks ?? [] });
  }
  return out;
}

// What a person may see: managers everything; guides their rides + unassigned guided rides; shop rentals + unassigned.
export function visibleDepartures(deps, { access, phone }) {
  return (deps ?? []).filter(d => {
    if (access === "manager") return true;
    const mine = d.assignees?.some(a => a.phone === phone);
    const open = !d.assignees?.length;
    if (access === "guide") return mine || (open && d.type !== "rental");
    if (access === "shop") return mine || d.type === "rental" || open;
    return false;
  });
}

// ── data access ──────────────────────────────────────────────────────────────
export async function loadOperator(db1, phone, clientId = "csr_rea") {
  const { data, error } = await db1.from("operator_phones").select("id, client_id, phone, role, label, display_name").eq("client_id", clientId).eq("phone", phone).limit(1).maybeSingle();
  if (error || !data) return null;
  return { ...data, access: accessFor(data.role) };
}

async function loadStaff(db1, clientId) {
  const { data } = await db1.from("operator_phones").select("phone, role, label, display_name").eq("client_id", clientId);
  return data ?? [];
}

export async function loadDay(crm, db1, { date, clientId = "csr_rea", tz = GUIDE_TZ }) {
  const from = new Date(`${date}T00:00:00Z`); from.setUTCHours(from.getUTCHours() - 12);   // generous window, filtered by local date below
  const to = new Date(`${date}T00:00:00Z`); to.setUTCHours(to.getUTCHours() + 36);
  const [{ data: rows, error }, { data: tours }, staff] = await Promise.all([
    crm.from("bookings").select("fareharbor_pk, company, status, start_at, end_at, customer_count, product_title, updated_at, raw_payload")
      .like("fareharbor_pk", "#%").gte("start_at", from.toISOString()).lt("start_at", to.toISOString()),
    crm.from("recap_tours").select("*").eq("client_id", clientId),
    loadStaff(db1, clientId),
  ]);
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const deps = groupDepartures((rows ?? []).filter(r => r.start_at && localDate(r.start_at, tz) === date), (tours ?? []).filter(t => t.active !== false), { tz });
  const avails = deps.map(d => d.availability_pk);
  const pick = async (table, cols) => {
    if (!avails.length) return [];
    try { const { data, error: e } = await crm.from(table).select(cols).in("availability_pk", avails); return e ? [] : (data ?? []); } catch { return []; }
  };
  const [assignments, logs, media] = await Promise.all([pick("ride_assignments", "*"), pick("ride_logs", "*"), pick("ride_media", "*")]);
  for (const d of deps) {
    d.assignees = resolveAssignees(d, assignments, staff);
    d.logs = logs.filter(l => String(l.availability_pk) === String(d.availability_pk));
    d.media = media.filter(m => String(m.availability_pk) === String(d.availability_pk) && !m.hidden);
  }
  return deps;
}

// What the page gets for one departure (never emails/phones of guests; staff phones only as "is it me").
export function publicDeparture(d, me) {
  const myLog = d.logs?.find(l => l.guide_phone === me.phone) ?? null;
  return {
    availability_pk: d.availability_pk, label: d.label, type: d.type, start_at: d.start_at, end_at: d.end_at,
    riders: d.riders, names: d.names, booking_pks: d.booking_pks, bookings: d.bookings ?? [],
    defaults: { miles: d.tour?.miles ?? null, high_point_ft: d.tour?.high_point_ft ?? null, stops: d.tour?.stops ?? [] },
    assignees: (d.assignees ?? []).map(a => ({ name: a.name, source: a.source, me: a.phone === me.phone, riders: a.booking_pks?.length ? a.booking_pks : null })),
    mine: (d.assignees ?? []).some(a => a.phone === me.phone),
    log: myLog ? { miles: myLog.miles, high_point_ft: myLog.high_point_ft, stops: myLog.stops ?? [], highlight: myLog.highlight, group_note: myLog.group_note,
      conditions: myLog.conditions ?? [], booking_pks: myLog.booking_pks ?? [], status: myLog.status } : null,
    photos: (d.media ?? []).filter(m => m.kind !== "video" && m.thumb_urls?.length).map(m => ({ id: m.id, thumb: m.thumb_urls[0], full: m.public_url, cover: !!m.cover, mine: m.uploaded_by === me.phone })),
    status: d.media?.length || myLog ? (myLog?.status === "done" ? "done" : "started") : "new",
  };
}

// ── API handlers: (deps, body/query) → { status, body } ─────────────────────
async function authed({ db1, now }, token) {
  const t = verifyGuideToken(token, { now });
  if (!t) return { error: { status: 401, body: { error: "This link has expired. Use the link in today's briefing text." } } };
  const me = await loadOperator(db1, t.phone);
  if (!me?.access) return { error: { status: 403, body: { error: "This phone isn't set up for the ride log." } } };
  return { me, date: t.date };
}

export async function handleGuideDay(deps, { t, d }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const today = a.date, date = d && (d === today || d === addDays(today, -1)) ? d : today;
  const all = await loadDay(deps.crm, deps.db1, { date });
  const list = visibleDepartures(all, { access: a.me.access, phone: a.me.phone }).map(x => publicDeparture(x, a.me));
  return { status: 200, body: { me: { name: a.me.display_name ?? a.me.label ?? null, access: a.me.access }, date, today, departures: list } };
}

async function findDeparture(deps, me, date, availabilityPk) {
  const all = await loadDay(deps.crm, deps.db1, { date });
  const dep = all.find(x => String(x.availability_pk) === String(availabilityPk));
  if (!dep) return { error: { status: 404, body: { error: "ride not found" } } };
  if (!visibleDepartures([dep], { access: me.access, phone: me.phone }).length) return { error: { status: 403, body: { error: "not your ride" } } };
  return { dep };
}

// "This is my ride" — optionally only some riders (split departure). Re-claiming updates the rider list.
export async function handleGuideClaim(deps, { t, availability_pk, booking_pks = null, release = false }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, a.date, availability_pk); if (f.error) return f.error;
  if (release) {
    await deps.crm.from("ride_assignments").delete().eq("availability_pk", String(availability_pk)).eq("operator_phone", a.me.phone);
    return { status: 200, body: { ok: true } };
  }
  const pks = Array.isArray(booking_pks) ? booking_pks.filter(p => f.dep.booking_pks.includes(p)) : [];
  const row = { client_id: "csr_rea", availability_pk: String(availability_pk), ride_date: f.dep.ride_date, operator_phone: a.me.phone,
    guide_name: a.me.display_name ?? a.me.label ?? null, booking_pks: pks.length === f.dep.booking_pks.length ? [] : pks, source: "claim", assigned_by: a.me.phone };
  const { error } = await deps.crm.from("ride_assignments").upsert(row, { onConflict: "availability_pk,operator_phone" });
  if (error) return { status: 500, body: { error: "could not save" } };
  return { status: 200, body: { ok: true } };
}

const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < max ? Math.round(n * 10) / 10 : null; };
const text = (v, max) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, max) : null; };

export async function handleGuideLog(deps, body) {
  const a = await authed(deps, body?.t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, a.date, body.availability_pk); if (f.error) return f.error;
  const mine = f.dep.assignees.find(x => x.phone === a.me.phone);
  const row = {
    client_id: "csr_rea", ride_date: f.dep.ride_date, availability_pk: String(f.dep.availability_pk), guide_phone: a.me.phone,
    guide_name: a.me.display_name ?? a.me.label ?? null, booking_pks: mine?.booking_pks ?? [],
    miles: num(body.miles, 500), high_point_ft: num(body.high_point_ft, 20000) ? Math.round(num(body.high_point_ft, 20000)) : null,
    stops: (Array.isArray(body.stops) ? body.stops : []).map(s => text(s, 60)).filter(Boolean).slice(0, 8),
    highlight: text(body.highlight, 140), group_note: text(body.group_note, 500),
    conditions: (Array.isArray(body.conditions) ? body.conditions : []).filter(c => CONDITIONS.includes(c)),
    status: body.done ? "done" : "open", updated_at: new Date().toISOString(),
  };
  const { error } = await deps.crm.from("ride_logs").upsert(row, { onConflict: "availability_pk,guide_phone" });
  if (error) return { status: 500, body: { error: "could not save" } };
  // Saving a log for a ride nobody claimed = claiming it (guides shouldn't need two taps)
  if (!mine && a.me.access !== "manager") await handleGuideClaim(deps, { t: body.t, availability_pk: body.availability_pk });
  return { status: 200, body: { ok: true } };
}

async function fetchBuf(url, fetchImpl) { try { const r = await fetchImpl(url); return r?.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; } }

// One photo (base64 JPEG/PNG from the phone, already shrunk there). → stored set + a ride_media row.
export async function handleGuidePhoto(deps, body, { process: proc = processRidePhoto, upload = uploadRidePhotos, fetchImpl = globalThis.fetch } = {}) {
  const a = await authed(deps, body?.t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, a.date, body.availability_pk); if (f.error) return f.error;
  if (!/^image\/(jpeg|png)$/i.test(String(body.content_type ?? ""))) return { status: 415, body: { error: "Photos must be JPEG or PNG" } };
  const buf = Buffer.from(String(body.data ?? ""), "base64");
  if (!buf.length || buf.length > PHOTO_SPEC.maxUploadBytes) return { status: 413, body: { error: "photo empty or too large" } };
  // idempotent retries: the phone sends a client id per photo
  const clientId = text(body.client_id, 64);
  if (clientId) {
    const { data: dup } = await deps.crm.from("ride_media").select("id").eq("availability_pk", String(f.dep.availability_pk)).eq("client_upload_id", clientId).limit(1).maybeSingle();
    if (dup) return { status: 200, body: { ok: true, id: dup.id, duplicate: true } };
  }
  const mapBuf = f.dep.type === "rea" && /^https:\/\//.test(String(f.dep.tour?.map_url ?? "")) ? await fetchBuf(f.dep.tour.map_url, fetchImpl) : null;
  let set;
  try { set = await proc(buf, { mapBuf }); } catch (e) { return { status: 422, body: { error: `not a usable image: ${e.message}` } }; }
  const urls = await upload(deps.crm, { date: f.dep.ride_date, bookingRef: `dep${f.dep.availability_pk}`, set });
  const mine = f.dep.assignees.find(x => x.phone === a.me.phone);
  const { count } = await deps.crm.from("ride_media").select("id", { count: "exact", head: true }).eq("availability_pk", String(f.dep.availability_pk)).eq("hidden", false);
  const row = {
    client_id: "csr_rea", ride_date: f.dep.ride_date, availability_pk: String(f.dep.availability_pk), booking_pks: mine?.booking_pks ?? [],
    label: f.dep.label, start_at: f.dep.start_at, guide: a.me.display_name ?? a.me.label ?? null, kind: "photo", mime_type: "image/jpeg",
    drive_file_id: null, public_url: urls.full, hero_url: urls.hero, thumb_urls: urls.thumbs, cover: !!body.cover || !count,
    uploaded_by: a.me.phone, client_upload_id: clientId, hidden: false, sort_order: (count ?? 0) + 1,
  };
  const { data, error } = await deps.crm.from("ride_media").insert(row).select("id").single();
  if (error) return { status: 500, body: { error: "could not save the photo" } };
  if (!mine && a.me.access !== "manager") await handleGuideClaim(deps, { t: body.t, availability_pk: body.availability_pk });
  return { status: 200, body: { ok: true, id: data.id, thumb: urls.thumbs[0] } };
}

// Star a cover, or remove (hide) a photo. Only the uploader or a manager.
export async function handleGuideMedia(deps, { t, id, action }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const { data: m } = await deps.crm.from("ride_media").select("*").eq("id", id).maybeSingle();
  if (!m) return { status: 404, body: { error: "photo not found" } };
  if (m.uploaded_by !== a.me.phone && a.me.access !== "manager") return { status: 403, body: { error: "not your photo" } };
  if (action === "remove") await deps.crm.from("ride_media").update({ hidden: true, cover: false }).eq("id", id);
  else if (action === "cover") {
    await deps.crm.from("ride_media").update({ cover: false }).eq("availability_pk", m.availability_pk);
    await deps.crm.from("ride_media").update({ cover: true }).eq("id", id);
  } else return { status: 400, body: { error: "unknown action" } };
  return { status: 200, body: { ok: true } };
}

// ── recap side (pure): the ride log + hosted photo for one booking ───────────
// logs: ride_logs rows of the departure. A log naming this booking wins, else a whole-departure log.
export function pickRideLogForBooking(logs, booking) {
  const pk = String(booking?.pk ?? ""), avail = booking?.availabilityPk != null ? String(booking.availabilityPk) : null;
  const rows = (logs ?? []).filter(l => String(l.availability_pk ?? "") === avail);
  return rows.find(l => (l.booking_pks ?? []).includes(pk)) ?? rows.find(l => !(l.booking_pks ?? []).length) ?? null;
}
export const rideLogToTrip = (log) => log ? {
  guide: log.guide_name || null, miles: log.miles ?? null, high_point_ft: log.high_point_ft ?? null,
  stops: Array.isArray(log.stops) && log.stops.length ? log.stops : null, highlight: log.highlight || null,
} : null;
export const hostedPhotoFromMedia = (m) => (m?.hero_url && m?.public_url && Array.isArray(m.thumb_urls) && m.thumb_urls.length
  ? { full: m.public_url, hero: m.hero_url, thumbs: m.thumb_urls.slice(0, 3) } : null);
