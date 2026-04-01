-- ─────────────────────────────────────────────────────────────────────────────
-- DB1 OPT-OUTS TABLE
-- Moves TCPA opt-out tracking to DB1 so it applies to ALL clients,
-- not just CSR/REA (which has its own CRM in DB2).
-- Run in Supabase DB1 (Primary) → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS opt_outs (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone        text UNIQUE NOT NULL,
  client_id    text,               -- null = opted out of all clients
  opted_out_at timestamptz DEFAULT now(),
  reason       text
);

CREATE INDEX IF NOT EXISTS opt_outs_phone_idx ON opt_outs (phone);
