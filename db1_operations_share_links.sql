-- ─────────────────────────────────────────────────────────────────────────────
-- Operations Dashboard Share Links — DB1
-- Run in: Supabase DB1 SQL Editor (project ref: qygcmdyxvjlzbmpdpesc)
--
-- A share link grants no-auth, read-only access to a client's operations
-- dashboard. Used for shop TVs, dispatch boards, guide crew phones.
--
-- Tokens are 32-char URL-safe random strings (generated in Node).
-- Revocation = setting revoked_at. Expiration = expires_at < now().
-- The public route checks both before returning data.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.operations_share_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_by   TEXT,                                 -- portal_users.id of creator
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                          -- NULL = never expires
  revoked_at   TIMESTAMPTZ                           -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_ops_share_links_token     ON public.operations_share_links (token);
CREATE INDEX IF NOT EXISTS idx_ops_share_links_client_id ON public.operations_share_links (client_id);
