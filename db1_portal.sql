-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Client Portal Auth (Chunk 10)
-- Run in Supabase Project 1 → SQL Editor
--
-- Creates portal_users table linking Supabase Auth users to portal access.
--
-- Workflow to provision a new portal user:
--   POST /admin/portal-users?key=UI_SECRET
--   { "email": "...", "password": "...", "role": "client_user", "client_id": "csr_rea" }
--   This creates a Supabase Auth user + inserts a portal_users row in one call.
--
-- Roles:
--   internal_admin — can view/manage any client (client_id = null)
--   client_user    — can only view their own client (client_id required)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portal_users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  uuid        NOT NULL UNIQUE,  -- Supabase auth.users.id
  email         text        NOT NULL,          -- denormalized for display
  role          text        NOT NULL DEFAULT 'client_user'
                            CHECK (role IN ('internal_admin', 'client_user')),
  client_id     text        DEFAULT NULL,      -- required for client_user, null for internal_admin
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_users_auth_user_id_idx ON portal_users (auth_user_id);
CREATE INDEX IF NOT EXISTS portal_users_client_id_idx    ON portal_users (client_id);
