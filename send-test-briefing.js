// One-off: send tomorrow-style operator briefing to a specific phone.
//   Usage: node send-test-briefing.js [+17202892483] [client_id]
import 'dotenv/config';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { generateDailyBriefing } from './operatorBriefing.js';

const toPhone  = process.argv[2] ?? '+17202892483';
const clientId = process.argv[3] ?? 'csr_rea';

const supabase    = createClient(process.env.SUPABASE_URL,     process.env.SUPABASE_KEY);
const crmSupabase = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Load the client config from DB
const { data: row } = await supabase.from('clients').select('*').eq('id', clientId).single();
if (!row) {
  console.error(`Client '${clientId}' not found`);
  process.exit(1);
}
const client = {
  id:            row.id,
  name:          row.name,
  ownerPhone:    row.owner_phone,
  inboundPhones: row.inbound_phones ?? [],
  twilio_number: row.outbound_phone ?? row.inbound_phones?.[0] ?? process.env.TWILIO_PHONE_NUMBER,
};

console.log(`[test-briefing] Sending preview to ${toPhone} for ${clientId}`);

const result = await generateDailyBriefing(client, supabase, twilioClient, crmSupabase, {
  toPhone,
  dedupKey: `manual-test:${Date.now()}`,
  digestTypes: ['all'],
});

console.log('[test-briefing] Result:', JSON.stringify(result, null, 2));
process.exit(0);
