-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 6 — Custom API Integration Builder
--
-- Adds client_api_integrations table for storing per-client custom API configs.
-- Run in Supabase DB1 SQL editor after db1_clients.sql.
-- Safe to run multiple times (IF NOT EXISTS guards throughout).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_api_integrations (
  id               uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id        text    NOT NULL,
  name             text    NOT NULL,
  description      text,
  base_url         text    NOT NULL,

  -- auth_type: none | bearer | api_key_header | api_key_query | basic
  auth_type        text    NOT NULL DEFAULT 'none',

  -- auth_config stores credentials as JSON — write-only from the portal
  -- {token, key_name, key_value, username, password}
  auth_config      jsonb   NOT NULL DEFAULT '{}',

  -- Global headers applied to every request from this integration
  -- {"Header-Name": "value"}
  headers          jsonb   NOT NULL DEFAULT '{}',

  -- Array of endpoint definitions:
  -- [{name, path, method, params, context_label, inject_always}]
  -- name         — human label (e.g. "Get Availability")
  -- path         — relative path (e.g. /availability)
  -- method       — GET | POST | PUT | PATCH
  -- params       — query/body params as JSON object
  -- context_label — how data is labelled in bot context (e.g. "AVAILABILITY")
  -- inject_always — boolean; if true, called before every bot response
  endpoints        jsonb   NOT NULL DEFAULT '[]',

  -- Last successful test response schema + sample (truncated)
  response_schema  jsonb,
  sample_response  jsonb,

  enabled          boolean NOT NULL DEFAULT true,
  last_tested_at   timestamptz,
  last_test_status text,    -- 'connected' | 'failed' | null (never tested)

  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Check constraint on auth_type
DO $$ BEGIN
  ALTER TABLE client_api_integrations ADD CONSTRAINT cai_auth_type_check
    CHECK (auth_type IN ('none','bearer','api_key_header','api_key_query','basic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Check constraint on last_test_status
DO $$ BEGIN
  ALTER TABLE client_api_integrations ADD CONSTRAINT cai_test_status_check
    CHECK (last_test_status IN ('connected','failed') OR last_test_status IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Index for per-client queries
CREATE INDEX IF NOT EXISTS cai_client_id_idx
  ON client_api_integrations (client_id, created_at DESC);

-- Verify
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'client_api_integrations'
 ORDER BY ordinal_position;
