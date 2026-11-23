// npm run recap:preview -- [--template=simple|v1] [--booking=<FareHarbor booking id>] [--case=<name>,…] [--photo] [--no-send]
//
// Writes the rendered recap(s) to tmp/recap-preview/*.html and sends each as a "[TEST]" email to recap_settings.test_to ONLY
// (queued like a dry-run recap; the Apps Script drainQueue delivers it within 10 min). Never emails a guest.
//   --booking=392519085   render that real booking (read-only lookup in DB2) with the chosen template
//   --case=a,b            without --booking: which fixed sample cases to render/send (default: all of them)
//   --photo               booking mode: show the sample ride photo (real photos come from Drive at send time)
//   --no-send             only write the HTML files
// Needs CRM_SUPABASE_URL / CRM_SUPABASE_KEY (cloud sessions: run with NODE_USE_ENV_PROXY=1; the proxy supplies the key).
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import {
  loadRecapSettings, loadRecapTours, bookingFacts, matchTour, buildTripDetails, buildRecapData, renderRideRecap, queueRecapEmail,
  sampleRecapRenders, applyPhotoMarkers, weatherPointFor, localDate,
} from "../rideRecap.js";
import { buildSimpleRecapData, renderSimpleRecap, sampleSimpleRenders, applyHostedPhotos, fetchNextStorm, normalizeTemplate, SAMPLE_PHOTOS } from "../recapSimple.js";

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const template = normalizeTemplate(args.template ?? "simple");
const outDir = path.resolve("tmp/recap-preview");
fs.mkdirSync(outDir, { recursive: true });

const crm = process.env.CRM_SUPABASE_URL ? createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY || "placeholder") : null;
const send = !args["no-send"];
if (send && !crm) { console.error("CRM_SUPABASE_URL not set — use --no-send to only write files"); process.exit(1); }

async function main() {
  const settings = crm && (send || args.booking) ? await loadRecapSettings(crm, "csr_rea") : null;
  if (send && !settings?.test_to) throw new Error("recap_settings.test_to missing — refusing to send");
  const renders = [];   // { name, subject, html, text, fromName }

  if (args.booking) {
    const pk = `#${String(args.booking).replace(/^#/, "")}`;
    const { data: row, error } = await crm.from("bookings")
      .select("fareharbor_pk, company, status, start_at, end_at, customer_count, guide_name, product_title, updated_at, raw_payload").eq("fareharbor_pk", pk).limit(1).maybeSingle();
    if (error || !row) throw new Error(`booking ${pk} not found${error ? `: ${error.message}` : ""}`);
    const f = bookingFacts(row);
    const tour = matchTour(f.item, await loadRecapTours(crm, "csr_rea"));
    if (!tour) throw new Error(`"${f.item}" is not a recap item (no recap_tours match)`);
    const trip = buildTripDetails({ booking: f, tour });
    let msg;
    if (template === "simple") {
      const pt = weatherPointFor({ item: f.item, type: tour.type }, settings);
      const nextStorm = tour.type !== "rea" && pt ? await fetchNextStorm({ lat: pt.lat, lon: pt.lon, fromYmd: localDate(new Date()) }) : null;
      msg = renderSimpleRecap(buildSimpleRecapData({ booking: f, tour, trip, settings, nextStorm }));
      msg.html = applyHostedPhotos(msg.html, args.photo ? SAMPLE_PHOTOS : null);
    } else {
      msg = renderRideRecap(buildRecapData({ booking: f, tour, trip, settings }));
      msg.html = applyPhotoMarkers(msg.html, false);
    }
    renders.push({ name: `${pk.slice(1)}-${template}`, ...msg });
  } else {
    const wanted = args.case ? String(args.case).split(",").map(s => s.trim()) : null;
    if (template === "simple") {
      for (const [name, { data, photos }] of Object.entries(sampleSimpleRenders())) {
        if (wanted && !wanted.includes(name)) continue;
        const msg = renderSimpleRecap(data);
        renders.push({ name, ...msg, html: applyHostedPhotos(msg.html, photos) });
      }
    } else {
      for (const [name, data] of Object.entries(sampleRecapRenders())) {
        if (wanted && !wanted.includes(name)) continue;
        const msg = renderRideRecap(data);
        renders.push({ name, ...msg, html: applyPhotoMarkers(msg.html, false) });
      }
    }
  }

  const stamp = Date.now();
  for (const r of renders) {
    const file = path.join(outDir, `${r.name}.html`);
    fs.writeFileSync(file, r.html);
    let line = `wrote ${path.relative(process.cwd(), file)}`;
    if (send) {
      const q = await queueRecapEmail(crm, {
        clientId: "csr_rea", to: settings.test_to, subject: `${r.subject} (preview: ${r.name})`, html: r.html, text: r.text, fromName: r.fromName,
        photoHint: null, reference: `preview-${r.name}`, idempotencyKey: `recap-preview-${r.name}-${stamp}`, dryRun: true,
      });
      line += ` · [TEST] queued to ${settings.test_to} (send ${q.row.id})`;
    }
    console.log(line);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
