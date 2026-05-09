-- ─────────────────────────────────────────────────────────────────────────────
-- Operator Dashboard — DB2 bookings operational columns
-- Run in: CSR/REA CRM Supabase SQL Editor (project ref: aiiguzslqiemksrvfvwk)
--
-- Phase 1 of the operator dashboard adds read-only columns for guide
-- assignment, internal staff notes, prep tracking, and shareable dashboards.
-- Existing columns (waiver_signed, checked_in, booking_notes) are reused.
--
-- Safe to re-run: every ALTER uses IF NOT EXISTS / IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS guide_name      TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes  TEXT,
  ADD COLUMN IF NOT EXISTS prep_completed  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS share_token     TEXT;

-- Indexes for the operations dashboard query patterns
CREATE INDEX IF NOT EXISTS idx_bookings_start_at      ON public.bookings (start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_company       ON public.bookings (company);
CREATE INDEX IF NOT EXISTS idx_bookings_guide_name    ON public.bookings (guide_name);
CREATE INDEX IF NOT EXISTS idx_bookings_share_token   ON public.bookings (share_token) WHERE share_token IS NOT NULL;
