-- Operator briefings log — Sprint 4A
-- Run once in Supabase DB1 SQL editor

CREATE TABLE IF NOT EXISTS operator_briefings (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id  TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  sent_at    TIMESTAMPTZ DEFAULT NOW(),
  status     TEXT        DEFAULT 'sent'  -- 'sent', 'failed', 'test'
);

CREATE INDEX IF NOT EXISTS idx_operator_briefings_client_id ON operator_briefings(client_id);
CREATE INDEX IF NOT EXISTS idx_operator_briefings_sent_at   ON operator_briefings(sent_at DESC);
