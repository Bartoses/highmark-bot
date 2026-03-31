-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Portal Invite Flow (Chunk 11)
-- Run in Supabase Project 1 → SQL Editor
--
-- Creates portal_invites table for controlled invite-based portal access.
--
-- Invite lifecycle:
--   1. Admin calls POST /admin/portal-invites → creates row, returns invite_url
--   2. Admin sends invite_url to client out-of-band (email, Slack, etc.)
--   3. Client opens invite_url → /portal/invite?token=<token>
--   4. Client sets a password via portal-accept.html
--   5. POST /portal/api/accept-invite validates token, creates auth user + portal_users row
--   6. Invite marked accepted — token is single-use
--
-- Statuses: pending → accepted | expired | revoked
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portal_invites (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text        NOT NULL,
  role         text        NOT NULL DEFAULT 'client_user'
               CHECK (role IN ('internal_admin', 'client_user')),
  client_id    text        DEFAULT NULL,       -- required for client_user, null for internal_admin
  invited_by   text        NOT NULL DEFAULT 'admin',
  status       text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  invite_token text        UNIQUE,             -- 64-char hex token, single-use
  expires_at   timestamptz NOT NULL,           -- 72h from creation
  accepted_at  timestamptz DEFAULT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_invites_token_idx     ON portal_invites (invite_token);
CREATE INDEX IF NOT EXISTS portal_invites_email_idx     ON portal_invites (email);
CREATE INDEX IF NOT EXISTS portal_invites_client_id_idx ON portal_invites (client_id);
CREATE INDEX IF NOT EXISTS portal_invites_status_idx    ON portal_invites (status);
