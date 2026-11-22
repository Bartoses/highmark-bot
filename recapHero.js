// ─────────────────────────────────────────────────────────────────────────────
// RECAP HERO — the "fun top" of a Ride Recap (A/B experiment `hero`, version B):
//   • your sled      model, engine and track length straight from the FareHarbor booking
//   • badges         Powder Day, Bluebird, Below Zero, First Timer / Ride #N, Crew of N, Early Riser, Sunset Rider, Deep Base
//   • snow report    snow on the ground (USDA SNOTEL, same report the bot's knowledge base already uses) + % of normal +
//                    fresh snow, with a 7-day snow-depth bar chart drawn in email-safe table cells (no images)
//   • powder alert   the biggest snowfall in the next 7 days (Open-Meteo) with a "book it" button
// Everything degrades: any source that fails or has no data simply leaves its module out — never "undefined", never a blank box.
// ─────────────────────────────────────────────────────────────────────────────
import { escapeHtml } from "./emailTemplates.js";

const SNOTEL_REPORT = "https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/daily";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymdAdd = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const ymdLabel = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${DOW[w]}, ${MON[m - 1]} ${d}`; };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// ── your sled ────────────────────────────────────────────────────────────────
// Rentals name the sled in the item ("Polaris 850 Khaos 165\" Slash • Steamboat"); guided backcountry in the rider type
// ("Polaris 850 Khaos 155\" • Steamboat"). REA tours just say "Snowmobile" → no sled card.
export function parseSled(name) {
  const raw = String(name ?? "").replace(/^Sled Ski - /i, "");
  if (!/polaris/i.test(raw) || /\brzr\b|ranger|general/i.test(raw)) return null;   // snowmobiles only
  const clean = raw.split("•")[0].replace(/^\d{4}\s+/, "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  const track = (clean.match(/\b(1[2-7]\d)\s*(?:"|”|in\b)?(?=\s|$)/) || [])[1];
  const eng = /\b9R\b/i.test(clean) ? "9R" : (clean.match(/\b(850|650|600)\b/) || [])[1] ?? (/\bS4\b/i.test(clean) ? "S4" : null);
  const boost = /boost/i.test(clean);
  const engine = !eng ? null : eng === "9R" ? "9R" : eng === "S4" ? "S4 four-stroke" : `${eng}${boost ? " Boost (turbo)" : ""}`;
  const t = track ? Number(track) : null;
  const note = !t ? null : t >= 163 ? "a long track, built to float in deep powder" : t >= 150 ? "a mountain-length track for climbing and carving" : "a nimble trail-length track";
  return { name: clean.replace(/\s+(\d{3})\s*"?\s*$/, ' $1"'), engine, trackIn: t, note };
}

// One line per distinct sled across the guest's bookings that day, e.g. [{ sled, count: 2 }].
export function sledsFromBookings(bookings) {
  const seen = new Map();
  const add = (sled, n) => { const cur = seen.get(sled.name); seen.set(sled.name, { sled, count: (cur?.count ?? 0) + n }); };
  for (const bk of bookings ?? []) {
    const raw = bk?.raw_payload?.booking ?? bk?.raw_payload ?? {};
    const customers = raw?.customers ?? [];
    const itemSled = parseSled(raw?.availability?.item?.name ?? bk?.item);
    if (itemSled) { add(itemSled, customers.length || 1); continue; }                     // rental: the item IS the sled
    for (const c of customers) { const sl = parseSled(c?.customer_type_rate?.customer_type?.singular); if (sl) add(sl, 1); }   // guided: per rider
  }
  return [...seen.values()].sort((x, y) => y.count - x.count);
}

// ── conditions (Open-Meteo: ride day, fresh snow before it, next 7 days) ─────
export async function fetchConditions({ lat, lon, date, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  if (lat == null || lon == null || !date || !fetchImpl) return null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,snowfall_sum` +
      `&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America%2FDenver&start_date=${ymdAdd(date, -2)}&end_date=${ymdAdd(date, 8)}`;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetchImpl(u, ctl ? { signal: ctl.signal } : undefined).finally(() => t && clearTimeout(t));
    if (!res?.ok) return null;
    return conditionsFromDaily((await res.json())?.daily, date);
  } catch { return null; }
}

export function conditionsFromDaily(daily, date) {
  const days = (daily?.time ?? []).map((d, i) => ({ date: d, code: num(daily.weathercode?.[i]), hi: num(daily.temperature_2m_max?.[i]), lo: num(daily.temperature_2m_min?.[i]), snow: num(daily.snowfall_sum?.[i]) }));
  const i = days.findIndex(d => d.date === date);
  if (i < 0) return null;
  const fresh48 = days.slice(Math.max(0, i - 2), i + 1).reduce((s, d) => s + (d.snow ?? 0), 0);
  const ahead = days.slice(i + 1, i + 8).filter(d => d.snow != null);
  const best = ahead.reduce((b, d) => (d.snow > (b?.snow ?? 0) ? d : b), null);
  return { day: days[i], fresh48: Math.round(fresh48 * 10) / 10, powder: best && best.snow >= 4 ? { date: best.date, label: ymdLabel(best.date), inches: Math.round(best.snow) } : null };
}

// ── snow on the ground (USDA SNOTEL report generator, 7 days) ────────────────
export async function fetchSnowReport({ stationId, stationName = null, date, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!stationId || !date || !fetchImpl) return null;
  try {
    const part = encodeURIComponent(`${stationId}|id=""|name`);
    const u = `${SNOTEL_REPORT}/${part}/${ymdAdd(date, -6)},${date}/SNWD::value,WTEQ::pctOfMedian_1991`;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetchImpl(u, { headers: { "User-Agent": "Highmark-Bot/1.0" }, ...(ctl ? { signal: ctl.signal } : {}) }).finally(() => t && clearTimeout(t));
    if (!res?.ok) return null;
    return snowReportFromCsv(await res.text(), { stationName });
  } catch { return null; }
}

export function snowReportFromCsv(text, { stationName = null } = {}) {
  const rows = String(text ?? "").split("\n").map(l => l.trim()).filter(l => /^\d{4}-\d{2}-\d{2},/.test(l))
    .map(l => { const [d, depth, pct] = l.split(",").map(v => v.trim()); return { date: d, depthIn: num(depth), pct: num(pct) }; })
    .filter(r => r.depthIn != null);
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return { station: stationName, depthIn: Math.round(last.depthIn), pctNormal: last.pct != null && last.pct > 0 ? Math.round(last.pct) : null,
    days: rows.slice(-7).map(r => ({ date: r.date, depthIn: Math.round(r.depthIn), label: ymdLabel(r.date).slice(0, 3) })) };
}

// ── badges ───────────────────────────────────────────────────────────────────
export function buildBadges({ conditions = null, snow = null, pax = 0, startHour = null, label = "", priorRides = null }) {
  // Priority order (max 4): the day's headline, then the personal ones, then weather/time.
  const b = [], d = conditions?.day;
  if ((conditions?.fresh48 ?? 0) >= 6 || (d?.snow ?? 0) >= 4) b.push({ icon: "❄️", text: "Powder Day" });
  if (priorRides === 0) b.push({ icon: "⭐", text: "First Timer" });
  else if (priorRides > 0) b.push({ icon: "🔁", text: `Ride #${priorRides + 1}` });
  if (pax >= 4) b.push({ icon: "🤘", text: `Crew of ${pax}` });
  if (d?.code != null && d.code <= 1) b.push({ icon: "☀️", text: "Bluebird" });
  if (d?.lo != null && d.lo <= 0) b.push({ icon: "🥶", text: "Below Zero" });
  if (/sunset/i.test(label)) b.push({ icon: "🌅", text: "Sunset Rider" });
  else if (startHour != null && startHour < 9) b.push({ icon: "🌄", text: "Early Riser" });
  if (snow?.depthIn >= 60) b.push({ icon: "🏔️", text: "Deep Base" });
  return b.slice(0, 4);
}

// ── HTML (email-safe: tables + inline styles) ────────────────────────────────
export function renderHeroModules({ hero, C, rea, bookLink }) {
  if (!hero) return "";
  const e = escapeHtml, out = [];
  const label = (t) => `<div style="font:700 13px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.muted};margin:0 0 10px">${t}</div>`;
  const big = (t, color = C.dark2) => `<div style="font:${rea ? "400 40px" : "700 32px"}/1 ${C.head};color:${color}">${t}</div>`;
  if (hero.badges?.length) {
    out.push(`<tr><td style="padding:20px 20px 0">` + hero.badges.map(x =>
      `<span style="display:inline-block;background:${C.soft};border:1px solid #DFE9F0;border-radius:999px;padding:8px 14px;margin:0 6px 8px 0;font:700 15px Arial,Helvetica,sans-serif;color:${C.dark2}">${x.icon} ${e(x.text)}</span>`).join("") + `</td></tr>`);
  }
  if (hero.sleds?.length) {
    const s = hero.sleds[0].sled, n = hero.sleds.reduce((t, x) => t + x.count, 0);
    out.push(`<tr><td style="padding:16px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.dark};border-radius:16px;padding:20px">` +
      `<div style="font:700 13px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc};margin:0 0 8px">${n > 1 ? `YOUR SLEDS · ${n}` : "YOUR SLED"}</div>` +
      `<div style="font:${rea ? "400 34px" : "700 26px"}/1.1 ${C.head};color:#FFFFFF">${e(s.name)}</div>` +
      `<div style="font:17px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3;margin-top:8px">${[s.engine ? `${e(s.engine)} engine` : "", s.trackIn ? `${s.trackIn}-inch track` : ""].filter(Boolean).join(" · ")}` +
      (s.note ? `<br>${e(s.note.charAt(0).toUpperCase() + s.note.slice(1))}.` : "") +
      (hero.sleds.length > 1 ? `<br>Also: ${hero.sleds.slice(1).map(x => `${x.count > 1 ? `${x.count}× ` : ""}${e(x.sled.name)}`).join(", ")}` : "") +
      `</div></td></tr></table></td></tr>`);
  }
  const snow = hero.snow;
  if (snow?.depthIn != null) {
    const max = Math.max(...snow.days.map(d => d.depthIn), 1);
    const bars = snow.days.map((d, i) => {
      const h = Math.max(6, Math.round((d.depthIn / max) * 70)), last = i === snow.days.length - 1;
      return `<td valign="bottom" align="center" style="padding:0 3px;width:${Math.floor(100 / snow.days.length)}%">` +
        `<div style="font:700 12px Arial,Helvetica,sans-serif;color:${last ? C.dark2 : C.muted};margin-bottom:4px">${d.depthIn}"</div>` +
        `<div style="height:${h}px;line-height:${h}px;font-size:1px;background:${last ? C.btn : "#BFD3E6"};border-radius:6px 6px 0 0">&nbsp;</div>` +
        `<div style="font:12px Arial,Helvetica,sans-serif;color:${C.muted};margin-top:4px">${e(d.label)}</div></td>`;
    }).join("");
    const facts = [snow.pctNormal ? `<b>${snow.pctNormal}%</b> of normal` : "", hero.fresh48 >= 1 ? `<b>+${Math.round(hero.fresh48)}"</b> fresh in 48 hrs` : ""].filter(Boolean).join(" · ");
    out.push(`<tr><td style="padding:16px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.soft};border:1px solid #DFE9F0;border-radius:16px;padding:20px">` +
      label(`SNOW REPORT${snow.station ? ` · ${e(snow.station.toUpperCase())}` : ""}`) + big(`${snow.depthIn}" on the ground`) +
      (facts ? `<div style="font:17px/1.5 Arial,Helvetica,sans-serif;color:${C.muted};margin-top:8px">${facts}</div>` : "") +
      (snow.days.length > 1 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>${bars}</tr></table>` : "") +
      `</td></tr></table></td></tr>`);
  }
  if (hero.powder && bookLink) {
    out.push(`<tr><td style="padding:16px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.dark2};border-radius:16px;padding:20px">` +
      `<div style="font:700 13px Arial,Helvetica,sans-serif;letter-spacing:2px;color:${C.acc};margin:0 0 8px">❄️ NEXT POWDER ALERT</div>` +
      `<div style="font:${rea ? "400 34px" : "700 26px"}/1.1 ${C.head};color:#FFFFFF">~${hero.powder.inches}" of new snow ${e(hero.powder.label)}</div>` +
      `<div style="font:17px/1.5 Arial,Helvetica,sans-serif;color:#C9D6E3;margin:8px 0 14px">Powder days fill up first. Grab your spot.</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-radius:12px;background:${C.btn}"><a href="${String(bookLink).replace(/&/g, "&amp;")}" style="display:block;padding:15px 18px;font:700 17px Arial,Helvetica,sans-serif;color:${C.btnTxt};text-decoration:none">Book the powder day</a></td></tr></table>` +
      `</td></tr></table></td></tr>`);
  }
  return out.join("");
}
