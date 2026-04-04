-- ─────────────────────────────────────────────────────────────────────────────
-- SEED CLIENTS — Phase 1 Chunk 3
--
-- Migrates the 3 static clients from clients.js into the DB so they become
-- portal-editable. clients.js is kept as a development fallback — at runtime
-- these DB rows take precedence via getAllClients() / resolveClient().
--
-- Safe to run multiple times: ON CONFLICT (id) DO NOTHING skips existing rows.
--
-- Prerequisites (run first if not already done):
--   db1_clients.sql            — base clients table
--   db1_client_settings.sql    — adds campaigns_enabled, followups_enabled, human_handoff_enabled, booking_link
--   db1_crawl_settings.sql     — adds crawl_settings JSONB column
--
-- After running, verify with:
--   SELECT id, name, booking_mode, active FROM clients ORDER BY created_at;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Colorado Sled Rentals + Rabbit Ears Adventures ────────────────────────────
INSERT INTO clients (
  id, slug, name, bot_name, tone,
  inbound_phones,
  support_phone, handoff_phone, support_email,
  address, timezone, hours,
  booking_mode, fareharbor_enabled, crm_enabled, confirmation_texts_enabled,
  waitlist_enabled, lead_capture_enabled, lead_notification_phone,
  fareharbor_companies,
  scrape_urls, snotel_stations, booking_urls,
  services, faq,
  opener_text, handoff_reply_template,
  website_url,
  active,
  campaigns_enabled, followups_enabled, human_handoff_enabled,
  crawl_settings
)
VALUES (
  'csr_rea',
  'csr_rea',
  'Colorado Sled Rentals + Rabbit Ears Adventures',
  'Summit',
  'warm, stoked, genuinely local — like a guide who loves their job. Never robotic. Never a FAQ page.',

  -- Inbound phones (env var override +CSR_REA_TWILIO_NUMBER handled client-side)
  ARRAY['+18335786496'],

  '(970) 439-1707',   -- support_phone (CLIENT_PHONE env var overrides at runtime)
  '(970) 439-1707',   -- handoff_phone
  NULL,               -- support_email

  NULL,               -- address
  'America/Denver',
  NULL,               -- hours are in the scraped KB

  'fareharbor',
  false,              -- fareharbor_enabled (set true via FAREHARBOR_ENABLED env var at runtime)
  true,               -- crm_enabled
  false,              -- confirmation_texts_enabled (flip via CONFIRMATIONS_ENABLED when ready)
  true,               -- waitlist_enabled
  false,              -- lead_capture_enabled
  NULL,               -- lead_notification_phone

  -- fareharbor_companies
  '[
    {"id": "csr", "shortname": "coloradosledrentals", "userKeyEnv": "FAREHARBOR_USER_KEY_CSR", "name": "Colorado Sled Rentals"},
    {"id": "rea", "shortname": "rabbitearsadventures", "userKeyEnv": "FAREHARBOR_USER_KEY_REA", "name": "Rabbit Ears Adventures"}
  ]'::jsonb,

  -- scrape_urls
  ARRAY[
    'https://coloradosledrentals.com/',
    'https://coloradosledrentals.com/faq/',
    'https://coloradosledrentals.com/steamboat-summer/',
    'https://coloradosledrentals.com/kremmling-summer/',
    'https://www.rabbitearsadventures.com/',
    'https://www.rabbitearsadventures.com/faqs'
  ],

  -- snotel_stations
  '[
    {"id": "713:CO:SNTL", "name": "Rabbit Ears Pass",           "elevation": "9,426 ft",  "relevance": "REA tours"},
    {"id": "825:CO:SNTL", "name": "Buffalo Pass (Tower)",        "elevation": "10,610 ft", "relevance": "CSR backcountry / North Routt / Buff Pass"},
    {"id": "369:CO:SNTL", "name": "Columbine",                   "elevation": "8,540 ft",  "relevance": "CSR Columbine trailhead"},
    {"id": "457:CO:SNTL", "name": "Steamboat Ski Resort (base)", "elevation": "8,240 ft",  "relevance": "Steamboat ski area base (3mi from Storm Peak summit)"}
  ]'::jsonb,

  -- booking_urls
  '{
    "csr_browse_all":         "https://fareharbor.com/embeds/book/coloradosledrentals/items/?flow=1262218&full-items=yes&ref=highmark",
    "rea_browse_all":         "https://fareharbor.com/embeds/book/rabbitearsadventures/items/?flow=1491038&full-items=yes&ref=homepage",
    "csr_steamboat_unguided": "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=1262221",
    "csr_kremmling_unguided": "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=1262222",
    "csr_proride_guided":     "https://fareharbor.com/embeds/book/coloradosledrentals/items/?ref=highmark&flow=1470754&full-items=yes",
    "rea_2hr_tour":           "https://fareharbor.com/embeds/book/rabbitearsadventures/?ref=highmark&full-items=yes&flow=1539483",
    "rea_3hr_tour":           "https://fareharbor.com/embeds/book/rabbitearsadventures/items/673348/?ref=highmark&full-items=yes&flow=1491038",
    "rea_private_tour":       "https://fareharbor.com/embeds/book/rabbitearsadventures/items/673358/?ref=highmark&full-items=yes&flow=1491038",
    "all_winter":             "https://fareharbor.com/embeds/book/coloradosledrentals/?ref=highmark&full-items=yes&flow=276228",
    "rzr_steamboat":          "https://adventures.polaris.com/w/adventure/off-road-rental-for-pick-up-steamboat-springs-colorado-P-Q98-AZV?ref=highmark",
    "rzr_kremmling":          "https://adventures.polaris.com/w/adventure/off-road-rental-for-pick-up-steamboat-springs-colorado-P-Q98-AZV?ref=highmark"
  }'::jsonb,

  -- services
  ARRAY['Guided snowmobile tours', 'Self-guided snowmobile rentals', 'RZR off-road adventures'],

  -- faq (in scraped KB — no static FAQ needed)
  '[]'::jsonb,

  NULL,   -- opener_text (uses getSeasonalOpener)
  'Great question for our team! Give us a call at {phone} and we''ll get you sorted 🤙',

  'https://coloradosledrentals.com/',
  true,   -- active

  false,  -- campaigns_enabled
  false,  -- followups_enabled
  true,   -- human_handoff_enabled

  -- crawl_settings
  '{"enabled": true, "primary_url": "https://coloradosledrentals.com/", "seed_urls": ["https://www.rabbitearsadventures.com/"], "max_depth": 2, "max_pages": 30, "deny_patterns": []}'::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ── Lone Pine Performance ─────────────────────────────────────────────────────
INSERT INTO clients (
  id, slug, name, bot_name, tone,
  inbound_phones,
  support_phone, handoff_phone, support_email,
  address, timezone, hours,
  booking_mode, fareharbor_enabled, crm_enabled, confirmation_texts_enabled,
  waitlist_enabled, lead_capture_enabled, lead_notification_phone,
  fareharbor_companies,
  scrape_urls, snotel_stations, booking_urls,
  services, faq,
  opener_text, handoff_reply_template,
  website_url,
  active,
  campaigns_enabled, followups_enabled, human_handoff_enabled,
  crawl_settings
)
VALUES (
  'lone_pine',
  'lone_pine',
  'Lone Pine Performance',
  'Lone Pine',
  'knowledgeable, local, professional, and helpful',

  ARRAY['+18336489744'],

  '(970) 761-2124',
  '(970) 761-2124',
  'jake@lonepineperformance.com',

  '1660 Copper Ridge Ct Unit 101, Steamboat Springs, CO 80487',
  'America/Denver',
  '{"weekdays": "Mon-Fri 9am-5pm", "weekends": "Closed Saturday and Sunday"}'::jsonb,

  'informational',
  false,
  false,
  false,
  true,               -- waitlist_enabled
  true,               -- lead_capture_enabled
  '(970) 761-2124',   -- lead_notification_phone

  '[]'::jsonb,  -- no fareharbor

  ARRAY['https://lonepineperformance.com/'],

  '[]'::jsonb,  -- no snotel stations

  '{}'::jsonb,  -- no booking URLs

  ARRAY['Suspension Revalve', 'Factory Rebuild', 'High Performance Coatings', 'Telemetry Sessions'],

  '[
    {"q": "How do I schedule service?",     "a": "Call (970) 761-2124 or email jake@lonepineperformance.com to get on the calendar."},
    {"q": "What are your hours?",            "a": "Monday through Friday, 9am to 5pm. Closed on weekends."},
    {"q": "Where are you located?",          "a": "1660 Copper Ridge Ct Unit 101, Steamboat Springs, CO 80487."},
    {"q": "What suspension work do you do?", "a": "Suspension revalve, factory rebuild, high performance coatings, and telemetry sessions for mountain bikes, motorcycles, and snow-related suspension."},
    {"q": "Do you work on snowbikes?",       "a": "Yes — snow-related suspension including snowbike and snowmobile suspension is part of what we do."}
  ]'::jsonb,

  'Hey! Lone Pine Performance here — suspension and performance work for bikes, motos, and snow. What can I help you with?',
  'Great question for Jake! Give him a call at {phone} and he''ll get you sorted 🔧',

  'https://lonepineperformance.com/',
  true,

  false,
  false,
  true,

  '{"enabled": true, "primary_url": "https://lonepineperformance.com/", "seed_urls": [], "max_depth": 2, "max_pages": 20, "deny_patterns": []}'::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ── Highmark Demo ─────────────────────────────────────────────────────────────
-- Guided sales demo — deterministic flow via demoFlow.js.
-- isDemo flag and handoffReply function are set in clients.js static entry;
-- the DB row supplies editable fields (name, phones, scrape_urls, etc.)
INSERT INTO clients (
  id, slug, name, bot_name, tone,
  inbound_phones,
  support_phone, handoff_phone, support_email,
  address, timezone, hours,
  booking_mode, fareharbor_enabled, crm_enabled, confirmation_texts_enabled,
  waitlist_enabled, lead_capture_enabled, lead_notification_phone,
  fareharbor_companies,
  scrape_urls, snotel_stations, booking_urls,
  services, faq,
  opener_text, handoff_reply_template,
  website_url,
  active,
  campaigns_enabled, followups_enabled, human_handoff_enabled,
  crawl_settings
)
VALUES (
  'highmark_demo',
  'highmark_demo',
  'Highmark Demo',
  'Highmark',
  'warm, energetic, confident — sales-oriented but not pushy',

  ARRAY['+18668906657'],

  'hello@whiteoutsolutions.co',
  'hello@whiteoutsolutions.co',
  'hello@whiteoutsolutions.co',

  NULL,
  'America/Denver',
  NULL,

  'demo',
  false,
  false,
  false,
  false,
  false,
  NULL,

  '[]'::jsonb,

  ARRAY['https://www.usehighmark.com/home'],

  '[]'::jsonb,

  '{}'::jsonb,

  ARRAY[]::text[],

  '[]'::jsonb,

  NULL,   -- demoFlow.js sends its own opener
  'Questions? Email us at hello@whiteoutsolutions.co 🏔',

  'https://usehighmark.com/',
  true,

  false,
  false,
  true,

  '{"enabled": true, "primary_url": "https://usehighmark.com/", "seed_urls": [], "max_depth": 2, "max_pages": 20, "deny_patterns": []}'::jsonb
)
ON CONFLICT (id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verify
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT id, name, booking_mode, active, array_length(inbound_phones, 1) AS phones
-- FROM clients
-- ORDER BY created_at;
