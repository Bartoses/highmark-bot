-- ─────────────────────────────────────────────────────────────────────────────
-- db1_operator_intelligence_2.sql — Operator Intelligence 2.0 (Phase 1)
-- Run once in Supabase DB1 SQL editor.
--
-- Expands operator_phones for role-aware, action-first briefings:
--   • role         — 8 canonical roles (legacy owner/manager/sales/staff kept)
--   • briefing_detail — 4 altitude tiers (legacy auto/summary/detailed kept)
--   • display_name — first name for the conversational greeting ("Good morning, John")
--
-- Additive + non-breaking: CHECK constraints are widened (existing values stay
-- valid), display_name defaults NULL. normalizeRole()/resolveDetailLevel() in
-- code map legacy values to the new canonical set.
-- ─────────────────────────────────────────────────────────────────────────────

-- Role: widen the allowed set (drop + re-add the CHECK).
ALTER TABLE public.operator_phones DROP CONSTRAINT IF EXISTS operator_phones_role_check;
ALTER TABLE public.operator_phones
  ADD CONSTRAINT operator_phones_role_check CHECK (role IN (
    -- legacy (back-compat)
    'owner','manager','sales','staff',
    -- 2.0 canonical
    'general_manager','operations_manager','reservations','fleet','mechanic','guide','marketing'
  ));

-- Detail tier: widen to the 4 named altitudes (keep legacy values).
ALTER TABLE public.operator_phones DROP CONSTRAINT IF EXISTS operator_phones_briefing_detail_check;
-- (the column was originally added without a named constraint in some envs; the
--  DROP above is a no-op there. Re-add a named one covering old + new values.)
ALTER TABLE public.operator_phones
  ADD CONSTRAINT operator_phones_briefing_detail_check CHECK (briefing_detail IN (
    'auto','summary','detailed',                 -- legacy
    'executive','standard','operational','diagnostic'  -- 2.0
  ));

-- Conversational greeting name.
ALTER TABLE public.operator_phones
  ADD COLUMN IF NOT EXISTS display_name TEXT;

COMMENT ON COLUMN public.operator_phones.display_name IS
  'First name for the briefing greeting ("Good morning, John"). Falls back to label, then "team".';
COMMENT ON COLUMN public.operator_phones.role IS
  'Operator role — drives briefing content/ordering. Canonical: owner, general_manager, operations_manager, reservations, fleet, mechanic, guide, marketing. Legacy owner/manager/sales/staff normalized in code.';
COMMENT ON COLUMN public.operator_phones.briefing_detail IS
  'Briefing altitude: executive (owner pulse) | standard (manager actions) | operational (staff play-by-play) | diagnostic (raw). Legacy auto/summary/detailed normalized in code.';

-- Verify:
-- SELECT phone, role, briefing_detail, display_name, locations, digest_types FROM public.operator_phones;
