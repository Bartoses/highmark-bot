-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Add client_admin role (Chunk 12)
-- Run in Supabase Project 1 → SQL Editor
--
-- Adds client_admin as a third portal role between internal_admin and client_user.
--
-- client_admin:
--   - Scoped to their own client_id (like client_user)
--   - Can invite and manage portal users within their own account
--   - Cannot access other clients' data
--   - Cannot invite internal_admin users
-- ─────────────────────────────────────────────────────────────────────────────

-- Update portal_users role constraint
ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_role_check;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_role_check
  CHECK (role IN ('internal_admin', 'client_admin', 'client_user'));

-- Update portal_invites role constraint
ALTER TABLE portal_invites DROP CONSTRAINT IF EXISTS portal_invites_role_check;
ALTER TABLE portal_invites ADD CONSTRAINT portal_invites_role_check
  CHECK (role IN ('internal_admin', 'client_admin', 'client_user'));
