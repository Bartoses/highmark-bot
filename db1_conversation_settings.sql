-- Migration: per-client conversation settings (Chunk 16)
-- Run in Supabase DB1 SQL editor
--
-- Adds a JSONB column to the clients table for config-driven conversation
-- behavior. All features default to disabled — no existing client is affected
-- until enable_guided_flow is explicitly set to true in the portal.
--
-- conversation_settings shape:
-- {
--   "enable_guided_flow":      false,     -- master switch
--   "show_main_menu_on_start": false,     -- append numbered menu to opener
--   "main_menu_options": [                -- menu items (max 8)
--     { "label": "Book / availability", "key": "booking"    },
--     { "label": "Pricing",             "key": "pricing"    },
--     { "label": "Conditions",          "key": "conditions" },
--     { "label": "Talk to someone",     "key": "handoff"    }
--   ],
--   "enable_recommendations":  true,
--   "enable_smart_followups":  true,      -- Claude weaves next steps into replies
--   "enable_lead_prompts":     true,
--   "lead_capture_triggers":   ["pricing", "availability", "recommendation"],
--   "max_options_per_message": 4
-- }

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS conversation_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
