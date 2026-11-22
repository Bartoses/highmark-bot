-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 (CSR/REA CRM, aiiguzslqiemksrvfvwk) — Ride Recap emails (rideRecap.js)
-- NOT YET APPLIED — for Sean's review. Additive + idempotent; run once in the DB2 SQL editor.
-- Until it is applied the cron job finds no recap_settings table and does nothing.
--
--   recap_settings  one row per client — edit in the Table Editor, no deploy needed
--   recap_tours     FareHarbor item name → template + tour stats (seeded below)
--   recap_log       one row per booking that got (or was folded into) a recap → never twice
--   recap_review    bookings skipped for a DATA problem (no / bad email) — fix in FareHarbor
--   recap_rewards   phase-2 referral rewards (one per referring guest per season) — OFF until reward_code is set
--   email_sends     + category 'recap', + body_text / from_name / photo_hint for the Gmail (Apps Script) drain
-- ─────────────────────────────────────────────────────────────────────────────

-- ── email_sends: recap rows ──────────────────────────────────────────────────
ALTER TABLE public.email_sends DROP CONSTRAINT IF EXISTS email_sends_category_check;
ALTER TABLE public.email_sends
  ADD CONSTRAINT email_sends_category_check CHECK (category IN ('marketing', 'transactional', 'recap'));
ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS body_text  text,    -- plain-text alternative (recaps render their own)
  ADD COLUMN IF NOT EXISTS from_name  text,    -- sender display name for /email/pull ("Rabbit Ears Adventures" | "Colorado Sled Rentals")
  ADD COLUMN IF NOT EXISTS photo_hint jsonb;   -- {date, label, time, file_id?} → Apps Script finds the ride photo in Drive

-- ── settings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recap_settings (
  client_id        text PRIMARY KEY,
  enabled          boolean NOT NULL DEFAULT true,
  send_hour        integer NOT NULL DEFAULT 18 CHECK (send_hour BETWEEN 0 AND 23),   -- local hour; change it any time
  timezone         text    NOT NULL DEFAULT 'America/Denver',
  dry_run          boolean NOT NULL DEFAULT true,                                    -- true = every recap goes to test_to, "[TEST]" subject
  test_to          text    NOT NULL DEFAULT 'sean@coloradosledrentals.com',
  features         text[]  NOT NULL DEFAULT ARRAY['review','share','prints','merch','newsletter'],
  friend_code      text    NOT NULL DEFAULT 'FRIEND10',
  friend_percent   integer NOT NULL DEFAULT 10 CHECK (friend_percent > 0 AND friend_percent < 100),
  reward_code      text,                                                             -- NULL = referral rewards OFF
  weather_lat      numeric,                                                          -- trailhead; NULL = no weather labels
  weather_lon      numeric,
  lookback_days    integer NOT NULL DEFAULT 1 CHECK (lookback_days BETWEEN 0 AND 7), -- also catches rides that ended after yesterday's run
  last_run_on      date,                                                             -- set by the job (local date it last ran)
  last_run_at      timestamptz,
  last_run_summary jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Weather point = the draft's North Routt value (RideRecap.gs "TODO: trailhead coordinates") — confirm or change.
INSERT INTO public.recap_settings (client_id, weather_lat, weather_lon)
VALUES ('csr_rea', 40.53, -106.68)
ON CONFLICT (client_id) DO NOTHING;

-- ── tours ────────────────────────────────────────────────────────────────────
-- match = case-insensitive substring of the FareHarbor item name. Highest priority wins, then the longest match.
-- type 'skip' = never emailed (needed because e.g. "2025 Polaris RZR Experience" also contains "Polaris").
-- Anything that matches nothing (Fuel, Trailer, Ava Bag, Damage Cap, Gift Cards…) gets no email.
CREATE TABLE IF NOT EXISTS public.recap_tours (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text    NOT NULL DEFAULT 'csr_rea',
  match         text    NOT NULL,
  type          text    NOT NULL CHECK (type IN ('rea', 'backcountry', 'rental', 'skip')),
  label         text,                     -- shown in the email AND used to find the photo ("Grand Tour 11am - Jake - 01.jpg")
  miles         numeric,                  -- blank = tile hidden
  high_point_ft integer,                  -- blank = tile hidden
  stops         text[]  NOT NULL DEFAULT '{}',   -- REA only; empty = section hidden
  priority      integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recap_tours_client_match_key UNIQUE (client_id, match)
);
INSERT INTO public.recap_tours (client_id, match, type, label, priority) VALUES
  ('csr_rea', 'Grand Tour',      'rea',         'Grand Tour',                 0),
  ('csr_rea', 'Grand "Private" Tour', 'rea',  'Grand Tour',                 0),   -- "3 Hour Grand \"Private\" Tour" has no "Grand Tour"
  ('csr_rea', 'First Tracks',    'rea',         'First Tracks',               0),
  ('csr_rea', 'Tree Line',       'rea',         'Tree Line',                  0),
  ('csr_rea', 'Sunset Ride',     'rea',         'Sunset Ride',                0),
  ('csr_rea', 'Rabbit Ears',     'rea',         'Rabbit Ears Tour',           0),
  ('csr_rea', 'On-Trail Guided', 'rea',         'On-Trail Guided Tour',       0),
  ('csr_rea', 'Backcountry',     'backcountry', 'Private Guided Backcountry', 0),
  ('csr_rea', 'Polaris',         'rental',      'Polaris rental',             0),
  ('csr_rea', 'RZR',             'skip',        'RZR',                        10)
ON CONFLICT (client_id, match) DO NOTHING;

-- ── log / review ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recap_log (
  booking_id         text PRIMARY KEY,           -- bookings.fareharbor_pk ('#392519085')
  client_id          text NOT NULL DEFAULT 'csr_rea',
  primary_booking_id text,                       -- the booking the email was built from (orders with several sleds → one email)
  email              text,                       -- the guest
  sent_to            text,                       -- = test_to while dry_run
  type               text,                       -- rea | backcountry | rental
  send_id            uuid,                       -- email_sends.id (status, opens, clicks live there)
  dry_run            boolean NOT NULL DEFAULT true,
  photo              boolean,                    -- set when Apps Script reports the send (true = Drive photo attached)
  weather            boolean,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);
CREATE INDEX IF NOT EXISTS recap_log_send_idx  ON public.recap_log (send_id);
CREATE INDEX IF NOT EXISTS recap_log_email_idx ON public.recap_log (email);

CREATE TABLE IF NOT EXISTS public.recap_review (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   text NOT NULL DEFAULT 'csr_rea',
  booking_id  text NOT NULL,
  email       text,
  reason      text NOT NULL,                     -- no_email | invalid_email
  found_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT recap_review_booking_reason_key UNIQUE (booking_id, reason)
);

-- ── referral rewards (phase 2, disabled while recap_settings.reward_code IS NULL) ──
CREATE TABLE IF NOT EXISTS public.recap_rewards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL DEFAULT 'csr_rea',
  season              text NOT NULL,             -- '2026-27' (Jul–Jun)
  referrer_booking_id text NOT NULL,
  referrer_email      text NOT NULL,
  friend_booking_id   text NOT NULL,             -- the new booking whose ?ref= was friend-<id>
  send_id             uuid,
  dry_run             boolean NOT NULL DEFAULT true,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recap_rewards_friend_key UNIQUE (friend_booking_id),
  CONSTRAINT recap_rewards_referrer_season_key UNIQUE (client_id, referrer_email, season)
);

-- service role bypasses RLS; no public policies (same as email_sends)
ALTER TABLE public.recap_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recap_tours    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recap_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recap_review   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recap_rewards  ENABLE ROW LEVEL SECURITY;
