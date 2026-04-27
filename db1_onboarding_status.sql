-- ─────────────────────────────────────────────────────────────────────────────
-- SPRINT 7 — Self-serve signup status states
--
-- Extends onboarding_drafts.status to support the public signup → background
-- crawl → review → approve flow. Existing values preserved.
--
-- Old values: 'draft' | 'saved' | 'discarded'
-- New values added: 'processing' | 'failed'
--
-- Lifecycle for self-serve signups:
--   processing → draft (crawl finished, ready for review)
--   processing → failed (crawl errored)
--   draft       → saved (user approved + client created)  [unchanged]
--
-- Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE onboarding_drafts DROP CONSTRAINT IF EXISTS onboarding_drafts_status_check;

ALTER TABLE onboarding_drafts
  ADD CONSTRAINT onboarding_drafts_status_check
  CHECK (status IN ('processing', 'draft', 'saved', 'discarded', 'failed'));

-- Extra column: which portal_user owns this draft (so /portal/onboarding can
-- look up "my draft" without the user having internal_admin role).
ALTER TABLE onboarding_drafts
  ADD COLUMN IF NOT EXISTS owner_auth_user_id uuid;

CREATE INDEX IF NOT EXISTS onboarding_drafts_owner_idx
  ON onboarding_drafts (owner_auth_user_id, created_at DESC);

-- Capture pipeline failures (Haiku error, crawl error, validation error)
ALTER TABLE onboarding_drafts
  ADD COLUMN IF NOT EXISTS error_message text;

-- Verify
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'onboarding_drafts'
   AND column_name IN ('status', 'owner_auth_user_id', 'error_message');
