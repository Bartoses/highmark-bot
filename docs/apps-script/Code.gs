/**
 * Highmark sender — Google Apps Script client        (replaces "Real Send.gs" / "Test Email Send.gs")
 *
 * Your spreadsheet is no longer the list. Contacts, consent, unsubscribes and bounces live in the
 * Highmark database; this script only says WHAT to send and WHO (a segment). The server decides who is
 * actually allowed to receive it and refuses anyone who has unsubscribed, bounced, or never opted in.
 *
 * ONE-TIME SETUP
 *   1. Project Settings (gear icon) → Script properties → add:
 *        HIGHMARK_API_URL = https://highmark-bot-production.up.railway.app/api/v1
 *        HIGHMARK_API_KEY = <the OUTBOUND_API_KEY you set in Railway>
 *   2. Keep your newsletter HTML file (index_3.html). Delete any hand-made unsubscribe link in it —
 *      the server adds the legally-required footer (address + working unsubscribe) to every email.
 *   3. Run checkConnection() once and approve the permission prompt (it needs to call an external URL).
 *
 * EVERY SEND IS TWO STEPS ON PURPOSE
 *   previewNewsletter()      → dry run: shows exactly how many people would get it and why others are excluded
 *   sendNewsletterTest()     → sends ONE test copy to you
 *   sendNewsletter()         → the real send (asks you to confirm the count first)
 * Re-running sendNewsletter() with the same NEWSLETTER.id can never double-send.
 */

// ── EDIT THIS FOR EACH NEWSLETTER ────────────────────────────────────────────
var NEWSLETTER = {
  id: '2026-09-snow-report',                       // change for every new newsletter (this is the double-send guard)
  subject: 'Big Snow on the Way — Check the Steamboat Snow Report',
  previewText: 'Fresh snow is headed to Steamboat.',
  htmlFile: 'index_3',                             // the HTML file in this project (without .html)
  fromName: 'Colorado Sled Rentals',
  // Who gets it. Everything is optional; {} = everyone with explicit email consent.
  //   tags_any / tags_all / exclude_tags : e.g. ['waiver'], ['trailer_rental'], ['booked'], ['rzr']
  //   min_bookings, active_since ('2025-01-01'), sources
  //   include_grandfathered: true  → ALSO email older contacts who never actively opted in (use deliberately)
  segment: {}
};

// ── MENU (shows up in the spreadsheet) ───────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Highmark')
    .addItem('Check connection', 'checkConnection')
    .addItem('Preview newsletter audience', 'previewNewsletter')
    .addItem('Send me a test', 'sendNewsletterTest')
    .addItem('Send newsletter…', 'sendNewsletter')
    .addToUi();
}

// ── core ─────────────────────────────────────────────────────────────────────
function api_(method, path, body) {
  var props = PropertiesService.getScriptProperties();
  var base = props.getProperty('HIGHMARK_API_URL'), key = props.getProperty('HIGHMARK_API_KEY');
  if (!base || !key) throw new Error('Set HIGHMARK_API_URL and HIGHMARK_API_KEY in Project Settings → Script properties.');
  var res = UrlFetchApp.fetch(base + path, {
    method: method, contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
    payload: body ? JSON.stringify(body) : undefined, muteHttpExceptions: true
  });
  var code = res.getResponseCode(), json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* non-JSON error page */ }
  if (code >= 400) throw new Error('Highmark API ' + code + ': ' + (json.error || res.getContentText().slice(0, 200)));
  return json;
}
function html_() { return HtmlService.createHtmlOutputFromFile(NEWSLETTER.htmlFile).getContent(); }
function say_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }
function describe_(a) {
  var x = a.excluded || {};
  return a.eligible + ' people will receive it.\n\nNot receiving it: ' +
    (x.unsubscribed || 0) + ' unsubscribed, ' + (x.suppressed || 0) + ' bounced/complained, ' +
    (x.no_consent || 0) + ' never opted in, ' + (x.grandfathered || 0) + ' older contacts without explicit opt-in, ' +
    (x.not_in_segment || 0) + ' outside this segment.';
}

// ── newsletter ───────────────────────────────────────────────────────────────
function checkConnection() {
  var h = api_('GET', '/health');
  say_('Connected to ' + h.business + '.\nEmail configured: ' + h.email_configured + '\nMailing address set: ' + h.mailing_address_configured +
       '\nBounce/complaint webhook set: ' + h.webhook_secret_configured);
}

function previewNewsletter() {
  say_(describe_(api_('POST', '/email/audience', { segment: NEWSLETTER.segment })));
}

function sendNewsletterTest() {
  var me = Session.getActiveUser().getEmail();
  api_('POST', '/email/send', { subject: NEWSLETTER.subject, html: html_(), test_to: me, from_name: NEWSLETTER.fromName });
  say_('Test sent to ' + me + '. Check your inbox (and spam).');
}

function sendNewsletter() {
  var dry = api_('POST', '/email/send', { subject: NEWSLETTER.subject, html: html_(), segment: NEWSLETTER.segment });   // dry run (default)
  var ok = true;
  try {
    var ui = SpreadsheetApp.getUi();
    ok = ui.alert('Send "' + NEWSLETTER.subject + '"?', describe_(dry) + '\n\nThis cannot be undone.', ui.ButtonSet.YES_NO) === ui.Button.YES;
  } catch (e) { /* running from a trigger: no UI to confirm with */ }
  if (!ok) return;
  var r = api_('POST', '/email/send', {
    name: NEWSLETTER.id, subject: NEWSLETTER.subject, preview_text: NEWSLETTER.previewText,
    html: html_(), from_name: NEWSLETTER.fromName, segment: NEWSLETTER.segment,
    dry_run: false, idempotency_key: 'newsletter-' + NEWSLETTER.id,
    expected_recipients: dry.eligible                                   // refuses if the audience changed a lot between preview and send
  });
  say_(r.already_created ? 'This newsletter was already sent (campaign ' + r.campaign_id + '). Nothing new was sent.'
                         : 'Sending to ' + r.queued + ' people. Check progress with campaignStatus().');
  PropertiesService.getScriptProperties().setProperty('LAST_CAMPAIGN_ID', r.campaign_id);
}

function campaignStatus() {
  var id = PropertiesService.getScriptProperties().getProperty('LAST_CAMPAIGN_ID');
  var s = api_('GET', '/email/campaigns/' + id);
  say_(JSON.stringify(s.counts) + '  (of ' + s.total + ')');
}

// ── booking emails / texts (event-driven) ────────────────────────────────────
// Example: call this from your own trigger with a FareHarbor booking number, e.g. '#380089285'.
// Goes only to that booking's own guest — you cannot pass an address. Merge fields available:
//   {{first_name}} {{activity}} {{trip_date}} {{trip_time}} {{booking_pk}}
function sendBookingReminderEmail(bookingPk) {
  return api_('POST', '/email/transactional', {
    booking_pk: bookingPk,
    subject: 'Your {{activity}} trip is coming up',
    html: '<p>Hi {{first_name}},</p><p>Just a reminder: your <b>{{activity}}</b> is on {{trip_date}} at {{trip_time}}.</p><p>See you soon!</p>',
    dry_run: false,
    idempotency_key: 'reminder-' + bookingPk + '-' + Utilities.formatDate(new Date(), 'America/Denver', 'yyyy-MM-dd')   // once per booking per day
  });
}

function sendBookingReminderText(bookingPk) {
  return api_('POST', '/sms/transactional', {
    booking_pk: bookingPk,
    body: 'Hi {{first_name}}, reminder: your {{activity}} is {{trip_date}} at {{trip_time}}.',
    dry_run: false,
    idempotency_key: 'reminder-sms-' + bookingPk + '-' + Utilities.formatDate(new Date(), 'America/Denver', 'yyyy-MM-dd')
  });
}

// ── marketing text (explicit-consent people only; STOP line added automatically) ──
function previewTextBlast() {
  say_(JSON.stringify(api_('POST', '/sms/audience', { segment: {} }), null, 2));
}
function sendTextBlast() {
  var body = 'Big snow is on the way! Book your Steamboat sled trip: https://coloradosledrentals.com';
  var dry = api_('POST', '/sms/send', { body: body, segment: {} });
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Text ' + dry.eligible + ' people from ' + dry.from_number + '?', '"' + dry.message + '"', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var r = api_('POST', '/sms/send', { body: body, segment: {}, dry_run: false, idempotency_key: 'text-2026-09-snow', expected_recipients: dry.eligible });
  say_('Queued ' + r.queued + ' texts.');
}
