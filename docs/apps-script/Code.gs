/**
 * Highmark sender - Google Apps Script client        (replaces "Real Send.gs" / "Test Email Send.gs")
 * (This file is deliberately plain ASCII so copy/paste can never scramble a character.)
 *
 * WHAT THIS DOES
 *   The CSR CRM database (Supabase) is the source of truth: contacts, who opted in, who unsubscribed or bounced,
 *   your saved newsletters, and a record of every email sent. You paste a newsletter's HTML on the Newsletter page
 *   (https://highmark-bot-production.up.railway.app/newsletter) and click Save. THIS script only delivers the emails
 *   through YOUR Gmail, as info@coloradosledrentals.com - no DNS changes, nothing from FareHarbor.
 *
 * ONE-TIME SETUP
 *   1. Project Settings (gear icon) -> Script properties -> add:
 *        HIGHMARK_API_URL = https://highmark-bot-production.up.railway.app/api/v1
 *        HIGHMARK_API_KEY = <the OUTBOUND_API_KEY from Railway -> highmark-bot -> Variables>
 *   2. Run checkConnection() once and approve the permission prompts (Gmail + external requests).
 *
 * SENDING A NEWSLETTER (menu: Highmark)
 *   1. Paste + Save the newsletter on the Newsletter page.
 *   2. Highmark -> Preview newsletter audience  (who would get it, and any warnings)
 *   3. Highmark -> Send me a test               (goes to sean@coloradosledrentals.com)
 *   4. Highmark -> Send newsletter...           (asks you to confirm the count first)
 *   Gmail limits emails per day (about 100 on a free account, 1,500 on Google Workspace). If the list is bigger than
 *   today's allowance, the rest goes out automatically until it is done. A newsletter can only ever be sent once.
 *
 * All helper functions are prefixed "hm" so they can't collide with the other files in your project.
 */

// ---- YOUR SENDER (must already be a "Send mail as" address in Gmail settings -> Accounts) ----
var SEND_AS       = 'info@coloradosledrentals.com';
var SENDER_NAME   = 'Colorado Sled Rentals';
var REPLY_TO      = 'info@coloradosledrentals.com';
var TEST_TO       = 'sean@coloradosledrentals.com';   // "Send me a test" goes here
var QUOTA_RESERVE = 5;                                // keep a few sends of today's quota free for your normal email
var RUN_BUDGET_MS = 270000;                           // stop after ~4.5 minutes (Apps Script kills a run at 6 min); it resumes by itself

// ---- MENU (shows up in the spreadsheet) ----
// NOTE: Apps Script allows only ONE onOpen() per project. If another file of yours already defines onOpen(),
// delete this one and add the createMenu(...) lines below into yours.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Highmark')
    .addItem('Check connection', 'checkConnection')
    .addItem('Preview newsletter audience', 'previewNewsletter')
    .addItem('Send me a test', 'sendNewsletterTest')
    .addItem('Send newsletter...', 'sendNewsletter')
    .addSeparator()
    .addItem('Send the rest now', 'continueSending')
    .addItem('Sending status', 'campaignStatus')
    .addItem('Check for bounced addresses', 'checkBounces')
    .addToUi();
}

// ---- core ----
function hmApi_(method, path, body) {
  var props = PropertiesService.getScriptProperties();
  var base = props.getProperty('HIGHMARK_API_URL'), key = props.getProperty('HIGHMARK_API_KEY');
  if (!base || !key) throw new Error('Set HIGHMARK_API_URL and HIGHMARK_API_KEY in Project Settings -> Script properties.');
  var res = UrlFetchApp.fetch(base + path, {
    method: method, contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
    payload: body ? JSON.stringify(body) : undefined, muteHttpExceptions: true
  });
  var code = res.getResponseCode(), json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { /* non-JSON error page */ }
  if (code >= 400) throw new Error('Highmark API ' + code + ': ' + (json.error || res.getContentText().slice(0, 200)));
  return json;
}
function hmSiteUrl_() {
  return (PropertiesService.getScriptProperties().getProperty('HIGHMARK_API_URL') || '').replace(/\/api\/v1\/?$/, '');
}
function hmSay_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }
function hmMe_() { return Session.getEffectiveUser().getEmail(); }
function hmWarn_(list) { return list && list.length ? '\n\n\u26A0 ' + list.join('\n\u26A0 ') : ''; }
function hmDescribe_(a, warnings) {
  var x = a.excluded || {};
  return a.eligible + ' people will receive it.\n\nNot receiving it: ' +
    (x.unsubscribed || 0) + ' unsubscribed, ' + (x.suppressed || 0) + ' bounced/complained, ' +
    (x.no_consent || 0) + ' never opted in, ' + (x.grandfathered || 0) + ' older contacts without an explicit opt-in, ' +
    (x.not_in_segment || 0) + ' outside this selection.' + hmWarn_(warnings);
}

// Lets you choose a saved newsletter (the ones pasted on the Newsletter page). onlyDrafts = hide ones already sent.
function hmPickNewsletter_(onlyDrafts) {
  var list = hmApi_('GET', '/newsletters').newsletters.filter(function (n) { return !onlyDrafts || n.status === 'draft'; }).slice(0, 8);
  if (!list.length) throw new Error('No ' + (onlyDrafts ? 'unsent ' : '') + 'newsletters saved yet. Paste one here first: ' + hmSiteUrl_() + '/newsletter');
  if (list.length === 1) return list[0];
  var ui = SpreadsheetApp.getUi();
  var text = list.map(function (n, i) { return (i + 1) + '. ' + n.name + '   [' + n.status + ']   ' + n.subject; }).join('\n');
  var r = ui.prompt('Which newsletter?', text + '\n\nType a number (1 = the one you edited most recently):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  var i = parseInt(r.getResponseText() || '1', 10) - 1;
  if (!(i >= 0 && i < list.length)) throw new Error('Please type a number from the list.');
  return list[i];
}

// Refuse to send if the sender isn't a verified Gmail "Send mail as" address (otherwise Gmail would send as someone else).
function hmAssertSender_() {
  var ok = hmMe_().toLowerCase() === SEND_AS.toLowerCase() ||
           GmailApp.getAliases().map(function (a) { return a.toLowerCase(); }).indexOf(SEND_AS.toLowerCase()) !== -1;
  if (!ok) throw new Error(SEND_AS + ' is not set up as a "Send mail as" address in this Gmail account (Gmail -> Settings -> Accounts).');
}
function hmSendOne_(m) {
  GmailApp.sendEmail(m.to, m.subject, m.text || '', { htmlBody: m.html, from: SEND_AS, name: SENDER_NAME, replyTo: m.reply_to || REPLY_TO });
}

// Sends rendered messages through Gmail, then reports each result to Highmark. Returns {sent, failed, deferred}.
function hmSendMessages_(messages, deadline) {
  hmAssertSender_();
  var results = [], sent = 0, failed = 0, deferred = 0, stop = false;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!stop && ((deadline && Date.now() > deadline) || MailApp.getRemainingDailyQuota() <= 0)) stop = true;   // out of time or quota: hand the rest back
    if (stop) { results.push({ send_id: m.send_id, deferred: true }); deferred++; continue; }
    try { hmSendOne_(m); results.push({ send_id: m.send_id, ok: true }); sent++; }
    catch (e) {
      var msg = String((e && e.message) || e);
      if (/too many times|quota|limit exceeded|service invoked/i.test(msg)) { stop = true; results.push({ send_id: m.send_id, deferred: true }); deferred++; }
      else { results.push({ send_id: m.send_id, ok: false, error: msg }); failed++; }
    }
    if (results.length >= 10) { hmApi_('POST', '/email/report', { results: results }); results = []; }   // report often: a crash can't lose much
    Utilities.sleep(150);
  }
  if (results.length) hmApi_('POST', '/email/report', { results: results });
  return { sent: sent, failed: failed, deferred: deferred };
}

// Sends as much of the current campaign as today's Gmail quota and this run's time budget allow. Returns {sent, failed, remaining}.
function hmDrain_() {
  var id = PropertiesService.getScriptProperties().getProperty('LAST_CAMPAIGN_ID');
  if (!id) return { sent: 0, failed: 0, remaining: 0 };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('A send is already running - try again in a minute.');
  var deadline = Date.now() + RUN_BUDGET_MS;
  try {
    var sent = 0, failed = 0, remaining = 0;
    for (var guard = 0; guard < 60; guard++) {
      var quota = MailApp.getRemainingDailyQuota() - QUOTA_RESERVE;
      var r = hmApi_('POST', '/email/pull', { campaign_id: id, limit: Math.max(0, Math.min(20, quota)) });
      remaining = r.remaining;
      if (r.blocked) throw new Error('Highmark is holding this send: ' + r.blocked + (r.blocked === 'no_mailing_address' ? ' (set MAILING_ADDRESS in Railway).' : ''));
      if (!r.messages.length) break;
      var s = hmSendMessages_(r.messages, deadline);
      sent += s.sent; failed += s.failed;
      if (s.deferred || Date.now() > deadline) break;
    }
    return { sent: sent, failed: failed, remaining: remaining };
  } finally { lock.releaseLock(); }
}

// ---- newsletter ----
function checkConnection() {
  var h = hmApi_('GET', '/health');
  var senderOk = true; try { hmAssertSender_(); } catch (e) { senderOk = false; }
  hmSay_('Connected to ' + h.business + '.\nMailing address set: ' + h.mailing_address_configured +
         '\nGmail can send as ' + SEND_AS + ': ' + senderOk +
         '\nTest emails go to: ' + TEST_TO +
         '\nEmails you can still send today: ' + MailApp.getRemainingDailyQuota() +
         '\n\nPaste newsletters here: ' + hmSiteUrl_() + '/newsletter');
}

function previewNewsletter() {
  var n = hmPickNewsletter_(false); if (!n) return;
  var a = hmApi_('POST', '/email/audience', { newsletter_id: n.id });
  var p = hmApi_('POST', '/email/preview', { newsletter_id: n.id });
  hmSay_('"' + n.name + '"\n\n' + hmDescribe_(a, p.warnings));
}

function sendNewsletterTest() {
  hmAssertSender_();
  var n = hmPickNewsletter_(false); if (!n) return;
  var p = hmApi_('POST', '/email/preview', { newsletter_id: n.id });
  GmailApp.sendEmail(TEST_TO, p.subject, p.text || '', { htmlBody: p.html, from: SEND_AS, name: SENDER_NAME, replyTo: REPLY_TO });
  hmSay_('Test of "' + n.name + '" sent to ' + TEST_TO + '. Check your inbox (and spam). The unsubscribe link in a test is only a placeholder.' + hmWarn_(p.warnings));
}

function sendNewsletter() {
  hmAssertSender_();
  var n = hmPickNewsletter_(true); if (!n) return;
  var dry = hmApi_('POST', '/email/send', { newsletter_id: n.id, transport: 'gmail' });   // dry run (the default)
  var quota = MailApp.getRemainingDailyQuota() - QUOTA_RESERVE;
  var ok = true;
  try {
    var ui = SpreadsheetApp.getUi();
    ok = ui.alert('Send "' + n.name + '"?',
      'Subject: ' + n.subject + '\n\n' + hmDescribe_(dry, dry.warnings) + '\n\nToday\'s Gmail allowance: about ' + quota + ' emails' +
      (dry.eligible > quota ? ' - the rest will go out automatically over the next days.' : ' - it all goes out today.') +
      '\n\nThis cannot be undone.', ui.ButtonSet.YES_NO) === ui.Button.YES;
  } catch (e) { /* running from a trigger: no UI to confirm with */ }
  if (!ok) return;

  var r = hmApi_('POST', '/email/send', {
    newsletter_id: n.id, transport: 'gmail', dry_run: false,
    from_name: SENDER_NAME, reply_to: REPLY_TO,
    expected_recipients: dry.eligible                                   // refuses if the audience changed a lot between preview and send
  });
  PropertiesService.getScriptProperties().setProperty('LAST_CAMPAIGN_ID', r.campaign_id);
  if (r.already_created) { hmSay_('This newsletter was already sent (campaign ' + r.campaign_id + '). Nothing new was queued.'); }

  var d = hmDrain_();
  if (d.remaining > 0) { hmEnsureRecurring_('continueSending', 10); hmEnsureTrigger_('checkBounces', 10); }
  hmSay_('Sent ' + d.sent + ' now' + (d.failed ? ' (' + d.failed + ' failed)' : '') + '. ' +
         (d.remaining > 0 ? d.remaining + ' more will go out automatically (this script keeps going by itself).' : 'That\'s everyone.'));
}

// Runs by itself (a trigger is created for you) until the campaign is finished. Safe to run by hand too.
function continueSending() {
  var d = hmDrain_();
  if (d.remaining === 0) hmRemoveTrigger_('continueSending');
  Logger.log('Sent ' + d.sent + (d.failed ? ' (' + d.failed + ' failed)' : '') + '; ' + d.remaining + ' still waiting.');
  if (d.sent || d.remaining === 0) hmSay_('Sent ' + d.sent + (d.failed ? ' (' + d.failed + ' failed)' : '') + '. ' + d.remaining + ' still waiting.');
}

function campaignStatus() {
  var id = PropertiesService.getScriptProperties().getProperty('LAST_CAMPAIGN_ID');
  if (!id) { hmSay_('No newsletter has been started from this script yet.'); return; }
  var s = hmApi_('GET', '/email/campaigns/' + id);
  hmSay_(JSON.stringify(s.counts) + '  (of ' + s.total + ')');
}

// ---- bounces ----
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

// ---- triggers ----
function hmEnsureTrigger_(fn, hour) {          // once a day
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
  if (!has) ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(hour).create();
}
function hmEnsureRecurring_(fn, minutes) {     // every N minutes until removed
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
  if (!has) ScriptApp.newTrigger(fn).timeBased().everyMinutes(minutes).create();
}
function hmRemoveTrigger_(fn) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

// ---- booking emails / texts (event-driven) ----
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

// ---- marketing text (explicit-consent people only; STOP line added automatically) ----
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
