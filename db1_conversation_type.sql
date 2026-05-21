-- ─────────────────────────────────────────────────────────────────────────────
-- db1_conversation_type.sql — Sprint B: separate operator conversations
-- Run once in Supabase DB1 SQL editor.
--
-- Adds conversation_type to public.conversations. Values:
--   'guest'             — customer-facing SMS / web chat (default — existing rows)
--   'internal_operator' — owner or operator_phones row texting the bot in
--                         internal mode. Set automatically when detectOwner
--                         returns true on inbound SMS.
--
-- The portal and analytics endpoints can filter by this column to keep the
-- operator's text-back-and-ask-anything thread out of guest dashboards.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS conversation_type TEXT NOT NULL DEFAULT 'guest'
    CHECK (conversation_type IN ('guest','internal_operator'));

CREATE INDEX IF NOT EXISTS idx_conversations_conversation_type
  ON public.conversations(client_id, conversation_type);

COMMENT ON COLUMN public.conversations.conversation_type IS
  'guest = customer-facing thread; internal_operator = owner/operator internal-mode session. Set automatically at SMS time based on detectOwner.';
