/**
 * RideRecap.gs — post-ride "Ride Recap" emails for CSR + Rabbit Ears Adventures.
 * DRAFT — add as a new file in the "CSR Emails" Apps Script project. Nothing runs until you call setupRecap().
 *
 * Flow (once a day at RECAP_SEND_HOUR, America/Denver):
 *   1. Pull today's finished bookings from Supabase (REST API).
 *   2. Keep only tour/rental items (fuel, trailers, add-ons skipped), one email per booking.
 *   3. Skip anyone on the Unsubscribe sheet, anyone without an email, anything already in "Recap Log".
 *   4. Find the guide's photo in Drive (folder per day), pull weather, fill the right template.
 *   5. Send from info@coloradosledrentals.com and log it. Anything odd goes to the "Recap Review" sheet instead.
 *
 * Script properties to add (Project Settings → Script properties):
 *   SUPABASE_URL            https://aiiguzslqiemksrvfvwk.supabase.co
 *   SUPABASE_SECRET_KEY     a NEW secret key just for this script (never paste it in chat or screenshots)
 *   RECAP_SEND_HOUR         18          (24h clock; change any time, then run setupRecap() again)
 *   RECAP_PHOTO_FOLDER_ID   Drive folder id of "Tour Photos" (subfolders named 2027-02-06, files named by tour, e.g. "Grand Tour 11am.jpg")
 *   RECAP_DRY_RUN           true        (true = every email goes to RECAP_TEST_TO instead of the guest)
 *   RECAP_TEST_TO           sean@coloradosledrentals.com
 *   RECAP_FEATURES          review,share,prints,merch,newsletter   (remove a word to hide that section)
 */

// ---------- 1. Settings you edit ----------
const RECAP = {
  sheetUrl: 'https://docs.google.com/spreadsheets/d/13B6cWD_ZvsGoE_bmS9YTn0NXQ8rHAgoi7nzCQ9jW-V4/edit',
  from: 'info@coloradosledrentals.com',
  // TODO: confirm table + column names in Supabase (Table Editor). These are guesses.
  table: 'bookings',
  cols: {
    id: 'booking_id', company: 'company', item: 'item_name', start: 'start_at', end: 'end_at',
    status: 'status', email: 'contact_email', name: 'contact_name', pax: 'pax', guide: 'guide_name', ref: 'ref'
  },
  referral: { friendCode: 'FRIEND10', percent: 10 },
  review: {
    csr: 'https://g.page/r/CfQGQSBK_KsOEAE/review', // TODO confirm which link is CSR vs REA
    rea: 'https://g.page/r/CfQGQSBK_KsOEAg/review'
  },
  book: {
    rea: 'https://fareharbor.com/embeds/book/rabbitearsadventures/?ref=followupemail&full-items=yes&flow=1491038',
    guided: 'https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes&flow=1262220',
    csr: 'https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes'
  },
  newsletter: 'https://coloradosledrentals.com/newsletter-signup/',
  weather: { lat: 40.53, lon: -106.68 }, // TODO: trailhead coordinates (North Routt)
  // Tour data. Fill miles/high point/stops as you get them; anything left blank simply doesn't show.
  // match = text that appears in the FareHarbor item name. type = which template.
  items: [
    { match: 'Grand Tour', type: 'rea', label: 'Grand Tour', miles: '', high: '', stops: [] },
    { match: 'First Tracks', type: 'rea', label: 'First Tracks', miles: '', high: '', stops: [] },
    { match: 'Tree Line', type: 'rea', label: 'Tree Line', miles: '', high: '', stops: [] },
    { match: 'Sunset Ride', type: 'rea', label: 'Sunset Ride', miles: '', high: '', stops: [] },
    { match: 'Rabbit Ears', type: 'rea', label: 'Rabbit Ears Tour', miles: '', high: '', stops: [] },
    { match: 'On-Trail Guided', type: 'rea', label: 'On-Trail Guided Tour', miles: '', high: '', stops: [] },
    { match: 'Backcountry', type: 'backcountry', label: 'Private Guided Backcountry' },
    { match: 'Polaris', type: 'rental', label: 'Polaris rental' }
    // Anything that matches nothing (Fuel, Trailer, gear, RZR...) is skipped.
  ]
};

// ---------- 2. Setup + entry points ----------
function setupRecap() {
  const hour = Number(prop_('RECAP_SEND_HOUR', '18'));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runDailyRecap')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runDailyRecap').timeBased().everyDays(1).atHour(hour)
    .inTimezone('America/Denver').create();
  ensureSheet_('Recap Log', ['Sent at', 'Booking ID', 'Email', 'Type', 'Photo', 'Weather', 'Dry run']);
  ensureSheet_('Recap Review', ['Found at', 'Booking ID', 'Email', 'Reason']);
  Logger.log('Ride Recap scheduled daily at ' + hour + ':00 Denver time.');
}

/** Run this by hand to preview today's emails without sending anything to guests. */
function previewTodayRecap() { runRecapFor_(new Date(), true); }

function runDailyRecap() { runRecapFor_(new Date(), prop_('RECAP_DRY_RUN', 'true') === 'true'); }

// ---------- 3. Main loop ----------
function runRecapFor_(day, dryRun) {
  const ss = SpreadsheetApp.openByUrl(RECAP.sheetUrl);
  const log = ss.getSheetByName('Recap Log');
  const review = ss.getSheetByName('Recap Review');
  const sentIds = new Set(colValues_(log, 2).map(String));
  const unsub = new Set(colValues_(ss.getSheetByName('Unsubscribe'), 1).map(e => String(e).toLowerCase().trim()));
  const features = prop_('RECAP_FEATURES', 'review,share,prints,merch,newsletter').split(',').map(s => s.trim());
  const weather = safe_(() => getWeather_(day), null);

  const bookings = fetchFinishedBookings_(day);
  const seen = new Set();
  let sent = 0;
  bookings.forEach(b => {
    const c = RECAP.cols;
    const id = String(b[c.id]);
    if (seen.has(id) || sentIds.has(id)) return;
    const tour = RECAP.items.find(i => String(b[c.item] || '').indexOf(i.match) !== -1);
    if (!tour) return; // fuel, trailer, add-on
    seen.add(id);
    const email = String(b[c.email] || '').toLowerCase().trim();
    if (!email || email.indexOf('@') === -1) return flag_(review, id, email, 'No email on booking');
    if (unsub.has(email)) return;

    const d = buildData_(b, tour, day, weather, features);
    try {
      const html = buildRecapHtml_(d);
      const opts = { from: RECAP.from, name: d.brandName, htmlBody: html, inlineImages: d.inline };
      const to = dryRun ? prop_('RECAP_TEST_TO', 'sean@coloradosledrentals.com') : email;
      GmailApp.sendEmail(to, (dryRun ? '[TEST] ' : '') + d.subject, d.plain, opts);
      log.appendRow([new Date(), id, email, tour.type, d.photo ? 'yes' : 'no', weather ? 'yes' : 'no', dryRun]);
      sent++;
    } catch (err) {
      flag_(review, id, email, 'Build/send error: ' + err.message);
    }
  });
  Logger.log('Ride Recap: ' + sent + ' sent' + (dryRun ? ' (dry run)' : '') + ' from ' + bookings.length + ' booking rows.');
}

// ---------- 4. Data ----------
function fetchFinishedBookings_(day) {
  const url = prop_('SUPABASE_URL'), key = prop_('SUPABASE_SECRET_KEY');
  const c = RECAP.cols;
  const startOfDay = Utilities.formatDate(day, 'America/Denver', "yyyy-MM-dd'T'00:00:00XXX");
  const now = Utilities.formatDate(new Date(), 'America/Denver', "yyyy-MM-dd'T'HH:mm:ssXXX");
  const q = [
    'select=*',
    c.end + '=gte.' + encodeURIComponent(startOfDay),
    c.end + '=lte.' + encodeURIComponent(now),
    c.status + '=neq.cancelled' // TODO match how cancellations are stored
  ].join('&');
  const res = UrlFetchApp.fetch(url + '/rest/v1/' + RECAP.table + '?' + q, {
    headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Supabase ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function buildData_(b, tour, day, weather, features) {
  const c = RECAP.cols;
  const isRea = tour.type === 'rea';
  const first = String(b[c.name] || '').trim().split(/\s+/)[0] || '';
  const firstOk = /^[A-Za-z][A-Za-z'\-]{1,20}$/.test(first) ? cap_(first) : '';
  const guide = String(b[c.guide] || '').trim();
  const dateLong = Utilities.formatDate(day, 'America/Denver', 'EEE · MMM d').toUpperCase();
  const dateShort = Utilities.formatDate(day, 'America/Denver', 'MM.dd.yy');
  const photo = safe_(() => findPhoto_(day, tour.label), null);
  const inline = {};
  if (photo) inline.ridephoto = photo;

  const stats = [];
  if (tour.miles) stats.push([tour.miles + ' mi', 'on the ' + tour.label]);
  if (tour.high) stats.push([tour.high + ' ft', 'highest point']);
  const hrs = hoursBetween_(b[c.start], b[c.end]);
  if (hrs) stats.push([hrs, isRea || tour.type === 'backcountry' ? 'on the snow' : 'on your sleds']);
  if (b[c.pax]) stats.push([String(b[c.pax]), Number(b[c.pax]) === 1 ? 'rider' : 'riders in your group']);

  const brand = isRea ? 'rea' : 'csr';
  const place = { rea: 'tour', backcountry: 'backcountry day', rental: 'rental' }[tour.type];
  const h1 = {
    rea: firstOk ? firstOk + ', that’s a memory in the making.' : 'That’s a memory in the making.',
    backcountry: firstOk ? firstOk + ', you went deep into the backcountry.' : 'Thanks for riding the backcountry with us.',
    rental: firstOk ? firstOk + ', thanks for riding with CSR.' : 'Thanks for riding with CSR.'
  }[tour.type];
  const sub = {
    rea: 'Your ' + tour.label + ' through North Routt’s meadows and forest trails' + (guide ? ' with guide ' + guide : '') + '.',
    backcountry: 'A day off the groomers' + (guide ? ' with guide ' + guide : ' with a local guide') + '.',
    rental: 'Brand-new Polaris sleds and a day on your own terms.'
  }[tour.type];

  return {
    id: String(b[c.id]), type: tour.type, brand: brand, brandName: isRea ? 'Rabbit Ears Adventures' : 'Colorado Sled Rentals',
    kicker: dateLong + ' · ' + tour.label.toUpperCase(), h1: h1, sub: sub, photo: !!photo, inline: inline,
    stats: stats.slice(0, 4), stops: tour.stops || [], weather: weather, place: place, features: features,
    merchLine: [tour.label, dateShort, tour.miles ? tour.miles + ' mi' : ''].filter(String).join(' · '),
    bookUrl: isRea ? RECAP.book.rea : RECAP.book.guided,
    nextTitle: { rea: 'Come back for sunset', backcountry: 'Chase the next storm', rental: 'Want a guide next time?' }[tour.type],
    nextBody: { rea: 'The 3-Hour Sunset Ride shows the mountains in a whole new light.', backcountry: 'Big storm days fill up first. Book your next backcountry day early.', rental: 'Ride the deep stuff with a local guide, or bring the family to Rabbit Ears Adventures.' }[tour.type],
    nextCta: { rea: 'Book a sunset ride', backcountry: 'Book your next ride', rental: 'See guided tours' }[tour.type],
    subject: { rea: 'Your Rabbit Ears tour recap', backcountry: 'Your backcountry day, recapped', rental: 'Thanks for riding with CSR' }[tour.type] + (firstOk ? ', ' + firstOk : ''),
    plain: h1 + '\n\n' + sub + '\n\nLeave us a Google review: ' + RECAP.review[brand] +
      '\n\nShare code ' + RECAP.referral.friendCode + ' — friends save ' + RECAP.referral.percent + '% at checkout.\n\nBook again: ' +
      (isRea ? RECAP.book.rea : RECAP.book.guided) + '\n\nUnsubscribe: reply STOP or use the link in the email.'
  };
}

function findPhoto_(day, label) {
  const folderId = prop_('RECAP_PHOTO_FOLDER_ID', '');
  if (!folderId) return null;
  const dayName = Utilities.formatDate(day, 'America/Denver', 'yyyy-MM-dd');
  const sub = DriveApp.getFolderById(folderId).getFoldersByName(dayName);
  if (!sub.hasNext()) return null;
  const files = sub.next().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType().indexOf('image/') === 0 && f.getName().toLowerCase().indexOf(label.toLowerCase().split(' ')[0]) !== -1) {
      return f.getBlob().setName('ridephoto');
    }
  }
  return null;
}

function getWeather_(day) {
  const d = Utilities.formatDate(day, 'America/Denver', 'yyyy-MM-dd');
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + RECAP.weather.lat + '&longitude=' + RECAP.weather.lon +
    '&daily=snowfall_sum,temperature_2m_max,weathercode&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America%2FDenver&start_date=' + d + '&end_date=' + d;
  const j = JSON.parse(UrlFetchApp.fetch(u).getContentText()).daily;
  const code = j.weathercode[0];
  const sky = code === 0 ? 'Bluebird' : code <= 3 ? 'Partly cloudy' : code >= 71 && code <= 86 ? 'Snowing' : 'Cloudy';
  const out = [];
  if (j.snowfall_sum[0] > 0) out.push(['SNOW', Math.round(j.snowfall_sum[0]) + ' in']);
  out.push(['HIGH', Math.round(j.temperature_2m_max[0]) + '°F']);
  out.push(['SKY', sky]);
  return out;
}

// ---------- 5. Email HTML (table-based so it works in Gmail, Outlook and Apple Mail) ----------
function buildRecapHtml_(d) {
  const rea = d.brand === 'rea';
  const C = rea
    ? { dark: '#0E131B', dark2: '#161D27', btn: '#F99E16', btnTxt: '#0E131B', acc: '#00B4E6', soft: '#F2FAFD', muted: '#3F4A57', head: "'Bebas Neue',Impact,Arial,sans-serif", up: 'uppercase', logo: 'https://static.wixstatic.com/media/cd57db_5feb2c095c6d4ecabd4ef46c6868f8c9~mv2.png', logoH: 32, headBg: '#0E131B' }
    : { dark: '#06121F', dark2: '#0B2D4F', btn: '#1670C2', btnTxt: '#FFFFFF', acc: '#D9A24E', soft: '#F3F9FC', muted: '#41505F', head: 'Roboto,Arial,sans-serif', up: 'none', logo: 'https://coloradosledrentals.com/wp-content/uploads/sites/5969/2022/11/logo-csr.png', logoH: 40, headBg: '#FFFFFF' };
  const has = f => d.features.indexOf(f) !== -1;
  const link = (base, content) => {
    const sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'utm_source=ride_recap&utm_medium=email&utm_campaign=' + d.type + '&utm_content=' + content;
  };
  const btn = (text, href, primary) => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:12px;background:' + (primary === false ? '#FFFFFF' : C.btn) + ';' + (primary === false ? 'border:2px solid ' + C.dark2 + ';' : '') + '"><a href="' + href + '" style="display:block;padding:15px 18px;font:700 16px/20px Arial,sans-serif;color:' + (primary === false ? C.dark2 : C.btnTxt) + ';text-decoration:none">' + text + '</a></td></tr></table>';
  const h2 = t => '<div style="font:' + (rea ? '400 28px' : '700 24px') + '/1.1 ' + C.head + ';text-transform:' + C.up + ';color:' + C.dark2 + ';margin:0 0 10px">' + t + '</div>';
  const p = t => '<div style="font:16px/1.5 Arial,sans-serif;color:' + C.muted + ';margin:0 0 14px">' + t + '</div>';
  const block = inner => '<tr><td style="padding:24px 20px 0">' + inner + '</td></tr>';
  const card = (inner, bg, border) => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:20px;border-radius:16px;background:' + (bg || '#FFFFFF') + ';' + (border ? 'border:' + border + ';' : '') + '">' + inner + '</td></tr></table>';

  let rows = '';
  // Header + hero
  rows += '<tr><td style="background:' + C.headBg + ';padding:14px 20px;border-bottom:1px solid #DFE9F0"><img src="' + C.logo + '" height="' + C.logoH + '" alt="' + d.brandName + '" style="display:block;border:0"></td></tr>';
  rows += '<tr><td style="background:' + C.dark + ';padding:28px 20px 24px;color:#FFFFFF">' +
    '<div style="font:700 12px/1.4 Arial,sans-serif;letter-spacing:2px;color:' + C.acc + '">' + d.kicker + '</div>' +
    '<div style="font:' + (rea ? '400 44px' : '700 30px') + '/1.05 ' + C.head + ';text-transform:' + C.up + ';margin:10px 0">' + d.h1 + '</div>' +
    '<div style="font:16px/1.5 Arial,sans-serif;color:#C9D6E3">' + d.sub + '</div>' +
    (d.photo ? '<img src="cid:ridephoto" width="560" alt="Photo from your ride" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;margin-top:16px">' : '') +
    '</td></tr>';
  // Stats (2 per row)
  if (d.stats.length) {
    let s = '';
    for (let i = 0; i < d.stats.length; i += 2) {
      s += '<tr>' + [d.stats[i], d.stats[i + 1]].map(x => x
        ? '<td width="50%" style="padding:5px"><div style="background:' + C.soft + ';border:1px solid #DFE9F0;border-radius:12px;padding:14px 16px"><div style="font:' + (rea ? '400 30px' : '700 26px') + '/1 ' + C.head + ';color:' + C.dark2 + '">' + x[0] + '</div><div style="font:13px/1.3 Arial,sans-serif;color:' + C.muted + ';margin-top:4px">' + x[1] + '</div></div></td>'
        : '<td width="50%"></td>').join('') + '</tr>';
    }
    rows += '<tr><td style="padding:18px 15px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + s + '</table></td></tr>';
  }
  if (d.stops.length) rows += block('<div style="font:700 12px Arial,sans-serif;letter-spacing:2px;color:' + C.muted + ';margin-bottom:8px">STOPS ON YOUR LOOP</div>' + d.stops.map((s, i) => '<div style="font:16px/1.6 Arial,sans-serif;color:' + C.dark2 + '"><b>' + (i + 1) + '.</b> ' + s + '</div>').join(''));
  if (d.weather) rows += '<tr><td style="padding:12px 20px 0;font:14px Arial,sans-serif;color:' + C.muted + '">' + d.weather.map(w => '<span style="display:inline-block;background:' + C.dark2 + ';color:#FFFFFF;border-radius:999px;padding:7px 12px;margin:0 6px 6px 0"><span style="font-size:11px;color:#9FB3C8;font-weight:700">' + w[0] + '</span> <b>' + w[1] + '</b></span>').join('') + '</td></tr>';
  // Review (everyone sees both options — no review gating)
  if (has('review')) rows += block(card('<div style="font-size:20px;color:#F5B301;letter-spacing:2px;margin-bottom:8px">★★★★★</div>' + h2('How was your ' + d.place + '?') +
    p('If you had a great time, a quick Google review helps our small local team more than anything. It takes about a minute.') +
    btn('Leave a Google review', link(RECAP.review[d.brand], 'google-review')) +
    '<div style="text-align:center;padding:12px 0 0"><a href="mailto:info@coloradosledrentals.com?subject=Feedback%20on%20my%20ride" style="font:700 15px Arial,sans-serif;color:#1670C2">Something not right? Tell us directly</a></div>', '#FFFFFF', '2px solid ' + C.dark2));
  // Share / referral
  if (has('share')) rows += block(card('<div style="font:700 12px Arial,sans-serif;letter-spacing:2px;color:' + C.acc + ';margin-bottom:8px">GIVE ' + RECAP.referral.percent + '%, GET ' + RECAP.referral.percent + '%</div>' +
    '<div style="font:' + (rea ? '400 28px' : '700 24px') + '/1.1 ' + C.head + ';text-transform:' + C.up + ';color:#FFFFFF;margin-bottom:10px">Bring a friend next time</div>' +
    '<div style="font:16px/1.5 Arial,sans-serif;color:#C9D6E3;margin-bottom:14px">Friends save ' + RECAP.referral.percent + '% with this code at checkout. When they ride, you get ' + RECAP.referral.percent + '% off your next booking.</div>' +
    '<div style="border:2px dashed ' + C.acc + ';border-radius:12px;text-align:center;font:700 24px Courier New,monospace;letter-spacing:3px;color:#FFFFFF;padding:12px 0;margin-bottom:14px">' + RECAP.referral.friendCode + '</div>' +
    btn('Text it to a friend', 'sms:?&body=' + encodeURIComponent('You have to try ' + d.brandName + '! Use code ' + RECAP.referral.friendCode + ' for ' + RECAP.referral.percent + '% off: ' + link(d.bookUrl.replace('ref=followupemail', 'ref=friend-' + d.id), 'share-sms'))) +
    '<div style="height:10px"></div>' +
    btn('Email it to a friend', 'mailto:?subject=' + encodeURIComponent(RECAP.referral.percent + '% off ' + d.brandName) + '&body=' + encodeURIComponent('Use code ' + RECAP.referral.friendCode + ' at checkout: ' + link(d.bookUrl.replace('ref=followupemail', 'ref=friend-' + d.id), 'share-email')), false), C.dark));
  // Take it home
  if (has('prints') && d.photo) rows += block(h2('Keep the moment') + p('Your framed tour photo is 2 for $25. The digital copy is attached above — save it to your phone.') + btn('Order more prints', link(RECAP.book.csr, 'order-prints'), false));
  if (has('merch')) rows += block(h2('Wear the memory') + p('A hoodie printed with ' + d.merchLine + '. Made to order.') + btn('Shop hoodies, hats &amp; stickers', link('https://coloradosledrentals.com/', 'merch'), false));
  // Next ride + newsletter
  rows += block(card(h2(d.nextTitle) + p(d.nextBody) + btn(d.nextCta, link(d.bookUrl, 'book-next')), C.soft, '1px solid #DFE9F0'));
  if (has('newsletter')) rows += block('<div style="font:700 17px Arial,sans-serif;color:' + C.dark2 + ';margin-bottom:6px">Get first dibs on powder days</div>' + p('Storm alerts, new adventures and seasonal deals.') + btn('Join the newsletter', link(RECAP.newsletter, 'newsletter'), false));
  // Footer (CAN-SPAM: address + unsubscribe)
  rows += '<tr><td style="padding:28px 20px;font:13px/1.6 Arial,sans-serif;color:' + C.muted + ';text-align:center">' +
    (rea ? 'Rabbit Ears Adventures · 4492 Hwy 14, Walden, CO 80480<br>A Colorado Sled Rentals company' : 'Colorado Sled Rentals · 2151 Downhill Drive, Steamboat Springs, CO 80487') +
    '<br>(970) 439-1707 · @coloradosledrentals<br><a href="mailto:info@coloradosledrentals.com?subject=Unsubscribe" style="color:#1670C2">Unsubscribe</a></td></tr>';

  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>' +
    '<body style="margin:0;background:#EEF2F5"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F5"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF">' + rows + '</table></td></tr></table></body></html>';
}

// ---------- 6. Helpers ----------
function prop_(k, dflt) { const v = PropertiesService.getScriptProperties().getProperty(k); return v === null || v === '' ? dflt : v; }
function safe_(fn, dflt) { try { return fn(); } catch (e) { Logger.log(e.message); return dflt; } }
function cap_(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
function colValues_(sheet, col) { if (!sheet || sheet.getLastRow() < 2) return []; return sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().flat().filter(String); }
function ensureSheet_(name, header) { const ss = SpreadsheetApp.openByUrl(RECAP.sheetUrl); if (!ss.getSheetByName(name)) ss.insertSheet(name).appendRow(header); }
function flag_(sheet, id, email, reason) { sheet.appendRow([new Date(), id, email, reason]); }
function hoursBetween_(a, b) {
  if (!a || !b) return '';
  const h = (new Date(b) - new Date(a)) / 36e5;
  if (!(h > 0)) return '';
  return h >= 7 ? 'Full day' : (Math.round(h * 2) / 2) + ' hrs';
}
