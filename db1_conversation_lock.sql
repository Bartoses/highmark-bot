-- P1-1: optimistic concurrency control for conversations
-- Closes the last read-modify-write race: two concurrent inbound messages from the
-- same phone (or a Twilio retry that slips past the MessageSid idempotency claim) both
-- load the same base row, mutate it, and full-row upsert — last write wins and clobbers
-- a turn. saveConversation() now does a compare-and-swap on lock_version and, on a lost
-- race, reloads + merges the other turn's messages before retrying.
--
-- Additive + non-breaking: existing rows backfill to 0 via the DEFAULT. If this migration
-- is NOT applied, saveConversation() detects the missing column and degrades to the prior
-- full-row upsert (last-write-wins) — so deploying the code before running this is safe.
--
-- Run once in the DB1 (Supabase project qygcmdyxvjlzbmpdpesc "Chatbot") SQL editor.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lock_version integer NOT NULL DEFAULT 0;
