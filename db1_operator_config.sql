-- Operator phones + custom weather locations — Sprint 4A follow-up
-- Run once in Supabase DB1 SQL editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS operator_phones   JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS weather_locations JSONB DEFAULT '[]';

COMMENT ON COLUMN clients.operator_phones IS
  'Array of E.164 phone strings that trigger owner/operator mode in the bot, e.g. ["+17202892483"]';

COMMENT ON COLUMN clients.weather_locations IS
  'Array of custom weather locations fetched hourly, e.g. [{"name":"Rabbit Ears Pass","lat":40.38,"lon":-106.60,"elevation":"9,426 ft"}]';
