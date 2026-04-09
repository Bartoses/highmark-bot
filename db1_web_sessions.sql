-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 11 — Web Chat Sessions
--
-- Creates web_sessions table for embed widget session tracking.
-- Run in Supabase DB1 SQL editor. Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS web_sessions (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id      text        NOT NULL,
  session_id     text        NOT NULL UNIQUE,
  lead_id        uuid        REFERENCES leads(id) ON DELETE SET NULL,
  created_at     timestamptz DEFAULT now(),
  last_active_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_client_id  ON web_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_session_id ON web_sessions(session_id);

-- RLS: service role (bot) can read/write all; anon cannot
ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'web_sessions' AND policyname = 'service_role_all'
  ) THEN
    CREATE POLICY service_role_all ON web_sessions
      USING (true) WITH CHECK (true);
  END IF;
END $$;
