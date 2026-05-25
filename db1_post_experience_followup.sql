-- Post-experience follow-up — adds messaging_config columns + a default-template
-- placeholder. Run once in the DB1 Supabase SQL editor (project qygcmdyxvjlzbmpdpesc).
--
-- After a booking's end_at, schedule one SMS (24h later by default) thanking
-- the guest, asking for a review, and inviting them back. Per-client toggle so
-- it can be turned on/off in the portal. Template lives in messaging_config.
-- custom_templates JSONB under the key "post_experience" — no schema change there.
--
-- Idempotency: scheduled_messages.metadata->>booking_pk = X AND message_type =
-- 'post_experience' is used by the scheduler to dedupe.

ALTER TABLE public.messaging_config
  ADD COLUMN IF NOT EXISTS enable_post_experience_followup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS post_experience_hours_after     integer NOT NULL DEFAULT 24
    CHECK (post_experience_hours_after BETWEEN 1 AND 168),
  ADD COLUMN IF NOT EXISTS review_url   text,   -- Google / Yelp / TripAdvisor review URL
  ADD COLUMN IF NOT EXISTS website_url  text;   -- Business website for "come back" CTA

-- Seed CSR/REA with their URLs so the toggle works immediately on enable.
UPDATE public.messaging_config
   SET review_url  = 'https://g.page/r/CfQGQSBK_KsOEBM/review',
       website_url = 'https://coloradosledrentals.com/'
 WHERE client_id  = 'csr_rea'
   AND (review_url IS NULL OR website_url IS NULL);
