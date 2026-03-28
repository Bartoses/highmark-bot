-- Migration: clients table for dynamic client provisioning (Chunk 6)
-- Run in Supabase DB1 SQL editor

CREATE TABLE IF NOT EXISTS clients (
  id                          TEXT PRIMARY KEY,
  slug                        TEXT UNIQUE NOT NULL,
  name                        TEXT NOT NULL,
  bot_name                    TEXT NOT NULL DEFAULT 'Summit',
  tone                        TEXT NOT NULL DEFAULT 'warm, helpful, and knowledgeable',
  inbound_phones              TEXT[] NOT NULL DEFAULT '{}',
  support_phone               TEXT,
  handoff_phone               TEXT,
  support_email               TEXT,
  address                     TEXT,
  timezone                    TEXT NOT NULL DEFAULT 'America/Denver',
  hours                       JSONB,
  booking_mode                TEXT NOT NULL DEFAULT 'informational'
                              CHECK (booking_mode IN ('fareharbor', 'informational', 'lead_capture')),
  fareharbor_enabled          BOOLEAN NOT NULL DEFAULT false,
  crm_enabled                 BOOLEAN NOT NULL DEFAULT false,
  confirmation_texts_enabled  BOOLEAN NOT NULL DEFAULT false,
  waitlist_enabled            BOOLEAN NOT NULL DEFAULT true,
  lead_capture_enabled        BOOLEAN NOT NULL DEFAULT false,
  lead_notification_phone     TEXT,
  fareharbor_companies        JSONB NOT NULL DEFAULT '[]',
  scrape_urls                 TEXT[] NOT NULL DEFAULT '{}',
  snotel_stations             JSONB NOT NULL DEFAULT '[]',
  booking_urls                JSONB NOT NULL DEFAULT '{}',
  services                    TEXT[] NOT NULL DEFAULT '{}',
  faq                         JSONB NOT NULL DEFAULT '[]',
  opener_text                 TEXT,
  handoff_reply_template      TEXT,
  active                      BOOLEAN NOT NULL DEFAULT true,
  website_url                 TEXT,
  static_facts                JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
