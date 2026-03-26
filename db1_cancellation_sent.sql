-- Migration: add cancellation_sent column to confirmations_sent
-- Run in Supabase DB1 SQL editor

ALTER TABLE confirmations_sent
  ADD COLUMN IF NOT EXISTS cancellation_sent boolean NOT NULL DEFAULT false;

-- Backfill: mark existing rows as not cancelled (default already handles this,
-- but explicit for clarity)
-- UPDATE confirmations_sent SET cancellation_sent = false WHERE cancellation_sent IS NULL;
