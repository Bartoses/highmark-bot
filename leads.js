// ─────────────────────────────────────────────────────────────────────────────
// LEADS — Service request / appointment lead capture
//
// Used by informational clients (e.g. Lone Pine Performance) to collect
// service requests over SMS without pretending to confirm appointments.
//
// Flow: booking intent → ask service → ask callback → ask timeframe → save + notify
// ─────────────────────────────────────────────────────────────────────────────

import { normalizePhone } from "./phoneUtils.js";

/**
 * Save a captured lead to the leads table in DB1.
 * Returns the created lead row (including id) on success, null on failure (non-throwing).
 * Callers can use the returned row to schedule follow-ups:
 *   const lead = await saveLead(...); if (lead) scheduleFollowUps(supabase, lead, fromPhone);
 */
export async function saveLead(supabase, {
  clientId, fromNumber, contactPhone, contactEmail,
  name, service, timeframe, leadType = "booking",
  businessName = null, website = null, source = "sms",
}) {
  if (!supabase) return null;
  try {
    // Normalize contact phone for consistent dedup and CRM matching.
    // fromNumber from Twilio is already E.164; contactPhone may be user-entered.
    const normalizedContact = normalizePhone(contactPhone) ?? contactPhone;

    // Never create a lead for a registered operator phone — they're staff, not
    // customers. (Defense-in-depth; inbound already routes operators to operator
    // mode. Also catches voice missed-call recovery + any other entry point.)
    try {
      const checkPhone = normalizePhone(fromNumber) ?? normalizedContact;
      const { data: op } = await supabase.from("operator_phones")
        .select("id").eq("client_id", clientId)
        .in("phone", [checkPhone, normalizedContact].filter(Boolean))
        .limit(1).maybeSingle();
      if (op) { console.log(`[LEADS] Skipping lead — ${normalizedContact} is a registered operator`); return null; }
    } catch { /* table may be absent — proceed */ }

    const row = {
      client_id:           clientId,
      from_number:         fromNumber,
      contact_phone:       normalizedContact,
      contact_name:        name         ?? null,
      requested_service:   service      ?? null,
      preferred_timeframe: timeframe    ?? null,
      source,
      status:              "new",
      lead_type:           leadType,
    };
    // Optional columns — only include when provided (requires matching migrations)
    if (contactEmail != null) row.contact_email = contactEmail;
    if (businessName != null) row.business_name = businessName;
    if (website      != null) row.website        = website;

    const { data, error } = await supabase.from("leads").insert(row).select().single();
    if (error) { console.error("[LEADS] saveLead failed:", error.message); return null; }
    console.log(`[LEADS] Saved — ${clientId} / ${fromNumber} (id=${data.id})`);
    return data; // full lead row including id — pass to scheduleFollowUps()
  } catch (err) {
    console.error("[LEADS] saveLead error:", err.message);
    return null;
  }
}

/**
 * Notify the business by SMS when a new lead is captured.
 * Skipped automatically in TEST_MODE to avoid real Twilio calls during tests.
 *
 * @param {object} twilioClient  — initialized Twilio client
 * @param {object} client        — client config (needs leadNotificationPhone)
 * @param {string} fromNumber    — guest's inbound phone (fallback callback)
 * @param {string} botPhone      — Twilio number to send the notification from
 * @param {object} leadData      — { service, callback, timeframe }
 * @param {boolean} testMode     — pass true to skip send (TEST_MODE)
 */
export async function notifyBusinessOfLead(twilioClient, client, fromNumber, botPhone, leadData, testMode = false, leadType = 'booking') {
  const notifyPhone = client.leadNotificationPhone;
  if (!notifyPhone || !twilioClient) return;

  if (testMode) {
    console.log(`[LEADS] TEST_MODE — skip notification for ${client.name} to ${notifyPhone}`);
    return;
  }

  try {
    // Use callback phone if it looks like a phone number, otherwise fall back to from
    const callbackPhone = /^\+?\d/.test(leadData.callback ?? "")
      ? leadData.callback
      : fromNumber;

    const lines = [
      `📋 ${leadType === 'waitlist' ? 'New waitlist signup' : 'New request'} — ${client.name}`,
    ];
    if (leadData.name) lines.push(`Name: ${leadData.name}`);
    lines.push(`Service: ${leadData.service ?? "not specified"}`);
    lines.push(`Call back: ${callbackPhone}`);
    if (leadData.email)    lines.push(`Email: ${leadData.email}`);
    if (leadData.timeframe) lines.push(`Timeframe: ${leadData.timeframe}`);

    await twilioClient.messages.create({
      body: lines.join("\n"),
      from: botPhone,
      to:   notifyPhone,
    });
    console.log(`[LEADS] Business notified at ${notifyPhone}`);
  } catch (err) {
    console.error("[LEADS] notifyBusiness failed:", err.message);
  }
}
