-- ─────────────────────────────────────────────────────────────────────────────
-- db1_operator_phones.sql — Sprint A: per-phone Operator Intelligence Mode
-- Run once in Supabase DB1 SQL editor.
--
-- Replaces the static clients.owner_phone + clients.operator_phones JSONB with
-- a normalized per-phone table that supports:
--   • per-phone internal-mode access (text-back & ask anything)
--   • per-phone daily digest preferences (enabled, times, types)
--   • per-phone role labeling (owner / manager / sales / staff)
--   • per-phone timezone (defaults to client's primary timezone)
--
-- The legacy columns (clients.owner_phone, clients.operator_phones JSONB) stay
-- in place for backward compatibility and are mirrored at write time from the
-- portal. The bot's runtime detectOwner consults this table first, then falls
-- back to the legacy columns.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.operator_phones (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             TEXT         NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  phone                 TEXT         NOT NULL,                          -- E.164 (+1XXXXXXXXXX)
  label                 TEXT,                                            -- human label e.g. "Owner", "Kremmling Manager"
  role                  TEXT         NOT NULL DEFAULT 'owner'
                                       CHECK (role IN ('owner','manager','sales','staff')),
  internal_mode_enabled BOOLEAN      NOT NULL DEFAULT TRUE,              -- text-back unlocks operator AI
  daily_digest_enabled  BOOLEAN      NOT NULL DEFAULT TRUE,
  digest_times          TEXT[]       NOT NULL DEFAULT ARRAY['06:30'],   -- HH:MM strings in `timezone` (24-hour)
  digest_types          TEXT[]       NOT NULL DEFAULT ARRAY['all'],     -- ['all'] or subset of ['bookings','revenue','leads','staffing','issues','weather']
  timezone              TEXT         NOT NULL DEFAULT 'America/Denver',
  last_digest_sent_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE (client_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_operator_phones_client_id
  ON public.operator_phones(client_id);

CREATE INDEX IF NOT EXISTS idx_operator_phones_digest_enabled
  ON public.operator_phones(client_id)
  WHERE daily_digest_enabled = TRUE;

COMMENT ON TABLE  public.operator_phones IS
  'Per-client operator phones with per-phone internal-mode + daily digest preferences. Replaces clients.owner_phone + clients.operator_phones JSONB.';
COMMENT ON COLUMN public.operator_phones.phone IS
  'E.164 format (+12223334444). Unique per client.';
COMMENT ON COLUMN public.operator_phones.role IS
  'owner | manager | sales | staff — used for permission scoping and digest defaults.';
COMMENT ON COLUMN public.operator_phones.internal_mode_enabled IS
  'When TRUE: this phone triggers the operator AI on inbound SMS (bypasses guest flow).';
COMMENT ON COLUMN public.operator_phones.digest_times IS
  'Array of HH:MM strings in the phone''s timezone. e.g. [''06:30''] for morning only, [''06:30'',''13:00''] for morning+afternoon, [''06:30'',''13:00'',''19:00''] for full.';
COMMENT ON COLUMN public.operator_phones.digest_types IS
  'What sections to include. ''all'' = everything; or subset of bookings/revenue/leads/staffing/issues/weather.';

-- ── Trigger to keep updated_at fresh ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_operator_phones_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_operator_phones_updated_at ON public.operator_phones;
CREATE TRIGGER trg_operator_phones_updated_at
  BEFORE UPDATE ON public.operator_phones
  FOR EACH ROW EXECUTE FUNCTION public.touch_operator_phones_updated_at();

-- ── Backfill from legacy columns ────────────────────────────────────────────
-- Idempotent: ON CONFLICT DO NOTHING on (client_id, phone).

-- 1) Owner phones — clients.owner_phone → role='owner', all defaults
INSERT INTO public.operator_phones (client_id, phone, role, label)
SELECT id, owner_phone, 'owner', 'Owner'
FROM   public.clients
WHERE  owner_phone IS NOT NULL
  AND  owner_phone <> ''
ON CONFLICT (client_id, phone) DO NOTHING;

-- 2) Additional operator phones — clients.operator_phones JSONB array → role='staff'
INSERT INTO public.operator_phones (client_id, phone, role, label)
SELECT
  c.id,
  jsonb_array_elements_text(c.operator_phones)::TEXT AS phone,
  'staff',
  NULL
FROM   public.clients c
WHERE  c.operator_phones IS NOT NULL
  AND  jsonb_typeof(c.operator_phones) = 'array'
  AND  jsonb_array_length(c.operator_phones) > 0
ON CONFLICT (client_id, phone) DO NOTHING;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT client_id, phone, role, daily_digest_enabled, digest_times
-- FROM   public.operator_phones
-- ORDER  BY client_id, role, phone;
