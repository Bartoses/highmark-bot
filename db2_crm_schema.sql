-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB2 CRM SCHEMA — Contacts + Campaigns
-- Run this in Supabase Project 2 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── CONTACTS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone          text UNIQUE NOT NULL,
  first_name     text,
  last_name      text,
  email          text,
  source         text NOT NULL,
  opted_in       boolean DEFAULT true,
  opted_out_at   timestamptz DEFAULT NULL,
  tags           text[] DEFAULT '{}',
  last_activity  timestamptz DEFAULT now(),
  total_bookings integer DEFAULT 0,
  client_id      text NOT NULL,
  notes          text,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_phone_idx ON contacts (phone);
CREATE INDEX IF NOT EXISTS contacts_tags_idx ON contacts USING GIN (tags);
CREATE INDEX IF NOT EXISTS contacts_client_id_idx ON contacts (client_id);

-- ── CAMPAIGNS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id      text NOT NULL,
  name           text NOT NULL,
  message        text NOT NULL,
  segment_tags   text[] DEFAULT NULL,
  status         text DEFAULT 'draft',
  scheduled_for  timestamptz DEFAULT NULL,
  sent_at        timestamptz DEFAULT NULL,
  total_sent     integer DEFAULT 0,
  total_replied  integer DEFAULT 0,
  created_at     timestamptz DEFAULT now()
);

-- ── CAMPAIGN SENDS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_sends (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id uuid REFERENCES campaigns(id),
  contact_id  uuid REFERENCES contacts(id),
  phone       text NOT NULL,
  sent_at     timestamptz DEFAULT now(),
  status      text DEFAULT 'sent',
  twilio_sid  text
);

-- ── OPT OUTS ──────────────────────────────────────────────────────────────────
-- LEGAL: TCPA requires opt-out processing. Never remove records from this table.
CREATE TABLE IF NOT EXISTS opt_outs (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone        text UNIQUE NOT NULL,
  opted_out_at timestamptz DEFAULT now(),
  reason       text
);

CREATE INDEX IF NOT EXISTS opt_outs_phone_idx ON opt_outs (phone);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
-- Enable RLS on all tables. The bot uses the service role key which bypasses
-- RLS automatically — no policies needed for bot access.
ALTER TABLE contacts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE opt_outs       ENABLE ROW LEVEL SECURITY;
