-- ─────────────────────────────────────────────────────────────────────────────
-- HIGHMARK DB1 — Phase 11.4: Add channel tracking to conversations
-- Run in Supabase Project 1 → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- Tag each conversation with its originating channel.
-- Existing rows get 'sms' (the only channel that existed before Phase 11.4).
-- Web chat rows will get 'web' going forward.
-- Future channels: 'email', 'whatsapp', etc.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel text DEFAULT 'sms';

-- Optional: backfill web rows based on the web: prefix convention
UPDATE conversations
  SET channel = 'web'
  WHERE from_number LIKE 'web:%'
    AND channel = 'sms';

-- Index for analytics queries: "show me all web conversations today"
CREATE INDEX IF NOT EXISTS conversations_channel_idx ON conversations (channel);

COMMENT ON COLUMN conversations.channel IS
  'Originating channel: sms | web. Used for analytics and channel-aware prompt routing.';
