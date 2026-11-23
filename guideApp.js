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
import { processRidePhoto, uploadRidePhotos, PHOTO_SPEC, storagePublicUrl, MAP_BUCKET, tourSlug, RECAP_TEMPLATES } from "./recapSimple.js";
import { RECAP_FEATURES } from "./rideRecap.js";

export const GUIDE_TZ = "America/Denver";
export const MANAGER_ROLES = ["owner", "general_manager", "operations_manager", "manager"];
export const SHOP_ROLES = ["reservations", "sales"];
export const GUIDE_ROLES = ["guide", "staff"];
export const CONDITIONS = ["fresh_snow", "bluebird", "snowing", "windy", "cold"];

// The four locations (Sean, 2026-11-23). Same keys as operator_phones.locations.
export const LOCATIONS = Object.freeze([
  { key: "steamboat", label: "Steamboat" },        // CSR shop: rentals
  { key: "north_routt", label: "North Routt" },    // CSR guided backcountry
  { key: "kremmling", label: "Kremmling" },        // CSR rentals
  { key: "rabbit_ears", label: "Rabbit Ears" },    // the Ranch: REA tours
]);
export const STAFF_ROLES = ["guide", "shop", "driver", "mechanic", "manager"];
// Where a booking happens: REA tours at the Ranch, guided backcountry in North Routt, rentals by the shop in the item name.
export function departureLocation({ type, item }) {
  if (type === "rea") return "rabbit_ears";
  if (type === "backcountry") return "north_routt";
  return /kremmling/i.test(String(item ?? "")) ? "kremmling" : "steamboat";
}

// The views a person may pick on entering the app (their own level and below). A manager can work as a guide or shop.
export const VIEWS_FOR = { manager: ["manager", "guide", "shop"], shop: ["shop"], guide: ["guide"] };
export const viewFor = (access, wanted) => ((VIEWS_FOR[access] ?? []).includes(wanted) ? wanted : access);

// FareHarbor booking questions a guide needs on the ride (health, gear, pickup…); never promo codes, insurance, marketing.
const MANIFEST_FIELD_RE = /health|medical|allerg|rental equipment|boot|monosuit|helmet|size|height|weight|shuttle|pickup|delivery|address|rack|experience|skill|age|note/i;
const SKIP_FIELD_RE = /promo|insurance|hear about|newsletter|marketing/i;
export function manifestNotes(b) {
  const out = [];
  for (const f of b?.custom_field_values ?? []) {
    const label = String(f?.custom_field?.name ?? f?.name ?? "").trim();
    const raw = f?.display_value ?? f?.value ?? "";
    const value = String(typeof raw === "boolean" ? (raw ? "Yes" : "") : raw).trim();
    if (!label || !value || /^(no|none|n\/a|false|0)$/i.test(value) || SKIP_FIELD_RE.test(label) || !MANIFEST_FIELD_RE.test(label)) continue;
    out.push({ label: label.replace(/\s*\((new|optional)\)\s*/ig, " ").trim(), value: value.slice(0, 200), health: /health|medical|allerg/i.test(label) });
  }
  return out.slice(0, 8);
}

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
      start_at: f.startAt, end_at: f.endAt, riders: 0, names: [], booking_pks: [], bookings: [], tour, fh_guide: null, location: departureLocation({ type: tour.type, item: f.item }), ride_date: f.startAt ? localDate(f.startAt, tz) : null };
    d.riders += f.pax || 0;
    const first = cleanFirstName(f.name);
    if (first && !d.names.includes(first)) d.names.push(first);
    d.booking_pks.push(f.pk);
    const raw = row?.raw_payload?.booking ?? row?.raw_payload ?? {};
    // manifest line; full name / phone / notes are only sent to the page for the person's own rides (publicDeparture)
    d.bookings.push({ pk: f.pk, name: first || "Guest", full_name: String(f.name || "").trim() || first || "Guest", pax: f.pax || 0,
      phone: f.phone || null, item: f.item, notes: manifestNotes(raw) });
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

async function loadStaff(db1, clientId, crm = null) {
  const { data } = await db1.from("operator_phones").select("phone, role, label, display_name").eq("client_id", clientId);
  const ops = data ?? [];
  if (!crm) return ops;
  let staff = [];
  try { const r = await crm.from("staff").select("*").eq("client_id", clientId); staff = r.error ? [] : (r.data ?? []); } catch { staff = []; }
  return mergeStaff(staff, ops);
}

// One list: the app's staff table (name, role, home location, Google email) + anyone who only exists as an operator phone.
const OP_ROLE_TO_STAFF = { guide: "guide", staff: "guide", reservations: "shop", sales: "shop", mechanic: "mechanic", fleet: "mechanic",
  owner: "manager", general_manager: "manager", operations_manager: "manager", manager: "manager", marketing: "manager" };
export function mergeStaff(staffRows, opRows) {
  const out = (staffRows ?? []).filter(x => x.active !== false).map(x => ({ id: x.id, phone: x.phone ?? null, display_name: x.name, role: x.role,
    home_location: x.home_location ?? null, google_email: x.google_email ?? null, source: x.source ?? "app" }));
  for (const o of opRows ?? []) {
    if (!o.phone || out.some(x => x.phone === o.phone)) continue;
    out.push({ id: null, phone: o.phone, display_name: o.display_name ?? o.label ?? o.phone, role: OP_ROLE_TO_STAFF[o.role] ?? "guide", home_location: null, google_email: null, source: "briefing" });
  }
  return out.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
}

export async function loadDay(crm, db1, { date, clientId = "csr_rea", tz = GUIDE_TZ }) {
  const from = new Date(`${date}T00:00:00Z`); from.setUTCHours(from.getUTCHours() - 12);   // generous window, filtered by local date below
  const to = new Date(`${date}T00:00:00Z`); to.setUTCHours(to.getUTCHours() + 36);
  const [{ data: rows, error }, { data: tours }, staff] = await Promise.all([
    crm.from("bookings").select("fareharbor_pk, company, status, start_at, end_at, customer_count, product_title, updated_at, raw_payload")
      .like("fareharbor_pk", "#%").gte("start_at", from.toISOString()).lt("start_at", to.toISOString()),
    crm.from("recap_tours").select("*").eq("client_id", clientId),
    loadStaff(db1, clientId, crm),
  ]);
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const deps = groupDepartures((rows ?? []).filter(r => r.start_at && localDate(r.start_at, tz) === date), (tours ?? []).filter(t => t.active !== false), { tz });
  const avails = deps.map(d => d.availability_pk);
  const pick = async (table, cols) => {
    if (!avails.length) return [];
    try { const { data, error: e } = await crm.from(table).select(cols).in("availability_pk", avails); return e ? [] : (data ?? []); } catch { return []; }
  };
  const [assignments, logs, media] = await Promise.all([pick("ride_assignments", "*"), pick("ride_logs", "*"), pick("ride_media", "*")]);
  // waiver / check-in / balance due / equipment from the ops manifest (daily_manifest view), when the booking is linked
  const pks = deps.flatMap(d => d.booking_pks);
  let mf = [];
  if (pks.length) {
    try { const { data } = await crm.from("daily_manifest").select("fareharbor_pk, waiver_signed, checked_in, balance_due_cents, equipment, booking_notes").in("fareharbor_pk", pks); mf = data ?? []; } catch { mf = []; }
  }
  const byPk = new Map(mf.map(m => [m.fareharbor_pk, m]));
  for (const d of deps) for (const b of d.bookings) {
    const m = byPk.get(b.pk);
    if (!m) continue;
    b.waiver_signed = m.waiver_signed ?? null; b.checked_in = m.checked_in ?? null;
    b.due_cents = Number(m.balance_due_cents) > 0 ? Number(m.balance_due_cents) : 0;
    if (m.equipment) b.equipment = String(m.equipment).slice(0, 120);
    if (m.booking_notes) b.notes = [{ label: "Booking note", value: String(m.booking_notes).slice(0, 300), health: false }, ...b.notes].slice(0, 8);
  }
  for (const d of deps) {
    d.assignees = resolveAssignees(d, assignments, staff);
    d.logs = logs.filter(l => String(l.availability_pk) === String(d.availability_pk));
    d.media = media.filter(m => String(m.availability_pk) === String(d.availability_pk) && !m.hidden);
  }
  deps.staff = staff;
  return deps;
}

// What the page gets for one departure (never emails/phones of guests; staff phones only as "is it me").
export function publicDeparture(d, me, view = me.access) {
  const myLog = d.logs?.find(l => l.guide_phone === me.phone) ?? null;
  const mine = (d.assignees ?? []).some(a => a.phone === me.phone);
  // the full manifest (names, phones, notes, waiver, balance) only for rides you're on, rentals at the shop, or managers
  const details = me.access === "manager" || mine || (view === "shop" && d.type === "rental");
  const manifest = (d.bookings ?? []).map(b => details
    ? { pk: b.pk, name: b.full_name, pax: b.pax, phone: b.phone, item: d.type === "rental" ? b.item : null, notes: b.notes ?? [],
        waiver_signed: b.waiver_signed ?? null, checked_in: b.checked_in ?? null, due_cents: b.due_cents ?? 0, equipment: b.equipment ?? null }
    : { pk: b.pk, name: b.name, pax: b.pax });
  return {
    availability_pk: d.availability_pk, label: d.label, type: d.type, start_at: d.start_at, end_at: d.end_at, location: d.location ?? null,
    riders: d.riders, names: d.names, booking_pks: d.booking_pks, bookings: manifest, details,
    defaults: { miles: d.tour?.miles ?? null, high_point_ft: d.tour?.high_point_ft ?? null, stops: d.tour?.stops ?? [] },
    assignees: (d.assignees ?? []).map(a => ({ name: a.name, source: a.source, me: a.phone === me.phone, riders: a.booking_pks?.length ? a.booking_pks : null })),
    mine,
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

export async function handleGuideDay(deps, { t, d, as = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const today = a.date, date = d && (d === today || d === addDays(today, -1)) ? d : today;
  const all = await loadDay(deps.crm, deps.db1, { date });
  const view = viewFor(a.me.access, as);
  const list = visibleDepartures(all, { access: view, phone: a.me.phone }).map(x => publicDeparture(x, a.me, view));
  const meStaff = (all.staff ?? []).find(x => x.phone === a.me.phone);
  return { status: 200, body: {
    me: { name: meStaff?.display_name ?? a.me.display_name ?? a.me.label ?? null, access: a.me.access, views: VIEWS_FOR[a.me.access] ?? [], view, home_location: meStaff?.home_location ?? null },
    date, today, locations: LOCATIONS, departures: list,
    // managers assign people; everyone else only needs names (team view)
    staff: (all.staff ?? []).map(x => ({ name: x.display_name, role: x.role, home_location: x.home_location, ...(view === "manager" ? { phone: x.phone } : {}) })),
  } };
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

// A manager puts a staff member on a departure (or only some of its riders), or takes them off.
export async function handleGuideAssign(deps, { t, availability_pk, phone, booking_pks = null, remove = false }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  if (a.me.access !== "manager") return { status: 403, body: { error: "Managers only" } };
  const all = await loadDay(deps.crm, deps.db1, { date: a.date });
  const dep = all.find(x => String(x.availability_pk) === String(availability_pk));
  if (!dep) {
    const y = await loadDay(deps.crm, deps.db1, { date: addDays(a.date, 1) });         // managers also plan tomorrow
    const d2 = y.find(x => String(x.availability_pk) === String(availability_pk));
    if (!d2) return { status: 404, body: { error: "booking not found" } };
    return assignTo(deps, a, d2, y.staff, { phone, booking_pks, remove });
  }
  return assignTo(deps, a, dep, all.staff, { phone, booking_pks, remove });
}
async function assignTo(deps, a, dep, staff, { phone, booking_pks, remove }) {
  const person = (staff ?? []).find(x => x.phone === phone);
  if (!person) return { status: 400, body: { error: "pick someone from the staff list (with a phone number)" } };
  if (remove) {
    await deps.crm.from("ride_assignments").delete().eq("availability_pk", String(dep.availability_pk)).eq("operator_phone", phone);
    return { status: 200, body: { ok: true } };
  }
  const pks = Array.isArray(booking_pks) ? booking_pks.filter(p => dep.booking_pks.includes(p)) : [];
  const { error } = await deps.crm.from("ride_assignments").upsert({ client_id: "csr_rea", availability_pk: String(dep.availability_pk), ride_date: dep.ride_date,
    operator_phone: phone, guide_name: person.display_name, booking_pks: pks.length === dep.booking_pks.length ? [] : pks, source: "manager", assigned_by: a.me.phone },
    { onConflict: "availability_pk,operator_phone" });
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
  if (!mine && viewFor(a.me.access, body.as) !== "manager") await handleGuideClaim(deps, { t: body.t, availability_pk: body.availability_pk });
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
  if (!mine && viewFor(a.me.access, body.as) !== "manager") await handleGuideClaim(deps, { t: body.t, availability_pk: body.availability_pk });
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

// ── admin (managers): tour routes + recap settings ──────────────────────────
// A tour = all recap_tours rows with the same label (e.g. "Grand Tour" and 'Grand "Private" Tour' share one route).
export function groupTours(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    if (!r || r.type === "skip" || r.active === false) continue;
    const k = String(r.label || r.match);
    const g = by.get(k) ?? { label: k, type: r.type, ids: [], matches: [], miles: r.miles ?? null, high_point_ft: r.high_point_ft ?? null,
      stops: Array.isArray(r.stops) ? r.stops : [], route: r.route ?? null, map_url: r.map_url ?? null };
    g.ids.push(r.id); g.matches.push(r.match);
    if (!g.map_url && r.map_url) g.map_url = r.map_url;
    by.set(k, g);
  }
  const order = { rea: 0, backcountry: 1, rental: 2 };
  return [...by.values()].sort((a, b) => (order[a.type] - order[b.type]) || a.label.localeCompare(b.label));
}

async function requireManager(deps, t) {
  const a = await authed(deps, t); if (a.error) return a;
  if (a.me.access !== "manager") return { error: { status: 403, body: { error: "Managers only" } } };
  return a;
}

export async function handleGuideAdmin(deps, { t }) {
  const a = await requireManager(deps, t); if (a.error) return a.error;
  const [{ data: tours }, { data: st }] = await Promise.all([
    deps.crm.from("recap_tours").select("*").eq("client_id", "csr_rea"),
    deps.crm.from("recap_settings").select("*").eq("client_id", "csr_rea").maybeSingle(),
  ]);
  const staff = await loadStaff(deps.db1, "csr_rea", deps.crm);
  return { status: 200, body: {
    tours: groupTours(tours), staff, locations: LOCATIONS, roles: STAFF_ROLES,
    settings: st ? { send_hour: st.send_hour, template: st.template ?? "v1", features: st.features ?? [], dry_run: st.dry_run !== false, test_to: st.test_to,
      friend_code: st.friend_code, all_features: RECAP_FEATURES, templates: RECAP_TEMPLATES } : null,
  } };
}

// Route + stats for one tour (every row with that label). stops: [{ name, elevation_ft }].
export async function handleGuideAdminTour(deps, body) {
  const a = await requireManager(deps, body?.t); if (a.error) return a.error;
  const label = text(body.label, 80);
  if (!label) return { status: 400, body: { error: "label required" } };
  const stops = (Array.isArray(body.stops) ? body.stops : []).map(x => ({ name: text(x?.name, 60), elevation_ft: num(x?.elevation_ft, 20000) ? Math.round(num(x.elevation_ft, 20000)) : null }))
    .filter(x => x.name).slice(0, 12);
  const patch = {
    miles: num(body.miles, 500), high_point_ft: num(body.high_point_ft, 20000) ? Math.round(num(body.high_point_ft, 20000)) : null,
    stops: stops.map(x => x.name),
    route: { stops, duration_hours: num(body.duration_hours, 24), description: text(body.description, 400), updated_by: a.me.display_name ?? a.me.phone, updated_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  };
  let { data, error } = await deps.crm.from("recap_tours").update(patch).eq("client_id", "csr_rea").eq("label", label).select("id");
  if (error && /route/.test(error.message)) {                         // db2_ride_logs.sql not applied yet → save the basics
    const { route: _r, ...basic } = patch;
    ({ data, error } = await deps.crm.from("recap_tours").update(basic).eq("client_id", "csr_rea").eq("label", label).select("id"));
  }
  if (error) return { status: 500, body: { error: "could not save" } };
  if (!data?.length) return { status: 404, body: { error: "tour not found" } };
  return { status: 200, body: { ok: true, rows: data.length } };
}

// Route map image (PNG/JPEG) → 1080px wide PNG in recap-maps/<tour-slug>.png → map_url on every row with that label.
export async function handleGuideAdminMap(deps, body, { sharpImpl = null, storageBase = undefined } = {}) {
  const a = await requireManager(deps, body?.t); if (a.error) return a.error;
  const label = text(body.label, 80);
  if (!label) return { status: 400, body: { error: "label required" } };
  if (!/^image\/(png|jpeg)$/i.test(String(body.content_type ?? ""))) return { status: 415, body: { error: "PNG or JPEG only (export an SVG to PNG first)" } };
  const buf = Buffer.from(String(body.data ?? ""), "base64");
  if (!buf.length || buf.length > 15 * 1024 * 1024) return { status: 413, body: { error: "image empty or too large" } };
  let png;
  try {
    const sharp = sharpImpl ?? (await import("sharp")).default;
    png = await sharp(buf).rotate().resize({ width: 1080, withoutEnlargement: false }).png({ compressionLevel: 9 }).toBuffer();
  } catch (e) { return { status: 422, body: { error: `not a usable image: ${e.message}` } }; }
  const path = `${tourSlug(label)}.png`;
  const { error: upErr } = await deps.crm.storage.from(MAP_BUCKET).upload(path, png, { contentType: "image/png", upsert: true, cacheControl: "300" });
  if (upErr) return { status: 500, body: { error: `map upload failed: ${upErr.message}` } };
  const url = `${storagePublicUrl(MAP_BUCKET, path, storageBase)}?v=${Date.now()}`;   // new URL each upload so email clients don't show a cached old map
  const { data, error } = await deps.crm.from("recap_tours").update({ map_url: url, updated_at: new Date().toISOString() }).eq("client_id", "csr_rea").eq("label", label).select("id");
  if (error || !data?.length) return { status: error ? 500 : 404, body: { error: error ? "could not save" : "tour not found" } };
  return { status: 200, body: { ok: true, map_url: url } };
}

// Add or edit a staff member (Settings → Staff). Phone = how they get the briefing link and how assignments find them.
const e164 = (v) => { const d = String(v ?? "").replace(/[^\d+]/g, ""); if (/^\+\d{10,15}$/.test(d)) return d; const n = d.replace(/\D/g, ""); return n.length === 10 ? `+1${n}` : n.length === 11 && n.startsWith("1") ? `+${n}` : null; };
export async function handleGuideAdminStaff(deps, body) {
  const a = await requireManager(deps, body?.t); if (a.error) return a.error;
  const name = text(body.name, 80);
  if (!name) return { status: 400, body: { error: "name required" } };
  if (!STAFF_ROLES.includes(body.role)) return { status: 400, body: { error: "pick a role" } };
  if (body.home_location && !LOCATIONS.some(l => l.key === body.home_location)) return { status: 400, body: { error: "unknown location" } };
  const phone = body.phone ? e164(body.phone) : null;
  if (body.phone && !phone) return { status: 400, body: { error: "phone number looks wrong" } };
  const email = body.google_email ? String(body.google_email).trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: "Google email looks wrong" } };
  const row = { client_id: "csr_rea", name, role: body.role, home_location: body.home_location || null, phone, google_email: email,
    active: body.active !== false, source: "app", updated_at: new Date().toISOString() };
  const q = body.id ? deps.crm.from("staff").update(row).eq("id", body.id).select("id") : deps.crm.from("staff").insert(row).select("id");
  const { data, error } = await q;
  if (error) return { status: /duplicate|unique/i.test(error.message) ? 409 : 500, body: { error: /duplicate|unique/i.test(error.message) ? "someone already has that phone number" : "could not save" } };
  return { status: 200, body: { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id } };
}

// Recap settings a manager may change from the app. dry_run is deliberately NOT here (Sean only).
export async function handleGuideAdminSettings(deps, body) {
  const a = await requireManager(deps, body?.t); if (a.error) return a.error;
  const patch = { updated_at: new Date().toISOString() };
  if (body.send_hour !== undefined) { const h = Number(body.send_hour); if (!Number.isInteger(h) || h < 0 || h > 23) return { status: 400, body: { error: "send hour 0-23" } }; patch.send_hour = h; }
  if (body.template !== undefined) { if (!RECAP_TEMPLATES.includes(body.template)) return { status: 400, body: { error: "unknown template" } }; patch.template = body.template; }
  if (body.features !== undefined) patch.features = (Array.isArray(body.features) ? body.features : []).filter(f => RECAP_FEATURES.includes(f));
  const { error } = await deps.crm.from("recap_settings").update(patch).eq("client_id", "csr_rea");
  if (error) return { status: 500, body: { error: "could not save" } };
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
