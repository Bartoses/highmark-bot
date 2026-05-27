-- ─────────────────────────────────────────────────────────────────────────────
-- db1_operator_phones_rls.sql — enable RLS on operator_phones + harden trigger fn
-- Run once in Supabase DB1 SQL editor.
--
-- Fixes the Supabase advisor ERROR `rls_disabled_in_public` on
-- public.operator_phones. The Node backend talks to Supabase via the service
-- role key (which bypasses RLS), so no policies are needed — enabling RLS just
-- blocks anon/authenticated keys from reading or modifying operator phone rows.
--
-- Also locks the search_path on the updated_at trigger function (was raising
-- WARN `function_search_path_mutable`).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.operator_phones ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.touch_operator_phones_updated_at()
  SET search_path = public, pg_temp;
