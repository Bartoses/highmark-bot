-- ─────────────────────────────────────────────────────────────────────────────
-- DB2 — Ride Recap v2: simple template switch + route maps (rideRecap.js, sprint-ride-recap-v2-simple.md)
-- Additive + idempotent. APPLIED to DB2 2026-11-23; csr_rea set to template = 'simple' the same day (Sean's go-ahead).
--
--   recap_settings.template  'v1' (default, today's email, unchanged) | 'simple' (one photo, one stat line, one ask per section)
--   recap_tours.map_url      public PNG of the loop's illustrated route map (Supabase Storage recap-maps/<tour-slug>.png).
--                            Used as the hero of a SIMPLE REA recap when there is no ride photo. NULL = no map hero.
--   storage buckets          recap-photos (hosted ride photos, <YYYY-MM-DD>/<booking id>.jpg) + recap-maps — public read,
--                            JPEG/PNG only, 2 MB max per file. Writes need the service key (the bot), nobody else.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recap_settings ADD COLUMN IF NOT EXISTS template text NOT NULL DEFAULT 'v1';
ALTER TABLE public.recap_settings DROP CONSTRAINT IF EXISTS recap_settings_template_check;
ALTER TABLE public.recap_settings ADD CONSTRAINT recap_settings_template_check CHECK (template IN ('v1', 'simple'));

ALTER TABLE public.recap_tours ADD COLUMN IF NOT EXISTS map_url text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('recap-photos', 'recap-photos', true, 2097152, ARRAY['image/jpeg', 'image/png']),
  ('recap-maps',   'recap-maps',   true, 2097152, ARRAY['image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- Grand Tour map (docs/maps/rea-grand-tour-map.png, uploaded to recap-maps/grand-tour.png). Both Grand Tour rows share it.
-- Other loops (First Tracks / Tree Line / Sunset Ride / Rabbit Ears Tour / On-Trail) stay NULL until their maps exist.
UPDATE public.recap_tours
   SET map_url = 'https://aiiguzslqiemksrvfvwk.supabase.co/storage/v1/object/public/recap-maps/grand-tour.png', updated_at = now()
 WHERE client_id = 'csr_rea' AND label = 'Grand Tour' AND map_url IS NULL;
