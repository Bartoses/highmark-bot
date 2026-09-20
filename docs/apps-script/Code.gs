/**
 * Highmark sender — Google Apps Script client        (replaces "Real Send.gs" / "Test Email Send.gs")
 *
 * WHAT THIS DOES
 *   The Highmark database is now the list. It decides who may be emailed (only people who opted in; never anyone who
 *   unsubscribed or bounced), writes each email (your newsletter + a legally-required footer with your address and a
 *   working unsubscribe link) and records what happened. THIS script only delivers the messages, through YOUR Gmail, as
 *   info@coloradosledrentals.com — so it needs no DNS changes and nothing from FareHarbor.
 *
 * ONE-TIME SETUP
 *   1. Project Settings (gear icon) → Script properties → add:
 *        HIGHMARK_API_URL = https://highmark-bot-production.up.railway.app/api/v1
 *        HIGHMARK_API_KEY = <the OUTBOUND_API_KEY from Railway → highmark-bot → Variables>
 *   2. Keep your newsletter HTML file (index_3.html). Delete any hand-made unsubscribe link in it — the footer is added for you.
 *   3. Run checkConnection() once and approve the permission prompts (Gmail + external requests).
 *
 * SENDING A NEWSLETTER (menu: Highmark)
 *   Preview audience → Send me a test → Send newsletter…
 *   Gmail limits how many people you can email per day (about 100 on a free account, ~1,500 on Google Workspace). If the list is
 *   bigger than today's allowance, the rest goes out automatically each morning until it's done — nothing else to do.
 *   Re-running with the same NEWSLETTER.id can never double-send.
 *
 * All helper functions are prefixed "hm" so they can't collide with the other files in your project.
 */

// ── EDIT THIS FOR EACH NEWSLETTER ────────────────────────────────────────────
var NEWSLETTER = {
  id: '2026-09-snow-report',                       // change for every new newsletter (this is the double-send guard)
  subject: 'Big Snow on the Way — Check the Steamboat Snow Report',
  previewText: 'Fresh snow is headed to Steamboat.',
  htmlFile: 'index_3',                             // the HTML file in this project (without .html)
  // Who gets it. Everything is optional; {} = everyone with explicit email consent.
  //   tags_any / tags_all / exclude_tags : e.g. ['waiver'], ['trailer_rental'], ['booked'], ['rzr']
  //   min_bookings, active_since ('2025-01-01'), sources
  //   include_grandfathered: true  → ALSO email older contacts who never actively opted in (use deliberately)
  segment: {}
};

// ── YOUR SENDER (must already be a "Send mail as" address in Gmail settings → Accounts) ──
var SEND_AS      = 'info@coloradosledrentals.com';
var SENDER_NAME  = 'Colorado Sled Rentals';
var REPLY_TO     = 'info@coloradosledrentals.com';
var QUOTA_RESERVE = 5;                             // keep a few sends of today's quota free for your normal email

// ── MENU (shows up in the spreadsheet) ───────────────────────────────────────
// NOTE: Apps Script allows only ONE onOpen() per project. If another file of yours already defines onOpen(),
// delete this one and add the createMenu(...) lines below into yours.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Highmark')
    .addItem('Check connection', 'checkConnection')
    .addItem('Preview newsletter audience', 'previewNewsletter')
    .addItem('Send me a test', 'sendNewsletterTest')
    .addItem('Send newsletter…', 'sendNewsletter')
    .addSeparator()
    .addItem('Send today\'s batch now', 'continueSending')
    .addItem('Sending status', 'campaignStatus')
    .addItem('Check for bounced addresses', 'checkBounces')
    .addToUi();
}

// ── core ─────────────────────────────────────────────────────────────────────
function hmApi_(method, path, body) {
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
function hmHtml_() { return HtmlService.createHtmlOutputFromFile(NEWSLETTER.htmlFile).getContent(); }
function hmSay_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }
function hmMe_() { return Session.getEffectiveUser().getEmail(); }
function hmDescribe_(a) {
  var x = a.excluded || {};
  return a.eligible + ' people will receive it.\n\nNot receiving it: ' +
    (x.unsubscribed || 0) + ' unsubscribed, ' + (x.suppressed || 0) + ' bounced/complained, ' +
    (x.no_consent || 0) + ' never opted in, ' + (x.grandfathered || 0) + ' older contacts without explicit opt-in, ' +
    (x.not_in_segment || 0) + ' outside this segment.';
}

// Refuse to send if the sender isn't a verified Gmail "Send mail as" address (otherwise Gmail would send as someone else).
function hmAssertSender_() {
  var ok = hmMe_().toLowerCase() === SEND_AS.toLowerCase() ||
           GmailApp.getAliases().map(function (a) { return a.toLowerCase(); }).indexOf(SEND_AS.toLowerCase()) !== -1;
  if (!ok) throw new Error(SEND_AS + ' is not set up as a "Send mail as" address in this Gmail account (Gmail → Settings → Accounts).');
}
function hmSendOne_(m) {
  GmailApp.sendEmail(m.to, m.subject, m.text || '', { htmlBody: m.html, from: SEND_AS, name: SENDER_NAME, replyTo: m.reply_to || REPLY_TO });
}

// Sends rendered messages through Gmail, then reports each result to Highmark. Returns {sent, failed, deferred}.
function hmSendMessages_(messages) {
  hmAssertSender_();
  var results = [], sent = 0, failed = 0, deferred = 0, outOfQuota = false;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (outOfQuota || MailApp.getRemainingDailyQuota() <= 0) { outOfQuota = true; results.push({ send_id: m.send_id, deferred: true }); deferred++; continue; }
    try { hmSendOne_(m); results.push({ send_id: m.send_id, ok: true }); sent++; }
    catch (e) {
      var msg = String((e && e.message) || e);
      if (/too many times|quota|limit exceeded|service invoked/i.test(msg)) { outOfQuota = true; results.push({ send_id: m.send_id, deferred: true }); deferred++; }
      else { results.push({ send_id: m.send_id, ok: false, error: msg }); failed++; }
    }
    if (results.length >= 10) { hmApi_('POST', '/email/report', { results: results }); results = []; }   // report often: a crash can't lose much
    Utilities.sleep(150);
  }
  if (results.length) hmApi_('POST', '/email/report', { results: results });
  return { sent: sent, failed: failed, deferred: deferred };
}

// Sends as much of the current campaign as today's Gmail quota allows. Returns {sent, failed, remaining}.
function hmDrain_() {
  var id = PropertiesService.getScriptProperties().getProperty('LAST_CAMPAIGN_ID');
  if (!id) return { sent: 0, failed: 0, remaining: 0 };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('A send is already running — try again in a minute.');
  try {
    var sent = 0, failed = 0, remaining = 0;
    for (var guard = 0; guard < 60; guard++) {
      var quota = MailApp.getRemainingDailyQuota() - QUOTA_RESERVE;
      var r = hmApi_('POST', '/email/pull', { campaign_id: id, limit: Math.max(0, Math.min(20, quota)) });
      remaining = r.remaining;
      if (r.blocked) throw new Error('Highmark is holding this send: ' + r.blocked + (r.blocked === 'no_mailing_address' ? ' (set MAILING_ADDRESS in Railway).' : ''));
      if (!r.messages.length) break;
      var s = hmSendMessages_(r.messages);
      sent += s.sent; failed += s.failed;
      if (s.deferred) break;
    }
    return { sent: sent, failed: failed, remaining: remaining };
  } finally { lock.releaseLock(); }
}

// ── newsletter ───────────────────────────────────────────────────────────────
function checkConnection() {
  var h = hmApi_('GET', '/health');
  var senderOk = true; try { hmAssertSender_(); } catch (e) { senderOk = false; }
  hmSay_('Connected to ' + h.business + '.\nMailing address set: ' + h.mailing_address_configured +
         '\nGmail can send as ' + SEND_AS + ': ' + senderOk +
         '\nEmails you can still send today: ' + MailApp.getRemainingDailyQuota() +
         '\n(Anything above that goes out automatically over the next days.)');
}

function previewNewsletter() {
  hmSay_(hmDescribe_(hmApi_('POST', '/email/audience', { segment: NEWSLETTER.segment })));
}

function sendNewsletterTest() {
  hmAssertSender_();
  var p = hmApi_('POST', '/email/preview', { subject: NEWSLETTER.subject, html: hmHtml_(), preview_text: NEWSLETTER.previewText });
  var me = hmMe_();
  GmailApp.sendEmail(me, p.subject, p.text || '', { htmlBody: p.html, from: SEND_AS, name: SENDER_NAME, replyTo: REPLY_TO });
  hmSay_('Test sent to ' + me + '. Check your inbox (and spam). The unsubscribe link in a test is a placeholder.');
}

function sendNewsletter() {
  hmAssertSender_();
  var dry = hmApi_('POST', '/email/send', { subject: NEWSLETTER.subject, html: hmHtml_(), segment: NEWSLETTER.segment, transport: 'gmail' });   // dry run (default)
  var quota = MailApp.getRemainingDailyQuota() - QUOTA_RESERVE;
  var ok = true;
  try {
    var ui = SpreadsheetApp.getUi();
    var days = Math.max(1, Math.ceil(dry.eligible / Math.max(1, quota)));
    ok = ui.alert('Send "' + NEWSLETTER.subject + '"?',
      hmDescribe_(dry) + '\n\nToday\'s Gmail allowance: about ' + quota + ' emails' +
      (dry.eligible > quota ? ' — so this will finish over about ' + days + ' days automatically.' : ' — it all goes out today.') +
      '\n\nThis cannot be undone.', ui.ButtonSet.YES_NO) === ui.Button.YES;
  } catch (e) { /* running from a trigger: no UI to confirm with */ }
  if (!ok) return;

  var r = hmApi_('POST', '/email/send', {
    name: NEWSLETTER.id, subject: NEWSLETTER.subject, preview_text: NEWSLETTER.previewText, html: hmHtml_(),
    from_name: SENDER_NAME, reply_to: REPLY_TO, segment: NEWSLETTER.segment, transport: 'gmail',
    dry_run: false, idempotency_key: 'newsletter-' + NEWSLETTER.id,
    expected_recipients: dry.eligible                                   // refuses if the audience changed a lot between preview and send
  });
  PropertiesService.getScriptProperties().setProperty('LAST_CAMPAIGN_ID', r.campaign_id);
  if (r.already_created) { hmSay_('This newsletter was already created (campaign ' + r.campaign_id + '). Nothing new was queued.'); }

  var d = hmDrain_();
  if (d.remaining > 0) { hmEnsureTrigger_('continueSending', 8); hmEnsureTrigger_('checkBounces', 10); }
  hmSay_('Sent ' + d.sent + ' now' + (d.failed ? ' (' + d.failed + ' failed)' : '') + '. ' +
         (d.remaining > 0 ? d.remaining + ' more will go out automatically each morning until finished.' : 'That\'s everyone.'));
}

// Runs every morning (a trigger is created for you) until the campaign is finished. Safe to run by hand too.
function continueSending() {
  var d = hmDrain_();
  if (d.remaining === 0) hmRemoveTrigger_('continueSending');
  hmSay_('Sent ' + d.sent + ' today' + (d.failed ? ' (' + d.failed + ' failed)' : '') + '. ' + d.remaining + ' still waiting.');
}

function campaignStatus() {
  var id = PropertiesService.getScriptProperties().getProperty('LAST_CAMPAIGN_ID');
  if (!id) { hmSay_('No newsletter has been started from this script yet.'); return; }
  var s = hmApi_('GET', '/email/campaigns/' + id);
  hmSay_(JSON.stringify(s.counts) + '  (of ' + s.total + ')');
}

// ── bounces ──────────────────────────────────────────────────────────────────
// Gmail can't tell us about bounces by itself, so this reads the delivery-failure notices that land in your inbox and tells
// Highmark which addresses are dead, so they're never emailed again (protects your sender reputation).
function checkBounces() {
  var label = GmailApp.getUserLabelByName('hm-bounce-done') || GmailApp.createLabel('hm-bounce-done');
  var threads = GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:14d -label:hm-bounce-done', 0, 50);
  var mine = [SEND_AS.toLowerCase(), hmMe_().toLowerCase()], found = {};
  var permanent = /couldn.?t be found|does not exist|user unknown|no such user|address not found|unable to receive|550[ -]5\.1\.1|recipient address rejected/i;
  var re = /(?:wasn't delivered to|Final-Recipient: rfc822;|failed permanently:?)\s*<?([A-Z0-9._%+'\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})>?/gi;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var body = m.getPlainBody(), match;
      if (!permanent.test(body)) return;
      re.lastIndex = 0;
      while ((match = re.exec(body)) !== null) { var a = match[1].toLowerCase(); if (mine.indexOf(a) === -1) found[a] = true; }
    });
    t.addLabel(label);
  });
  var emails = Object.keys(found), r = { suppressed: 0 };
  if (emails.length) r = hmApi_('POST', '/email/bounces', { emails: emails });
  Logger.log('Bounce check: ' + emails.length + ' bounced address(es) found, ' + r.suppressed + ' suppressed.');
  if (emails.length) hmSay_(r.suppressed + ' bounced address(es) will not be emailed again.');
}

// ── triggers ─────────────────────────────────────────────────────────────────
function hmEnsureTrigger_(fn, hour) {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
  if (!has) ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(hour).create();
}
function hmRemoveTrigger_(fn) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

// ── booking emails / texts (event-driven) ────────────────────────────────────
// Call with a FareHarbor booking number, e.g. sendBookingReminderEmail('#380089285'). Goes only to that booking's own guest
// (you cannot pass an address) and counts against the same daily Gmail quota. Merge fields:
//   {{first_name}} {{activity}} {{trip_date}} {{trip_time}} {{booking_pk}}
function sendBookingReminderEmail(bookingPk) {
  var r = hmApi_('POST', '/email/transactional', {
    booking_pk: bookingPk, transport: 'gmail', dry_run: false,
    subject: 'Your {{activity}} trip is coming up',
    html: '<p>Hi {{first_name}},</p><p>Just a reminder: your <b>{{activity}}</b> is on {{trip_date}} at {{trip_time}}.</p><p>See you soon!</p>',
    idempotency_key: 'reminder-' + bookingPk + '-' + Utilities.formatDate(new Date(), 'America/Denver', 'yyyy-MM-dd')   // once per booking per day
  });
  return r.messages && r.messages.length ? hmSendMessages_(r.messages) : { sent: 0, note: r.duplicate ? 'already sent today' : 'nothing to send' };
}

function sendBookingReminderText(bookingPk) {
  return hmApi_('POST', '/sms/transactional', {
    booking_pk: bookingPk,
    body: 'Hi {{first_name}}, reminder: your {{activity}} is {{trip_date}} at {{trip_time}}.',
    dry_run: false,
    idempotency_key: 'reminder-sms-' + bookingPk + '-' + Utilities.formatDate(new Date(), 'America/Denver', 'yyyy-MM-dd')
  });
}

// ── marketing text (explicit-consent people only; STOP line added automatically) ──
function previewTextBlast() {
  hmSay_(JSON.stringify(hmApi_('POST', '/sms/audience', { segment: {} }), null, 2));
}
function sendTextBlast() {
  var body = 'Big snow is on the way! Book your Steamboat sled trip: https://coloradosledrentals.com';
  var dry = hmApi_('POST', '/sms/send', { body: body, segment: {} });
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Text ' + dry.eligible + ' people from ' + dry.from_number + '?', '"' + dry.message + '"', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var r = hmApi_('POST', '/sms/send', { body: body, segment: {}, dry_run: false, idempotency_key: 'text-2026-09-snow', expected_recipients: dry.eligible });
  hmSay_('Queued ' + r.queued + ' texts.');
}
