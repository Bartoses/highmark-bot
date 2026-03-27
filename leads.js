// ─────────────────────────────────────────────────────────────────────────────
// LEADS — Service request / appointment lead capture
//
// Used by informational clients (e.g. Lone Pine Performance) to collect
// service requests over SMS without pretending to confirm appointments.
//
// Flow: booking intent → ask service → ask callback → ask timeframe → save + notify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a captured lead to the leads table in DB1.
 * Returns true on success, false on failure (non-throwing).
 */
export async function saveLead(supabase, { clientId, fromNumber, contactPhone, service, timeframe }) {
  if (!supabase) return false;
  try {
    await supabase.from("leads").insert({
      client_id:           clientId,
      from_number:         fromNumber,
      contact_phone:       contactPhone,
      requested_service:   service   ?? null,
      preferred_timeframe: timeframe ?? null,
      source:              "sms",
      status:              "new",
    });
    console.log(`[LEADS] Saved — ${clientId} / ${fromNumber}`);
    return true;
  } catch (err) {
    console.error("[LEADS] saveLead failed:", err.message);
    return false;
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
export async function notifyBusinessOfLead(twilioClient, client, fromNumber, botPhone, leadData, testMode = false) {
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
      `📋 New request — ${client.name}`,
      `Service: ${leadData.service ?? "not specified"}`,
      `Call back: ${callbackPhone}`,
    ];
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
