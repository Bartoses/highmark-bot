-- Migration: add contact_email column to leads table
-- (contact_name already exists from db1_lead_capture.sql)
-- Run in Supabase DB1 SQL editor

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
