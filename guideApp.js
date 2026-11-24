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

// Where a booking came from (managers only): FareHarbor partner (+ agent), the website link it came through, in store, or direct.
const PARTNER_NAMES = [[/viator|tripadvisor/i, "Viator / TripAdvisor"], [/moving mountains/i, "Moving Mountains"], [/four seasons/i, "Four Seasons"],
  [/polaris/i, "Polaris Adventures"], [/expedia/i, "Expedia"], [/getyourguide/i, "GetYourGuide"]];
export function bookingSource(b) {
  const aff = String(b?.affiliate_company?.name ?? "").trim(), agent = String(b?.agent?.name ?? "").trim();
  if (aff) {
    const name = (PARTNER_NAMES.find(([re]) => re.test(aff)) ?? [null, aff.replace(/\s+-\s+.*$/, "")])[1];
    return { kind: "partner", label: name, agent: agent || null };
  }
  const ref = String(b?.online_booking_references ?? "").trim();
  if (ref) return { kind: "website", label: "Website", ref: ref.replace(/^https?:\/\//, "").slice(0, 40), agent: null };
  if ((b?.payments ?? []).some(p => p?.type === "in-store")) return { kind: "in_store", label: "In store", agent: null };
  return { kind: "direct", label: "Direct", agent: null };
}
export const sourceKey = (src) => (src.kind === "partner" ? src.label : src.label);
// Shuttle from lodging (REA/guided): seats + pickup address. Rentals: "Pickup Evening Prior".
export function shuttleInfo(b, pax = 0) {
  let seats = 0, address = null, eveningPickup = false;
  for (const f of b?.custom_field_values ?? []) {
    const label = String(f?.custom_field?.name ?? f?.name ?? ""), raw = f?.display_value ?? f?.value ?? "";
    const v = String(typeof raw === "boolean" ? (raw ? "Yes" : "") : raw).trim();
    if (!v || /^(no|none|n\/a|false|0)$/i.test(v)) continue;
    if (/shuttle/i.test(label)) seats = Number.parseInt(v, 10) > 0 ? Number.parseInt(v, 10) : (pax || 1);
    else if (/address/i.test(label)) address = v.slice(0, 160);
    else if (/pickup evening prior/i.test(label)) eveningPickup = true;
  }
  return seats ? { seats, address, evening_pickup: eveningPickup } : (eveningPickup ? { seats: 0, address, evening_pickup: true } : null);
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
    const total = Number(raw.receipt_total) || 0, paid = Number(raw.amount_paid) || 0;
    d.bookings.push({ pk: f.pk, name: first || "Guest", full_name: String(f.name || "").trim() || first || "Guest", pax: f.pax || 0,
      phone: f.phone || null, item: f.item, notes: manifestNotes(raw),
      total_cents: total, paid_cents: paid, due_cents: Math.max(0, total - paid), source: bookingSource(raw), booked_at: raw.created_at ?? null,
      shuttle: shuttleInfo(raw, f.pax || 0) });
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

// ── speed (Sean, 2026-11-24: "slow to load things and navigate between screens") ──
// Short-lived cache per database client for things that rarely change (staff list, tours, shuttle settings, unit names,
// a day's FareHarbor bookings). Concurrent callers share one in-flight read. Every write in this app that changes one of
// them calls bust(); FareHarbor bookings simply refresh within 30 s.
const CACHES = new WeakMap();
const TTL = { staff: 60_000, tours: 60_000, shuttle: 60_000, units: 60_000, bookings: 30_000, season: 120_000 };
function memo(db, key, ttl, fn) {
  if (!db || typeof db !== "object") return fn();
  let m = CACHES.get(db); if (!m) CACHES.set(db, m = new Map());
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = Promise.resolve().then(fn);
  m.set(key, { at: Date.now(), p });
  p.catch(() => { if (m.get(key)?.p === p) m.delete(key); });
  return p;
}
// A save that may change what's cached (staff, tours, shuttle settings, unit names, the season's assignments): clear the
// short-lived caches so the next read is fresh. Day bookings come from FareHarbor and aren't changed here.
function written(deps, body) {
  for (const k of ["staff:", "tours:", "shuttle:", "units", "season:"]) bust(deps?.crm, k);
  return { status: 200, body };
}
export function bust(db, prefix = "") {
  const m = db && CACHES.get(db); if (!m) return;
  for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
}

async function loadStaff(db1, clientId, crm = null) {
  if (!crm) { const { data } = await db1.from("operator_phones").select("phone, role, label, display_name").eq("client_id", clientId); return data ?? []; }
  return memo(crm, `staff:${clientId}`, TTL.staff, async () => {
    const [opsRes, staff] = await Promise.all([
      db1.from("operator_phones").select("phone, role, label, display_name").eq("client_id", clientId),
      (async () => { try { const r = await crm.from("staff").select("*").eq("client_id", clientId); return r.error ? [] : (r.data ?? []); } catch { return []; } })(),
    ]);
    return mergeStaff(staff, opsRes?.data ?? []);
  });
}
const loadTours = (crm, clientId) => memo(crm, `tours:${clientId}`, TTL.tours, async () => (await crm.from("recap_tours").select("*").eq("client_id", clientId)).data ?? []);

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
  // round A: everything that doesn't depend on the bookings, in parallel
  const [{ data: rows, error }, tours, staff, runs, shuttle] = await Promise.all([
    memo(crm, `bookings:${clientId}:${date}`, TTL.bookings, () => crm.from("bookings").select("fareharbor_pk, company, status, start_at, end_at, customer_count, product_title, updated_at, raw_payload")
      .like("fareharbor_pk", "#%").gte("start_at", from.toISOString()).lt("start_at", to.toISOString()).then(r => { if (r.error) throw new Error(`bookings read failed: ${r.error.message}`); return r; })),
    loadTours(crm, clientId),
    loadStaff(db1, clientId, crm),
    (async () => { try { const { data, error: e } = await crm.from("shuttle_runs").select("*").eq("client_id", clientId).eq("run_date", date); return e ? [] : (data ?? []); } catch { return []; } })(),
    loadShuttleSettings(crm, clientId),
  ]);
  if (error) throw new Error(`bookings read failed: ${error.message}`);
  const deps = groupDepartures((rows ?? []).filter(r => r.start_at && localDate(r.start_at, tz) === date), (tours ?? []).filter(t => t.active !== false), { tz });
  const avails = deps.map(d => d.availability_pk);
  const pick = async (table, cols) => {
    if (!avails.length) return [];
    try { const { data, error: e } = await crm.from(table).select(cols).in("availability_pk", avails); return e ? [] : (data ?? []); } catch { return []; }
  };
  const pks = deps.flatMap(d => d.booking_pks);
  const byPks = async (table) => {
    if (!pks.length) return [];
    try { const { data, error: e } = await crm.from(table).select("*").in("booking_pk", pks); return e ? [] : (data ?? []); } catch { return []; }
  };
  // round B: every read keyed by this day's departures / bookings, in parallel
  // (waiver / check-in / balance due / equipment come from the ops manifest, the daily_manifest view, when the booking is linked)
  const [assignments, logs, media, mf, equip, snotes] = await Promise.all([pick("ride_assignments", "*"), pick("ride_logs", "*"), pick("ride_media", "*"),
    (async () => { if (!pks.length) return []; try { const { data } = await crm.from("daily_manifest").select("fareharbor_pk, waiver_signed, checked_in, balance_due_cents, equipment, booking_notes").in("fareharbor_pk", pks); return data ?? []; } catch { return []; } })(),
    byPks("booking_equipment"), byPks("booking_staff_notes")]);
  const byPk = new Map(mf.map(m => [m.fareharbor_pk, m]));
  for (const d of deps) for (const b of d.bookings) {
    const m = byPk.get(b.pk);
    if (!m) continue;
    b.waiver_signed = m.waiver_signed ?? null; b.checked_in = m.checked_in ?? null;
    if (m.balance_due_cents != null) b.due_cents = Math.max(0, Number(m.balance_due_cents) || 0);
    if (m.equipment) b.equipment = String(m.equipment).slice(0, 120);
    if (m.booking_notes) b.notes = [{ label: "Booking note", value: String(m.booking_notes).slice(0, 300), health: false }, ...b.notes].slice(0, 8);
  }
  // sled / trailer per booking, staff notes, van runs (db2_guide_ops.sql; each read degrades to empty if missing)
  for (const d of deps) for (const b of d.bookings) {
    b.units = equip.filter(x => x.booking_pk === b.pk).map(x => ({ id: x.id, kind: x.kind, unit: x.unit, note: x.note ?? null, source: x.source }))
      .sort((x, y) => x.kind.localeCompare(y.kind) || x.unit.localeCompare(y.unit, undefined, { numeric: true }));
    b.staff_notes = snotes.filter(x => x.booking_pk === b.pk && !x.hidden).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))
      .map(x => ({ id: x.id, note: x.note, by: x.author_name ?? null, by_phone: x.author_phone ?? null, at: x.created_at }));
    const brief = (r) => (r ? { id: r.id, kind: r.kind, vehicle: r.vehicle ?? null, depart_at: r.depart_at ?? null, driver: r.driver_name ?? null } : null);
    const on = runs.filter(x => (x.booking_pks ?? []).includes(b.pk));
    b.run = brief(on.find(x => x.kind !== "from_trail") ?? null);
    b.return_run = brief(on.find(x => x.kind === "from_trail") ?? null);
  }
  deps.runs = runs;
  deps.shuttle = shuttle;
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
  const money = view === "manager" && me.access === "manager";            // prices + source: managers only (Sean, 2026-11-23)
  const guidesFor = (pk) => (d.assignees ?? []).filter(a => !a.booking_pks?.length || a.booking_pks.includes(pk)).map(a => ({ name: a.name, me: a.phone === me.phone }));
  const manifest = (d.bookings ?? []).map(b => details
    ? { pk: b.pk, name: b.full_name, pax: b.pax, phone: b.phone, item: d.type === "rental" ? b.item : null, notes: b.notes ?? [],
        waiver_signed: b.waiver_signed ?? null, checked_in: b.checked_in ?? null, due_cents: b.due_cents ?? 0, equipment: b.equipment ?? null,
        shuttle: b.shuttle ?? null, guides: guidesFor(b.pk), units: b.units ?? [], run: b.run ?? null, return_run: b.return_run ?? null,
        staff_notes: (b.staff_notes ?? []).map(n => ({ id: n.id, note: n.note, by: n.by, at: n.at, mine: n.by_phone === me.phone })),
        ...(money ? { total_cents: b.total_cents ?? 0, paid_cents: b.paid_cents ?? 0, source: b.source ?? null, booked_at: b.booked_at ?? null } : {}) }
    : { pk: b.pk, name: b.name, pax: b.pax });
  const sum = (k) => (d.bookings ?? []).reduce((n, b) => n + (Number(b[k]) || 0), 0);
  return {
    availability_pk: d.availability_pk, label: d.label, type: d.type, start_at: d.start_at, end_at: d.end_at, location: d.location ?? null,
    riders: d.riders, names: d.names, booking_pks: d.booking_pks, bookings: manifest, details,
    shuttle_seats: (d.bookings ?? []).reduce((n, b) => n + (b.shuttle?.seats || 0), 0),
    ...(money ? { total_cents: sum("total_cents"), paid_cents: sum("paid_cents"), due_cents: sum("due_cents") } : {}),
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
// Open team access (Sean, 2026-11-23, until Google sign-in): one shared team code (GUIDE_TEAM_CODE on the web service),
// then the person picks their name from the staff list. The page sends t = "team:<code>:<staff phone>".
const teamCode = () => (process.env.GUIDE_TEAM_CODE || "").trim() || null;
export function teamCodeOk(code, want = teamCode()) {
  if (!want || typeof code !== "string" || code.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(code), Buffer.from(want));
}
// GET /guide/api/team?code= → the names to pick from (only with the right code)
export async function handleGuideTeam(deps, { code }) {
  if (!teamCodeOk(String(code ?? "").trim())) return { status: 401, body: { error: "That team code isn't right." } };
  const staff = await loadStaff(deps.db1, "csr_rea", deps.crm);
  return { status: 200, body: { people: staff.filter(x => x.phone).map(x => ({ name: x.display_name, phone: x.phone, role: x.role, home_location: x.home_location })) } };
}

async function authed({ db1, crm, now }, token) {
  if (typeof token === "string" && token.startsWith("team:")) {
    const [, code, phone] = token.split(":");
    if (!teamCodeOk(code)) return { error: { status: 401, body: { error: "That team code isn't right. Ask a manager for the current one." } } };
    const person = (await loadStaff(db1, "csr_rea", crm)).find(x => x.phone === phone);
    if (!person) return { error: { status: 403, body: { error: "Pick your name from the list (or ask a manager to add you in Settings, Staff)." } } };
    // fully open for now (Sean): anyone with the code may choose any role; Google sign-in will tie roles to people
    return { me: { phone: person.phone, display_name: person.display_name, label: null, role: person.role, access: "manager" }, date: localDate(now ?? new Date(), GUIDE_TZ) };
  }
  const t = verifyGuideToken(token, { now });
  if (!t) return { error: { status: 401, body: { error: "This link has expired. Use the link in today's briefing text." } } };
  const me = await loadOperator(db1, t.phone);
  if (!me?.access) return { error: { status: 403, body: { error: "This phone isn't set up for the ride log." } } };
  return { me, date: t.date };
}

// Which day may be opened: managers any day within ~a season either side; everyone else yesterday to 60 days ahead.
export function allowedDate(d, today, access) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) return today;
  const [lo, hi] = access === "manager" ? [addDays(today, -400), addDays(today, 400)] : [addDays(today, -1), addDays(today, 60)];
  return d >= lo && d <= hi ? d : today;
}

// The ski season a date belongs to: Nov 1 → Apr 30. From July on it's the coming season (2026-11-23 → 2026/27).
export function seasonRange(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const start = m >= 7 ? y : y - 1;
  return { from: `${start}-11-01`, to: `${start + 1}-04-30`, label: `${start}/${String(start + 1).slice(2)}` };
}

// FareHarbor booking rows with start_at in [fromIso, toIso), paged past PostgREST's 1,000-row cap.
const BOOKING_COLS = "fareharbor_pk, company, status, start_at, end_at, customer_count, product_title, updated_at, raw_payload";
async function loadBookingRows(crm, fromIso, toIso, { max = 6000 } = {}) {
  const out = [];
  for (let off = 0; off < max; off += 1000) {
    const { data, error } = await crm.from("bookings").select(BOOKING_COLS).like("fareharbor_pk", "#%")
      .gte("start_at", fromIso).lt("start_at", toIso).order("start_at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`bookings read failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const dayStartIso = (date, tz = GUIDE_TZ) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCHours(x.getUTCHours() - 12); return x.toISOString(); };

// Group many days of booking rows into { date: departures[] } with assignees resolved (one assignments read).
async function loadDays(crm, db1, { from, to, clientId = "csr_rea", tz = GUIDE_TZ, staff = null }) {
  const end = new Date(`${addDays(to, 1)}T00:00:00Z`); end.setUTCHours(end.getUTCHours() + 12);
  const [rows, tours, st] = await Promise.all([
    loadBookingRows(crm, dayStartIso(from, tz), end.toISOString()),
    loadTours(crm, clientId),
    staff ? Promise.resolve(staff) : loadStaff(db1, clientId, crm),
  ]);
  const byDate = new Map();
  for (const r of rows) {
    if (!r.start_at) continue;
    const ld = localDate(r.start_at, tz);
    if (ld < from || ld > to) continue;
    (byDate.get(ld) ?? byDate.set(ld, []).get(ld)).push(r);
  }
  const activeTours = (tours ?? []).filter(t => t.active !== false);
  const days = new Map();
  for (const [ld, list] of byDate) { const g = groupDepartures(list, activeTours, { tz }); if (g.length) days.set(ld, g); }
  let assignments = [];
  if (days.size) {
    try {
      const { data, error } = await crm.from("ride_assignments").select("*").eq("client_id", clientId).gte("ride_date", from).lte("ride_date", to);
      assignments = error ? [] : (data ?? []);
    } catch { assignments = []; }
  }
  for (const g of days.values()) for (const d of g) d.assignees = resolveAssignees(d, assignments, st);
  return { days, staff: st };
}

// One line per day for the Season screen / the "next booking" shortcut. deps = visible departures of that day.
export function summarizeDay(date, deps, phone) {
  const by_location = {};
  for (const d of deps) if (d.location) by_location[d.location] = (by_location[d.location] ?? 0) + (d.riders || 0);
  const first = deps[0];
  return { date, departures: deps.length, bookings: deps.reduce((n, d) => n + (d.booking_pks?.length ?? 0), 0),
    riders: deps.reduce((n, d) => n + (d.riders || 0), 0), by_location,
    first: first ? { start_at: first.start_at, label: first.label } : null,
    mine: deps.filter(d => d.assignees?.some(a => a.phone === phone)).length };
}

// The next day after `date` with something this person can see (looks ahead up to `days`).
// The season (Nov 1 – Apr 30) as { days: Map(date → departures) }, cached 2 min per database (shared by the Season
// screen and the "next booking" card). deps.cache === false (tests) always reads fresh.
function seasonDays(deps, range) {
  const load = () => loadDays(deps.crm, deps.db1, { from: range.from, to: range.to });
  return deps.cache === false ? load() : memo(deps.crm, `season:${range.from}`, TTL.season, load);
}
export async function findNextDay(deps, { date, access, phone, days = 120 }) {
  const from = addDays(date, 1), to = addDays(date, days);
  const range = seasonRange(date);
  // inside the season: answer from the (cached) season instead of reading 120 days of bookings again
  const inSeason = from >= range.from && to <= range.to;
  let map;
  if (inSeason || (from >= range.from && from <= range.to)) {
    map = new Map([...(await seasonDays(deps, range)).days].filter(([ld]) => ld >= from && ld <= to));
    if (!map.size && !inSeason) map = (await loadDays(deps.crm, deps.db1, { from, to })).days;
  } else map = (await loadDays(deps.crm, deps.db1, { from, to })).days;
  for (const ld of [...map.keys()].sort()) {
    const vis = visibleDepartures(map.get(ld), { access, phone });
    if (vis.length) return summarizeDay(ld, vis, phone);
  }
  return null;
}

// Managers' season report: money + riders by month / location / tour / source, staff workload, unassigned. Pure.
export function seasonReport(daysMap, today) {
  const blank = () => ({ bookings: 0, riders: 0, total_cents: 0, paid_cents: 0, due_cents: 0 });
  const add = (o, b) => { o.bookings++; o.riders += b.pax || 0; o.total_cents += b.total_cents || 0; o.paid_cents += b.paid_cents || 0; o.due_cents += b.due_cents || 0; return o; };
  const bucket = (m, k, extra = {}) => m.get(k) ?? m.set(k, { key: k, ...extra, ...blank() }).get(k);
  const r = { past: blank(), upcoming: blank(), all: blank() };
  const month = new Map(), loc = new Map(), tour = new Map(), src = new Map(), staff = new Map(), unassigned = { bookings: 0, riders: 0, upcoming_bookings: 0 };
  for (const [date, deps] of daysMap) for (const d of deps) {
    const when = date < today ? "past" : "upcoming";
    for (const b of d.bookings) {
      add(r.all, b); add(r[when], b);
      add(bucket(month, date.slice(0, 7)), b); add(bucket(loc, d.location ?? "other"), b); add(bucket(tour, d.label), b);
      const s = b.source ?? { label: "Direct" };
      const sb = add(bucket(src, s.label, { agents: {} }), b);
      if (s.agent) sb.agents[s.agent] = (sb.agents[s.agent] ?? 0) + 1;
      const who = (d.assignees ?? []).filter(x => !x.booking_pks?.length || x.booking_pks.includes(b.pk));
      if (!who.length) { unassigned.bookings++; unassigned.riders += b.pax || 0; if (when === "upcoming") unassigned.upcoming_bookings++; }
      for (const w of who) {
        const st = bucket(staff, w.name ?? w.phone, { deps: new Set() });
        st.bookings++; st.riders += b.pax || 0; st.deps.add(d.availability_pk);
      }
    }
  }
  const list = (m) => [...m.values()].sort((x, y) => y.total_cents - x.total_cents || y.bookings - x.bookings);
  return { ...r, by_month: [...month.values()].sort((x, y) => x.key.localeCompare(y.key)), by_location: list(loc), by_tour: list(tour), by_source: list(src),
    staff: [...staff.values()].map(x => ({ name: x.key, rides: x.deps.size, bookings: x.bookings, riders: x.riders })).sort((x, y) => y.riders - x.riders), unassigned };
}

// GET /guide/api/season — every day of the season with bookings. Managers: the whole season, past + future.
// Guides / shop: from today on, only what they can see. Cached briefly (a season read is ~1–2k rows).
export async function handleGuideSeason(deps, { t, as = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const view = viewFor(a.me.access, as);
  const today = a.date, range = seasonRange(today);
  const hit = { data: await seasonDays(deps, range) };
  const out = [];
  for (const ld of [...hit.data.days.keys()].sort()) {
    if (view !== "manager" && ld < today) continue;
    const vis = visibleDepartures(hit.data.days.get(ld), { access: view, phone: a.me.phone });
    if (vis.length) out.push(summarizeDay(ld, vis, a.me.phone));
  }
  const totals = out.reduce((s, x) => ({ days: s.days + 1, bookings: s.bookings + x.bookings, riders: s.riders + x.riders }), { days: 0, bookings: 0, riders: 0 });
  const money = view === "manager" && a.me.access === "manager";
  if (money) for (const x of out) {
    const ds = hit.data.days.get(x.date) ?? [];
    x.total_cents = ds.reduce((n, d) => n + d.bookings.reduce((m, b) => m + (b.total_cents || 0), 0), 0);
    x.due_cents = ds.reduce((n, d) => n + d.bookings.reduce((m, b) => m + (b.due_cents || 0), 0), 0);
  }
  return { status: 200, body: { season: range, today, view, locations: LOCATIONS, days: out, totals,
    ...(money ? { report: seasonReport(hit.data.days, today) } : {}),
    next: out.find(x => x.date > today) ?? null, next_mine: out.find(x => x.date > today && x.mine) ?? null } };
}

// ── van runs, sleds/trailers, staff notes (db2_guide_ops.sql) ──
export const VAN_SEATS = 25;
export const RUN_KINDS = ["to_trail", "from_trail", "between_locations", "evening_pickup"];
// A run as the page sees it: stops in order with the rider's first name, seats, pickup address (drivers need it).
export function publicRun(r, deps) {
  const byPk = new Map(); for (const d of deps ?? []) for (const b of d.bookings) byPk.set(b.pk, { b, d });
  const loc = r.location ?? (r.booking_pks ?? []).map(pk => byPk.get(pk)?.d.location).find(Boolean) ?? null;
  const st = deps?.shuttle?.by?.[loc] ?? null, spot = st?.meeting_spots?.[0] ?? null;
  // pickup spot: the guest's lodging when the booking has one, else the location's meeting spot (Sean, 2026-11-23)
  const stopFor = (pk) => { const x = byPk.get(pk); return x ? { booking_pk: pk, name: x.b.full_name, phone: x.b.phone ?? null, seats: x.b.shuttle?.seats || x.b.pax || 0,
    address: x.b.shuttle?.address ?? spot, meeting_spot: !x.b.shuttle?.address && !!spot, ride: `${x.d.label}`, ride_at: x.d.start_at }
    : { booking_pk: pk, name: "(booking moved or cancelled)", seats: 0, address: null }; };
  const order = (r.stops ?? []).map(s => s.booking_pk).filter(pk => (r.booking_pks ?? []).includes(pk));
  const pks = [...order, ...(r.booking_pks ?? []).filter(pk => !order.includes(pk))];
  const stops = pks.map(stopFor);
  return { id: r.id, kind: r.kind, location: loc, start_point: st?.start_point ?? null, vehicle: r.vehicle ?? null, depart_at: r.depart_at ?? null, seats: r.seats ?? VAN_SEATS, driver_name: r.driver_name ?? null,
    driver_phone: r.driver_phone ?? null, notes: r.notes ?? null, booking_pks: pks, stops, used: stops.reduce((n, x) => n + (x.seats || 0), 0) };
}
// Suggest van runs for shuttle requests not on a run yet: by departure time, filling 25-seat vans (a party is never split).
// Vans never mix locations (Sean, 2026-11-23): one run per location + ride start time. settings = shuttleSettings by location.
export function suggestRuns(deps, runs, { seats: defSeats = VAN_SEATS, settings = {}, date = null } = {}) {
  const taken = new Set((runs ?? []).flatMap(r => r.booking_pks ?? []));
  const groups = new Map();
  for (const d of deps ?? []) for (const b of d.bookings) {
    if (!b.shuttle?.seats || taken.has(b.pk)) continue;
    const key = `${d.location ?? ""}|${d.start_at}`;
    (groups.get(key) ?? groups.set(key, { location: d.location ?? null, start_at: d.start_at, end_at: d.end_at ?? null, items: [] }).get(key)).items.push({ b, d });
  }
  const out = [];
  for (const g of [...groups.values()].sort((x, y) => String(x.start_at).localeCompare(String(y.start_at)) || String(x.location).localeCompare(String(y.location)))) {
    const st = settings[g.location] ?? null, seats = st?.seats ?? defSeats;
    const depart = pickupTimeFor(g.start_at, st, date ?? (g.start_at ? localDate(g.start_at, GUIDE_TZ) : null));
    const ret = g.end_at && st?.return_after_minutes ? new Date(Date.parse(g.end_at) + st.return_after_minutes * 60000).toISOString() : g.end_at;
    let cur = null;
    for (const { b, d } of g.items.sort((x, y) => y.b.shuttle.seats - x.b.shuttle.seats)) {
      const n = b.shuttle.seats;
      if (!cur || cur.used + n > seats) { cur = { kind: "to_trail", location: g.location, depart_at: depart, seats, booking_pks: [], availability_pks: [], used: 0, ride_at: g.start_at, ride_end: ret }; out.push(cur); }
      cur.booking_pks.push(b.pk); cur.used += n;
      if (!cur.availability_pks.includes(String(d.availability_pk))) cur.availability_pks.push(String(d.availability_pk));
    }
  }
  return out;
}
// Sean (2026-11-23): every run to the trailhead gets a matching return run, leaving when the ride ends.
export function returnRunFor(r) {
  return { kind: "from_trail", location: r.location ?? null, depart_at: r.ride_end ?? null, seats: r.seats, booking_pks: [...r.booking_pks], availability_pks: [...r.availability_pks], used: r.used };
}
// ── shuttle settings per location (db2_shuttle_settings.sql; empty until applied) ──
const hhmm = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
const toMin = (h) => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };
const localMinutes = (iso, tz = GUIDE_TZ) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  return Number(p.find(x => x.type === "hour").value) * 60 + Number(p.find(x => x.type === "minute").value); };
// Pickup time for a ride: the latest fixed pickup that still leaves lead_minutes before the start; else lead_minutes before; else null.
export function pickupTimeFor(rideStartIso, setting, date) {
  if (!rideStartIso || !setting) return null;
  const lead = Number.isFinite(setting.lead_minutes) ? setting.lead_minutes : null;
  const fixed = (setting.pickup_times ?? []).map(hhmm).filter(Boolean);
  if (fixed.length && date) {
    const latest = localMinutes(rideStartIso) - (lead ?? 0);
    const ok = fixed.filter(h => toMin(h) <= latest).sort((x, y) => toMin(y) - toMin(x))[0];
    if (ok) return localTimeToIso(date, ok);
  }
  return lead != null ? new Date(Date.parse(rideStartIso) - lead * 60000).toISOString() : null;
}
export function normalizeShuttleSetting(body) {
  const loc = String(body?.location ?? "");
  if (!LOCATIONS.some(l => l.key === loc)) return { error: "pick a location" };
  const int = (v, lo, hi) => { if (v === null || v === undefined || v === "") return null; const n = Number.parseInt(v, 10); return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN; };
  const lead = int(body.lead_minutes, 0, 300), ret = int(body.return_after_minutes, 0, 240), seats = int(body.seats, 1, 60);
  if (Number.isNaN(lead)) return { error: "minutes before the ride: 0–300" };
  if (Number.isNaN(ret)) return { error: "minutes after the ride: 0–240" };
  if (Number.isNaN(seats)) return { error: "seats: 1–60" };
  const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map(x => String(x).trim()).filter(Boolean);
  const times = list(body.pickup_times);
  const bad = times.find(x => !hhmm(x));
  if (bad) return { error: `"${bad}" isn't a time (use 6:45 or 13:15)` };
  return { row: { client_id: "csr_rea", location: loc, lead_minutes: lead, pickup_times: [...new Set(times.map(hhmm))].sort(), start_point: text(body.start_point, 160),
    meeting_spots: list(body.meeting_spots).map(x => x.slice(0, 120)).slice(0, 10), return_after_minutes: ret ?? 0, seats: seats ?? VAN_SEATS, active: body.active !== false } };
}
function loadShuttleSettings(crm, clientId = "csr_rea") {
  return memo(crm, `shuttle:${clientId}`, TTL.shuttle, () => loadShuttleSettingsNow(crm, clientId));
}
async function loadShuttleSettingsNow(crm, clientId) {
  try {
    const { data, error } = await crm.from("shuttle_settings").select("*").eq("client_id", clientId);
    if (error) return { ok: false, by: {} };
    return { ok: true, by: Object.fromEntries((data ?? []).filter(r => r.active !== false).map(r => [r.location, r])) };
  } catch { return { ok: false, by: {} }; }
}
// POST /guide/api/admin/shuttle — managers set one location's shuttle settings.
export async function handleGuideAdminShuttle(deps, body) {
  const a = await requireManager(deps, body?.t); if (a.error) return a.error;
  const n = normalizeShuttleSetting(body);
  if (n.error) return { status: 400, body: { error: n.error } };
  const { error } = await deps.crm.from("shuttle_settings").upsert({ ...n.row, updated_by: a.me.phone, updated_at: new Date().toISOString() }, { onConflict: "client_id,location" });
  if (error) return { status: 500, body: { error: /shuttle_settings/.test(error.message ?? "") ? "Shuttle settings aren't switched on yet (db2_shuttle_settings.sql)" : "could not save" } };
  bust(deps.crm, "shuttle:");
  return written(deps, { ok: true });
}
function unitSuggestions(crm) { return memo(crm, "units", TTL.units, () => unitSuggestionsNow(crm)); }
async function unitSuggestionsNow(crm) {
  try {
    const { data, error } = await crm.from("booking_equipment").select("kind, unit").order("updated_at", { ascending: false }).limit(500);
    if (error) return { sled: [], trailer: [], other: [] };
    const o = { sled: [], trailer: [], other: [] };
    for (const r of data ?? []) if (o[r.kind] && !o[r.kind].includes(r.unit)) o[r.kind].push(r.unit);
    for (const k of Object.keys(o)) o[k].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    return o;
  } catch { return { sled: [], trailer: [], other: [] }; }
}
// the booking (and its departure) on a day this person may see in full
async function findBooking(deps, a, d, bookingPk) {
  const date = d ? allowedDate(d, a.date, a.me.access) : a.date;
  const all = await loadDay(deps.crm, deps.db1, { date });
  const dep = all.find(x => x.booking_pks.includes(bookingPk));
  if (!dep) return { error: { status: 404, body: { error: "booking not found" } } };
  const mine = (dep.assignees ?? []).some(x => x.phone === a.me.phone);
  if (!(a.me.access === "manager" || mine || (a.me.access === "shop" && dep.type === "rental"))) return { error: { status: 403, body: { error: "not your booking" } } };
  return { dep, all, date, booking: dep.bookings.find(b => b.pk === bookingPk) };
}
// POST /guide/api/equipment — a sled / trailer on a booking (managers + shop). { booking_pk, kind, unit, note? } or { remove_id }
export async function handleGuideEquipment(deps, { t, d = null, booking_pk, kind = "sled", unit, note = null, remove_id = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  if (!["manager", "shop"].includes(a.me.access)) return { status: 403, body: { error: "Managers and the shop assign sleds" } };
  const f = await findBooking(deps, a, d, String(booking_pk ?? "")); if (f.error) return f.error;
  if (remove_id) {
    await deps.crm.from("booking_equipment").delete().eq("id", String(remove_id)).eq("booking_pk", f.booking.pk);
    return written(deps, { ok: true });
  }
  const u = String(unit ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!u) return { status: 400, body: { error: "Type the sled or trailer name" } };
  if (!["sled", "trailer", "other"].includes(kind)) return { status: 400, body: { error: "kind must be sled, trailer or other" } };
  const { error } = await deps.crm.from("booking_equipment").upsert({ client_id: "csr_rea", booking_pk: f.booking.pk, ride_date: f.dep.ride_date, kind, unit: u,
    note: note ? String(note).slice(0, 200) : null, source: "app", updated_by: a.me.phone, updated_at: new Date().toISOString() }, { onConflict: "booking_pk,kind,unit" });
  if (error) return { status: 500, body: { error: "could not save" } };
  return written(deps, { ok: true });
}
// POST /guide/api/note — an internal note on a booking (anyone who sees the booking in full). { booking_pk, note } or { remove_id }
export async function handleGuideNote(deps, { t, d = null, booking_pk, note, remove_id = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const f = await findBooking(deps, a, d, String(booking_pk ?? "")); if (f.error) return f.error;
  if (remove_id) {
    const q = deps.crm.from("booking_staff_notes").update({ hidden: true }).eq("id", String(remove_id)).eq("booking_pk", f.booking.pk);
    await (a.me.access === "manager" ? q : q.eq("author_phone", a.me.phone));
    return written(deps, { ok: true });
  }
  const n = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!n) return { status: 400, body: { error: "Write a note first" } };
  const meStaff = (f.all.staff ?? []).find(x => x.phone === a.me.phone);
  const { error } = await deps.crm.from("booking_staff_notes").insert({ client_id: "csr_rea", booking_pk: f.booking.pk, ride_date: f.dep.ride_date, note: n,
    author_phone: a.me.phone, author_name: meStaff?.display_name ?? a.me.display_name ?? null });
  if (error) return { status: 500, body: { error: "could not save" } };
  return written(deps, { ok: true });
}
// POST /guide/api/run — managers: { d, action: "suggest" } makes runs for shuttle requests not on one;
// { d, id?, kind, vehicle, seats, depart_time "HH:MM", driver_phone, booking_pks[], notes } saves one; { d, id, remove: true } deletes.
export function localTimeToIso(date, hhmm, tz = GUIDE_TZ) {
  if (!/^\d{1,2}:\d{2}$/.test(String(hhmm ?? ""))) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  for (const off of [6, 7]) {                                          // Mountain Time: UTC-7 (MST) or UTC-6 (MDT)
    const iso = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h + off, m)).toISOString();
    if (localHour(new Date(iso), tz) === h && localDate(iso, tz) === date) return iso;
  }
  return null;
}
export async function handleGuideRun(deps, body) {
  const a = await authed(deps, body?.t); if (a.error) return a.error;
  if (a.me.access !== "manager") return { status: 403, body: { error: "Managers only" } };
  const date = body.d ? allowedDate(body.d, a.date, "manager") : a.date;
  const all = await loadDay(deps.crm, deps.db1, { date });
  if (body.action === "suggest") {
    // only to-trailhead runs count as "taken" — a return run alone doesn't stop a booking from being planned
    const made = suggestRuns(all, (all.runs ?? []).filter(r => r.kind === "to_trail"), { settings: all.shuttle?.by ?? {}, date });
    const vans = new Set((all.runs ?? []).map(r => r.vehicle).filter(Boolean));
    let n = 0;
    const insert = async (r, vehicle) => (await deps.crm.from("shuttle_runs").insert({ client_id: "csr_rea", run_date: date, kind: r.kind, seats: r.seats, vehicle,
      ...(all.shuttle?.ok ? { location: r.location ?? null } : {}),
      depart_at: r.depart_at ?? null, booking_pks: r.booking_pks, availability_pks: r.availability_pks, stops: r.booking_pks.map(pk => ({ booking_pk: pk })), created_by: a.me.phone })).error;
    for (const r of made) {
      let vehicle; do vehicle = `Van ${++n}`; while (vans.has(vehicle)); vans.add(vehicle);
      if (await insert(r, vehicle) || await insert(returnRunFor(r), vehicle)) return { status: 500, body: { error: "could not save" } };
    }
    return written(deps, { ok: true, created: made.length, returns: made.length });
  }
  if (body.remove && body.id) {
    await deps.crm.from("shuttle_runs").delete().eq("id", String(body.id)).eq("run_date", date);
    return written(deps, { ok: true });
  }
  const kind = RUN_KINDS.includes(body.kind) ? body.kind : "to_trail";
  const dayPks = new Set(all.flatMap(x => x.booking_pks));
  const pks = [...new Set((Array.isArray(body.booking_pks) ? body.booking_pks : []).map(String))].filter(pk => dayPks.has(pk));
  const seats = Math.max(1, Math.min(60, Number.parseInt(body.seats, 10) || VAN_SEATS));
  const driver = body.driver_phone ? (all.staff ?? []).find(x => x.phone === body.driver_phone) : null;
  if (body.driver_phone && !driver) return { status: 400, body: { error: "pick the driver from the staff list" } };
  const row = { client_id: "csr_rea", run_date: date, kind, seats, vehicle: body.vehicle ? String(body.vehicle).slice(0, 40) : null,
    depart_at: localTimeToIso(date, body.depart_time), driver_phone: driver?.phone ?? null, driver_name: driver?.display_name ?? null,
    booking_pks: pks, availability_pks: [...new Set(all.filter(x => x.booking_pks.some(p => pks.includes(p))).map(x => String(x.availability_pk)))],
    stops: pks.map(pk => ({ booking_pk: pk })), notes: body.notes ? String(body.notes).slice(0, 300) : null, updated_at: new Date().toISOString(),
    ...(all.shuttle?.ok ? { location: all.find(x => x.booking_pks.some(p => pks.includes(p)))?.location ?? null } : {}) };
  const q = body.id ? deps.crm.from("shuttle_runs").update(row).eq("id", String(body.id)).eq("run_date", date)
    : deps.crm.from("shuttle_runs").insert({ ...row, created_by: a.me.phone });
  const { error } = await q;
  if (error) return { status: 500, body: { error: "could not save" } };
  return written(deps, { ok: true });
}

export async function handleGuideDay(deps, { t, d, as = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const view = viewFor(a.me.access, as);
  const today = a.date, date = allowedDate(d, today, view === "manager" ? "manager" : a.me.access);
  const all = await loadDay(deps.crm, deps.db1, { date });
  const list = visibleDepartures(all, { access: view, phone: a.me.phone }).map(x => publicDeparture(x, a.me, view));
  const meStaff = (all.staff ?? []).find(x => x.phone === a.me.phone);
  // nothing (for you) on this day → point at the next day that has something
  let next = null;
  if (!list.length || (view === "guide" && !list.some(x => x.mine))) {
    try { next = await findNextDay(deps, { date, access: view, phone: a.me.phone }); } catch { next = null; }
  }
  return { status: 200, body: {
    me: { name: meStaff?.display_name ?? a.me.display_name ?? a.me.label ?? null, access: a.me.access, views: VIEWS_FOR[a.me.access] ?? [], view, home_location: meStaff?.home_location ?? null },
    date, today, locations: LOCATIONS, departures: list, next,
    runs: view === "manager" ? (all.runs ?? []).map(r => publicRun(r, all)) : [],
    my_runs: (all.runs ?? []).filter(r => r.driver_phone === a.me.phone).map(r => publicRun(r, all)),
    units: view === "manager" || view === "shop" ? await unitSuggestions(deps.crm) : null,
    // managers assign people; everyone else only needs names (team view)
    staff: (all.staff ?? []).map(x => ({ name: x.display_name, role: x.role, home_location: x.home_location, ...(view === "manager" ? { phone: x.phone } : {}) })),
  } };
}

// Photos + ride details: today's rides, or yesterday's (added the morning after).
export const rideDay = (d, today) => (d === addDays(today, -1) ? d : today);
async function findDeparture(deps, me, date, availabilityPk) {
  const all = await loadDay(deps.crm, deps.db1, { date });
  const dep = all.find(x => String(x.availability_pk) === String(availabilityPk));
  if (!dep) return { error: { status: 404, body: { error: "ride not found" } } };
  if (!visibleDepartures([dep], { access: me.access, phone: me.phone }).length) return { error: { status: 403, body: { error: "not your ride" } } };
  return { dep };
}

// "This is my ride" — optionally only some riders (split departure). Re-claiming updates the rider list.
export async function handleGuideClaim(deps, { t, availability_pk, booking_pks = null, release = false, d = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, d ? allowedDate(d, a.date, a.me.access) : a.date, availability_pk); if (f.error) return f.error;   // future rides can be taken too
  if (release) {
    await deps.crm.from("ride_assignments").delete().eq("availability_pk", String(availability_pk)).eq("operator_phone", a.me.phone);
    return written(deps, { ok: true });
  }
  const pks = Array.isArray(booking_pks) ? booking_pks.filter(p => f.dep.booking_pks.includes(p)) : [];
  const row = { client_id: "csr_rea", availability_pk: String(availability_pk), ride_date: f.dep.ride_date, operator_phone: a.me.phone,
    guide_name: a.me.display_name ?? a.me.label ?? null, booking_pks: pks.length === f.dep.booking_pks.length ? [] : pks, source: "claim", assigned_by: a.me.phone };
  const { error } = await deps.crm.from("ride_assignments").upsert(row, { onConflict: "availability_pk,operator_phone" });
  if (error) return { status: 500, body: { error: "could not save" } };
  return written(deps, { ok: true });
}

// A manager puts a staff member on a departure (or only some of its riders), or takes them off.
export async function handleGuideAssign(deps, { t, availability_pk, phone, booking_pks = null, remove = false, d = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  if (a.me.access !== "manager") return { status: 403, body: { error: "Managers only" } };
  const all = await loadDay(deps.crm, deps.db1, { date: d ? allowedDate(d, a.date, "manager") : a.date });   // any day of the season
  const dep = all.find(x => String(x.availability_pk) === String(availability_pk));
  if (!dep) {
    const y = await loadDay(deps.crm, deps.db1, { date: addDays(a.date, 1) });         // managers also plan tomorrow
    const d2 = y.find(x => String(x.availability_pk) === String(availability_pk));
    if (!d2) return { status: 404, body: { error: "booking not found" } };
    return assignTo(deps, a, d2, y.staff, { phone, booking_pks, remove });
  }
  return assignTo(deps, a, dep, all.staff, { phone, booking_pks, remove });
}
// Per booking (Sean: "a guide assignment … per booking, not just day"): put one booking with a person (or nobody).
// Whoever had it loses just that booking; a whole-departure assignment becomes an explicit list of the others.
export function planBookingAssign(dep, assignments, bookingPk, phone) {
  const all = dep.booking_pks, rows = (assignments ?? []).filter(x => String(x.availability_pk) === String(dep.availability_pk));
  const ops = [];
  for (const r of rows) {
    const covers = !r.booking_pks?.length || r.booking_pks.includes(bookingPk);
    if (!covers || r.operator_phone === phone) continue;
    const rest = (r.booking_pks?.length ? r.booking_pks : all).filter(p => p !== bookingPk);
    ops.push(rest.length ? { op: "set", phone: r.operator_phone, booking_pks: rest } : { op: "delete", phone: r.operator_phone });
  }
  if (phone) {
    const mine = rows.find(r => r.operator_phone === phone);
    const now = mine ? (mine.booking_pks?.length ? mine.booking_pks : all) : [];
    const next = [...new Set([...(mine && !mine.booking_pks?.length ? all : now), bookingPk])].filter(p => all.includes(p));
    ops.push({ op: "set", phone, booking_pks: next.length === all.length ? [] : next });
  }
  return ops;
}
export async function handleGuideAssignBooking(deps, { t, availability_pk, booking_pk, phone = null, d = null }) {
  const a = await authed(deps, t); if (a.error) return a.error;
  if (a.me.access !== "manager") return { status: 403, body: { error: "Managers only" } };
  const all = await loadDay(deps.crm, deps.db1, { date: d ? allowedDate(d, a.date, "manager") : a.date });
  const dep = all.find(x => String(x.availability_pk) === String(availability_pk));
  if (!dep || !dep.booking_pks.includes(booking_pk)) return { status: 404, body: { error: "booking not found" } };
  const person = phone ? (all.staff ?? []).find(x => x.phone === phone) : null;
  if (phone && !person) return { status: 400, body: { error: "pick someone from the staff list (with a phone number)" } };
  const { data: rows } = await deps.crm.from("ride_assignments").select("*").eq("availability_pk", String(dep.availability_pk));
  for (const o of planBookingAssign(dep, rows ?? [], booking_pk, phone)) {
    if (o.op === "delete") { await deps.crm.from("ride_assignments").delete().eq("availability_pk", String(dep.availability_pk)).eq("operator_phone", o.phone); continue; }
    const who = (all.staff ?? []).find(x => x.phone === o.phone);
    const prev = (rows ?? []).find(r => r.operator_phone === o.phone);
    const { error } = await deps.crm.from("ride_assignments").upsert({ client_id: "csr_rea", availability_pk: String(dep.availability_pk), ride_date: dep.ride_date,
      operator_phone: o.phone, guide_name: who?.display_name ?? prev?.guide_name ?? null, booking_pks: o.booking_pks,
      source: o.phone === phone ? "manager" : (prev?.source ?? "manager"), assigned_by: o.phone === phone ? a.me.phone : (prev?.assigned_by ?? a.me.phone) },
      { onConflict: "availability_pk,operator_phone" });
    if (error) return { status: 500, body: { error: "could not save" } };
  }
  return written(deps, { ok: true });
}
async function assignTo(deps, a, dep, staff, { phone, booking_pks, remove }) {
  const person = (staff ?? []).find(x => x.phone === phone);
  if (!person) return { status: 400, body: { error: "pick someone from the staff list (with a phone number)" } };
  if (remove) {
    await deps.crm.from("ride_assignments").delete().eq("availability_pk", String(dep.availability_pk)).eq("operator_phone", phone);
    return written(deps, { ok: true });
  }
  const pks = Array.isArray(booking_pks) ? booking_pks.filter(p => dep.booking_pks.includes(p)) : [];
  const { error } = await deps.crm.from("ride_assignments").upsert({ client_id: "csr_rea", availability_pk: String(dep.availability_pk), ride_date: dep.ride_date,
    operator_phone: phone, guide_name: person.display_name, booking_pks: pks.length === dep.booking_pks.length ? [] : pks, source: "manager", assigned_by: a.me.phone },
    { onConflict: "availability_pk,operator_phone" });
  if (error) return { status: 500, body: { error: "could not save" } };
  return written(deps, { ok: true });
}

const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < max ? Math.round(n * 10) / 10 : null; };
const text = (v, max) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, max) : null; };

export async function handleGuideLog(deps, body) {
  const a = await authed(deps, body?.t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, rideDay(body?.d, a.date), body.availability_pk); if (f.error) return f.error;
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
  return written(deps, { ok: true });
}

async function fetchBuf(url, fetchImpl) { try { const r = await fetchImpl(url); return r?.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; } }

// One photo (base64 JPEG/PNG from the phone, already shrunk there). → stored set + a ride_media row.
export async function handleGuidePhoto(deps, body, { process: proc = processRidePhoto, upload = uploadRidePhotos, fetchImpl = globalThis.fetch } = {}) {
  const a = await authed(deps, body?.t); if (a.error) return a.error;
  const f = await findDeparture(deps, a.me, rideDay(body?.d, a.date), body.availability_pk); if (f.error) return f.error;
  if (!/^image\/(jpeg|png)$/i.test(String(body.content_type ?? ""))) return { status: 415, body: { error: "Photos must be JPEG or PNG" } };
  const buf = Buffer.from(String(body.data ?? ""), "base64");
  if (!buf.length || buf.length > PHOTO_SPEC.maxUploadBytes) return { status: 413, body: { error: "photo empty or too large" } };
  // idempotent retries: the phone sends a client id per photo
  const clientId = text(body.client_id, 64);
  if (clientId) {
    const { data: dup } = await deps.crm.from("ride_media").select("id").eq("availability_pk", String(f.dep.availability_pk)).eq("client_upload_id", clientId).limit(1).maybeSingle();
    if (dup) return written(deps, { ok: true, id: dup.id, duplicate: true });
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
  return written(deps, { ok: true, id: data.id, thumb: urls.thumbs[0] });
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
  return written(deps, { ok: true });
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
  const sh = await loadShuttleSettings(deps.crm);
  return { status: 200, body: {
    tours: groupTours(tours), staff, locations: LOCATIONS, roles: STAFF_ROLES, shuttle: { ready: sh.ok, by: sh.by },
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
  return written(deps, { ok: true, rows: data.length });
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
  return written(deps, { ok: true, map_url: url });
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
  return written(deps, { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id });
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
  return written(deps, { ok: true });
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
