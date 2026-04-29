-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Enable Row Level Security on all public tables
-- Run in Supabase Project 1 (Chatbot) → SQL Editor
--
-- WHY: Supabase flagged all DB1 tables as publicly accessible via PostgREST.
--      Enabling RLS with no policies blocks anon/authenticated role access
--      while allowing the service role key (used by the bot) to bypass RLS.
--
-- SAFE TO RUN: The bot uses SUPABASE_KEY (service role) on all DB queries.
--              Service role bypasses RLS entirely — zero behavior change.
--              The portal frontend only uses the anon key for Supabase Auth
--              (signIn/signOut) — never for direct table queries.
--
-- Run this once. Safe to re-run (ENABLE RLS is idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

-- Core bot tables
ALTER TABLE public.conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.confirmations_sent    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opt_outs              ENABLE ROW LEVEL SECURITY;

-- Lead & campaign tables
ALTER TABLE public.leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_events           ENABLE ROW LEVEL SECURITY;

-- Portal tables
ALTER TABLE public.portal_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_invites        ENABLE ROW LEVEL SECURITY;

-- Client config tables
ALTER TABLE public.clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_content          ENABLE ROW LEVEL SECURITY;

-- New tables from Chunk 14 (run db1_scrape_sources.sql + db1_booking_options.sql first)
ALTER TABLE public.client_scrape_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_booking_options ENABLE ROW LEVEL SECURITY;

-- Sprint 4A / 4B / Sprint 5 tables (added after initial RLS pass)
ALTER TABLE public.operator_briefings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_sends        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_activities    ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- No policies added — service role bypasses RLS, anon/public access blocked.
-- If you ever need direct PostgREST access from the browser for a specific
-- table, add a policy here. For now, all access goes through the Express API.
-- ─────────────────────────────────────────────────────────────────────────────
