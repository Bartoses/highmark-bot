-- Migration: expand booking_mode check constraint to include Chunk 14 modes
-- Run in Supabase DB1 SQL editor
--
-- The original db1_clients.sql constraint only allowed 3 modes.
-- Chunk 14 added call_only, static_links, api_live_booking, hybrid, demo.
-- This drops and recreates the constraint to include all valid modes.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_booking_mode_check;

ALTER TABLE clients ADD CONSTRAINT clients_booking_mode_check
  CHECK (booking_mode IN (
    'fareharbor',
    'informational',
    'lead_capture',
    'call_only',
    'static_links',
    'api_live_booking',
    'hybrid',
    'demo'
  ));
