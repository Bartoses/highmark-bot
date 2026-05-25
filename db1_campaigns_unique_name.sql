-- Prevent duplicate live campaigns — one active/draft/scheduled/sending row
-- per (client_id, name). Historical rows (sent / failed) are excluded from
-- the constraint so name-reuse over time remains possible.
--
-- Background: on 2026-05-25 the snow-fresh test campaign accumulated 129
-- identical "active" rows because createCampaign() in campaigns.js does a
-- raw INSERT with no duplicate check. The smart-campaign evaluator runs
-- every 5 min and fires every active event_triggered row independently, so
-- each duplicate sent its own text — spamming the team phone every tick.
--
-- This partial unique index closes the gap at the DB layer; the matching
-- pre-check in campaigns.js returns a clean 409 to the portal.
--
-- Run once in DB1 Supabase SQL editor (project qygcmdyxvjlzbmpdpesc).

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_unique_live_name
  ON public.campaigns (client_id, name)
  WHERE status IN ('draft', 'scheduled', 'active', 'sending');
