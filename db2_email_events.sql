-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 (CSR/REA CRM) — email engagement: opens + clicks
-- Run once in the DB2 Supabase SQL editor. Additive + idempotent.
--
-- Every marketing email links through /e/c/… (click) and carries a 1×1 /e/o/… image (open), both signed with
-- EMAIL_TRACKING_SECRET and keyed by the email_sends row id (see emailTracking.js). Each hit is one email_events row;
-- email_sends keeps the FIRST human open / click so per-campaign unique counts are one query.
--
--   is_bot → the hit came from a link scanner / prefetcher (user agent heuristic). Stored for honesty, excluded
--            from the stats. Apple Mail Privacy Protection opens can't be told apart, so opens run high.
--   No IP address is stored.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_id     uuid NOT NULL REFERENCES public.email_sends(id) ON DELETE CASCADE,
  campaign_id uuid,
  client_id   text NOT NULL DEFAULT 'csr_rea',
  type        text NOT NULL CHECK (type IN ('open', 'click')),
  url         text,                         -- click destination (NULL for opens)
  user_agent  text,
  is_bot      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_campaign_idx ON public.email_events (campaign_id, type);
CREATE INDEX IF NOT EXISTS email_events_send_idx     ON public.email_events (send_id);

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;   -- service role bypasses; no public policies

ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS opened_at  timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
