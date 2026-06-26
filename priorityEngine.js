// ─────────────────────────────────────────────────────────────────────────────
// priorityEngine.js — Operator Intelligence 2.0: deterministic prioritization
//
// Turns the day's raw signals into a RANKED list of "what needs your attention,
// highest-impact first." Same signals, re-weighted per role so a mechanic's #1
// differs from an owner's. Pure — no I/O. Inputs come pre-filtered by location.
//
// Exports:
//   scorePriorities(ctx, { role, locations }) → ranked PriorityItem[]
//   buildTodaysPriorities(scored, n=3)        → top-N { headline, action }
//   PriorityItem = { id, category, score, base, headline, action, replyKey, severity }
// ─────────────────────────────────────────────────────────────────────────────

import { getRoleProfile } from "./operatorRoles.js";
import { humanizeWorkType } from "./mpwrWorkOrders.js";

// Card category → numeric reply shortcut (matches OPERATOR_MENU 2.0).
export const CATEGORY_REPLY = {
  bookings: 1, revenue: 2, waivers: 3, late_returns: 4,
  fleet: 5, maintenance: 5, safety: 5,
  leads: 6, handoff: 6, staffing: 7,
  unpaid: 1, missing_phone: 1, vip: 1, underbooked: 2, pacing: 2, weather: 0,
};

function replyFor(category) {
  const n = CATEGORY_REPLY[category];
  return n ? `Reply ${n}` : null;
}

// Base scores (spec rubric). Higher = more urgent before role weighting.
const BASE = {
  safety:        100,
  waivers_today:  90, // guest arriving today, no waiver
  oos_needed:     85, // out-of-service unit needed for a departure today
  vip_group:      80,
  unpaid_large:   70,
  overdue_repair: 65,
  handoff:        60,
  underbooked:    55,
  pacing_down:    50,
  missing_phone:  50,
  high_value:     45,
  maintenance:    40,
  waivers_soon:   45, // missing waiver, not arriving today
};

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
const firstName = (n) => String(n ?? "").trim().split(/\s+/)[0] || "guest";
const usd = (cents) => `$${Math.round((Number(cents) || 0) / 100).toLocaleString()}`;
const isToday = (naive, today) => !!naive && String(naive).slice(0, 10) === today;

// Significant vehicle tokens for matching an OOS unit to a booked activity.
const STOP_TOKENS = new Set(["the", "and", "for", "polaris", "seater", "experience", "rental", "tour", "adventure", "pass", "ride"]);
function vehicleTokens(str) {
  return new Set(
    String(str ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)),
  );
}
function sharesVehicle(a, b) {
  const ta = vehicleTokens(a);
  for (const t of vehicleTokens(b)) if (ta.has(t)) return true;
  return false;
}

// ── Candidate generation ──────────────────────────────────────────────────────
// Each rule emits 0..1 PriorityItem from ctx. All null-safe.
function candidates(ctx) {
  const today = ctx.today ?? todayStr();
  const out = [];
  const arr = (x) => (Array.isArray(x) ? x : []);

  // 1. Flagged work order — open WO marked a safety issue (a work order, NOT a
  //    "safety check" — surface the actual unit + work type).
  const safetyWos = arr(ctx.workOrders).filter((w) => w.is_safety_issue && !w.is_closed);
  if (safetyWos.length) {
    const w = safetyWos[0];
    const unit = w.unit_name || w.asset_family || "a unit";
    const wt = w.work_type ? humanizeWorkType(w.work_type) : "work order";
    const more = safetyWos.length > 1 ? ` (+${safetyWos.length - 1} more)` : "";
    out.push({ id: "safety", category: "safety", base: BASE.safety,
      headline: `Open work order: ${unit} — ${wt}${more}`,
      action: replyFor("safety") });
  }

  // 2. Missing waivers arriving today.
  const waiversToday = arr(ctx.missingWaivers).filter((r) => isToday(r.start_at, today));
  if (waiversToday.length) {
    const names = waiversToday.slice(0, 2).map((r) => firstName(r.customer_name)).join(", ");
    out.push({ id: "waivers_today", category: "waivers", base: BASE.waivers_today,
      headline: `${waiversToday.length} guest${waiversToday.length !== 1 ? "s" : ""} missing waivers today (${names})`,
      action: replyFor("waivers") });
  } else if (arr(ctx.missingWaivers).length) {
    out.push({ id: "waivers_soon", category: "waivers", base: BASE.waivers_soon,
      headline: `${ctx.missingWaivers.length} missing waiver${ctx.missingWaivers.length !== 1 ? "s" : ""} in next 48h`,
      action: replyFor("waivers") });
  }

  // 3. Out-of-service unit needed for a departure today.
  const oos = arr(ctx.workOrders).filter((w) => w.out_of_service && !w.is_closed);
  const todayActs = arr(ctx.manifest).filter((r) => isToday(r.start_at, today)).map((r) => r.activity);
  const oosNeeded = oos.filter((w) => todayActs.some((a) => sharesVehicle(a, `${w.asset_family} ${w.unit_name}`)));
  if (oosNeeded.length) {
    const w = oosNeeded[0];
    out.push({ id: "oos_needed", category: "fleet", base: BASE.oos_needed,
      headline: `Down unit needed today: ${w.asset_family || "unit"}${w.unit_name ? ` (${w.unit_name})` : ""}`,
      action: replyFor("fleet") });
  }

  // 4. VIP / large group today (pax >= 6).
  const bigGroup = arr(ctx.manifest)
    .filter((r) => isToday(r.start_at, today) && (Number(r.pax ?? r.customer_count) || 0) >= 6)
    .sort((a, b) => (Number(b.pax) || 0) - (Number(a.pax) || 0))[0];
  if (bigGroup) {
    out.push({ id: "vip_group", category: "vip", base: BASE.vip_group,
      headline: `Large group today: ${firstName(bigGroup.customer_name)} ${(Number(bigGroup.pax ?? bigGroup.customer_count) || 0)}p`,
      action: replyFor("bookings") });
  }

  // 5. Large imminent unpaid balance (>= $500).
  const bigUnpaid = arr(ctx.unpaid).filter((r) => (Number(r.balance_due_cents) || 0) >= 50000)
    .sort((a, b) => (Number(b.balance_due_cents) || 0) - (Number(a.balance_due_cents) || 0))[0];
  if (bigUnpaid) {
    out.push({ id: "unpaid_large", category: "unpaid", base: BASE.unpaid_large,
      headline: `Collect ${usd(bigUnpaid.balance_due_cents)} from ${firstName(bigUnpaid.customer_name)}`,
      action: replyFor("unpaid") });
  }

  // 6. Overdue repairs (non-safety, already past est. completion).
  const overdue = oos.concat(arr(ctx.workOrders).filter((w) => !w.out_of_service && !w.is_closed))
    .filter((w) => w.estimated_completion_date && String(w.estimated_completion_date).slice(0, 10) < today && !w.is_safety_issue);
  const overdueUniq = [...new Map(overdue.map((w) => [w.id, w])).values()];
  if (overdueUniq.length) {
    out.push({ id: "overdue_repair", category: "fleet", base: BASE.overdue_repair,
      headline: `${overdueUniq.length} overdue repair${overdueUniq.length !== 1 ? "s" : ""}`,
      action: replyFor("fleet") });
  }

  // 7. Unresolved guest handoff.
  if (arr(ctx.unresolvedHandoffs).length) {
    out.push({ id: "handoff", category: "handoff", base: BASE.handoff,
      headline: `${ctx.unresolvedHandoffs.length} guest message${ctx.unresolvedHandoffs.length !== 1 ? "s" : ""} need${ctx.unresolvedHandoffs.length !== 1 ? "" : "s"} a reply`,
      action: replyFor("handoff") });
  }

  // 8. Underbooked near-term (low upcoming volume).
  const upc = ctx.upcomingRevenue;
  if (upc && Number(upc.bookings) >= 0 && Number(upc.bookings) <= 2 && (ctx.hasUpcomingWindow ?? true)) {
    out.push({ id: "underbooked", category: "underbooked", base: BASE.underbooked,
      headline: `Light week ahead (${upc.bookings} booking${upc.bookings !== 1 ? "s" : ""}) — promote open days`,
      action: replyFor("underbooked") });
  }

  // 9. Pacing down >= 25% vs last week.
  if (ctx.pacing && ctx.pacing.last_week > 4 && Number(ctx.pacing.delta_pct) <= -25) {
    out.push({ id: "pacing_down", category: "pacing", base: BASE.pacing_down,
      headline: `Bookings pacing down ${Math.abs(ctx.pacing.delta_pct)}% vs last week`,
      action: replyFor("pacing") });
  }

  // 10. Missing phone on imminent arrival.
  if (arr(ctx.missingPhones).length) {
    out.push({ id: "missing_phone", category: "missing_phone", base: BASE.missing_phone,
      headline: `${ctx.missingPhones.length} arrival${ctx.missingPhones.length !== 1 ? "s" : ""} missing a phone number`,
      action: replyFor("bookings") });
  }

  // 11. High-value upcoming opportunity.
  const hv = arr(ctx.highValue)[0];
  if (hv) {
    out.push({ id: "high_value", category: "revenue", base: BASE.high_value,
      headline: `High-value booking: ${firstName(hv.customer_name)} ${usd(hv.receipt_total_cents ?? hv.total_cents)}`,
      action: replyFor("revenue") });
  }

  // 12. Maintenance due soon (within 7 days, not overdue).
  const dueSoon = arr(ctx.workOrders).filter((w) => {
    const d = w.estimated_completion_date && String(w.estimated_completion_date).slice(0, 10);
    if (!d || w.is_closed) return false;
    const days = (new Date(d) - new Date(today)) / 86400000;
    return days >= 0 && days <= 7;
  });
  if (dueSoon.length) {
    out.push({ id: "maintenance", category: "maintenance", base: BASE.maintenance,
      headline: `${dueSoon.length} maintenance item${dueSoon.length !== 1 ? "s" : ""} due this week`,
      action: replyFor("maintenance") });
  }

  return out;
}

// Rank candidates, re-weighted by role. Highest finalScore first; ties broken by
// base score then category name for determinism.
export function scorePriorities(ctx, { role = "owner" } = {}) {
  const weights = getRoleProfile(role).priorityWeights ?? {};
  const items = candidates(ctx ?? {}).map((it) => {
    const mult  = weights[it.category] ?? 1;
    const score = Math.round(it.base * mult);
    return {
      ...it,
      score,
      replyKey: it.action ? Number(it.action.replace(/\D/g, "")) || null : null,
      severity: it.base >= 85 ? "critical" : it.base >= 60 ? "high" : "normal",
    };
  });
  items.sort((a, b) => b.score - a.score || b.base - a.base || a.category.localeCompare(b.category));
  return items;
}

// Top-N priorities for the briefing header.
export function buildTodaysPriorities(scored, n = 3) {
  return (Array.isArray(scored) ? scored : []).slice(0, n).map((it) => ({
    headline: it.headline,
    action:   it.action,
  }));
}
