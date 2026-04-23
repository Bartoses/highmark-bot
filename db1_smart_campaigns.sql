-- Smart Event Campaigns — Sprint 4B
-- Run once in Supabase DB1 SQL editor

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS campaign_type   TEXT    DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS trigger_type    TEXT,
  ADD COLUMN IF NOT EXISTS trigger_config  JSONB   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_fired_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fire_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cooldown_days   INTEGER DEFAULT 7,
  ADD COLUMN IF NOT EXISTS audience_filter TEXT    DEFAULT 'all_leads';

-- Values for campaign_type: 'manual', 'event_triggered'
-- Values for trigger_type:  'snow_fresh', 'good_weather', 'opening_date', 'custom_date'
-- Values for audience_filter: 'all_leads', 'engaged_leads', 'new_leads', 'missed_leads'

CREATE TABLE IF NOT EXISTS campaign_sends (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id    UUID        REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id      TEXT        NOT NULL,
  contact_phone  TEXT,
  sent_at        TIMESTAMPTZ DEFAULT NOW(),
  status         TEXT        DEFAULT 'scheduled'
);

CREATE INDEX IF NOT EXISTS campaign_sends_campaign_id   ON campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS campaign_sends_contact_phone ON campaign_sends(contact_phone);
CREATE INDEX IF NOT EXISTS campaign_sends_sent_at       ON campaign_sends(sent_at);
