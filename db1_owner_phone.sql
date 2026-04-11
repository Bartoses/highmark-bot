-- db1_owner_phone.sql
-- Adds owner_phone column to clients table.
-- When this number texts the bot, it switches to internal/operator mode
-- (reports, campaign ideas, business insights) instead of guest-facing replies.
-- Run once in Supabase DB1 SQL editor.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS owner_phone TEXT;

COMMENT ON COLUMN clients.owner_phone IS
  'Phone number that activates internal/operator mode when it texts the bot. E.164 format (+12223334444).';
