# Highmark — AI SMS Concierge

Built by Whiteout Solutions. An AI-powered SMS concierge for outdoor activity businesses — tour operators, rental companies, lodges. Handles guest inquiries, live weather/conditions, tour booking menus, confirmation texts, and CRM — all over SMS.

**Clients:** CSR/REA — +18335786496 (pending) · demo: +18668906657 | Lone Pine Performance — +18336489744 (pending)
**Production URL:** https://highmark-bot-production.up.railway.app

---

## What It Does

A guest texts the business number. Summit (the AI persona) responds instantly with:
- Seasonal opener with weather conditions + trail status
- Snow forecast and live pass conditions (OpenWeather API, refreshed hourly)
- Tour/rental booking menu with real-time availability from FareHarbor
- Direct individual booking URLs per tour item
- Same-day booking policy enforcement (min 1 day advance)
- Auto-escalation to human staff for groups 6+, complaints, or frustrated guests
- Booking confirmation texts when FareHarbor webhooks fire
- 30-minute follow-up text after booking
- Full TCPA compliance (STOP/HELP/opt-out)

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express on Railway (auto-deploy from GitHub `main`) |
| SMS | Twilio |
| AI | Claude claude-sonnet-4-6 (Anthropic SDK) |
| DB1 | Supabase — conversations + knowledge base |
| DB2 | Supabase CRM — contacts, campaigns, opt-outs |
| Bookings | FareHarbor API (Tier 2 only) |
| Weather | OpenWeather API |

---

## File Structure

```
clients.js              — per-client config registry + resolveClient(toNumber) — ADD NEW CLIENTS HERE
index.js                — Express server, SMS webhook, all bot logic, rate limiting, booking state machine
knowledgeBase.js        — FH items (24hr) + availability (3hr) + weather (1hr) + website scraper (7 days)
bookingConfirmations.js — FareHarbor webhook receiver + 30-min polling + confirmation/follow-up texts
crm.js                  — contacts, campaigns, TCPA opt-out/opt-in, auto-tagging
chat.js                 — local terminal chat simulator (no Twilio cost)
test.js                 — automated test suite, 169 tests, spawns its own server on port 3099
leads.js                — lead capture module: saveLead() + notifyBusinessOfLead()
adminLeads.js           — admin lead management routes: list, update, summary
db1_lead_capture.sql    — migration: lead_step/lead_data columns + leads table
db1_waitlist.sql        — migration: waitlist_pending/waitlist_context + lead_type on leads
db1_lead_mgmt.sql       — migration: extended status values + updated_by audit column on leads
virtual-test.sh         — Twilio Virtual Phone test runner (10 scenarios)
db1_schema.sql          — Supabase DB1 migration (conversations + knowledge_base + settings)
db2_crm_schema.sql      — Supabase DB2 CRM migration (contacts, campaigns, opt_outs)
railway.json            — Railway deployment config
PROMPTS.md              — Session starter prompts for Claude Code
```

---

## Local Development

```bash
npm install

# Interactive chat simulator — no Twilio cost, no SMS sent
npm run chat
# Commands: /reset (fresh conversation), /quit

# Full automated test suite (169 tests)
npm test

# Server in TEST_MODE for curl testing
npm run dev:test
```

---

## Twilio Virtual Phone Testing

Real Twilio flow — texts go through the live bot on Railway.

1. Ensure `TEST_MODE` is NOT set on Railway
2. Twilio number webhook → `https://highmark-bot-production.up.railway.app/sms` (HTTP POST)
   - Demo (active): `+18668906657`
   - CSR/REA primary (pending): `+18335786496`
   - Lone Pine (pending): `+18336489744`
3. Run a scenario:

```bash
chmod +x virtual-test.sh
./virtual-test.sh        # show all scenarios
./virtual-test.sh 1      # new guest greeting
./virtual-test.sh 2      # snow conditions
./virtual-test.sh 3      # beginner booking flow
./virtual-test.sh 9      # DEMO trigger
```

Virtual Phone numbers:
- Inbound (acts as customer): `+18777804236`
- Demo / CSR+REA fallback: `+18668906657` (use this until new numbers are verified)
- CSR/REA primary: `+18335786496` (pending verification)
- Lone Pine: `+18336489744` (pending verification)

Scenarios: 1=greeting, 2=snow conditions, 3=beginner booking, 4=experienced rider, 5=group of 8 handoff, 6=explicit handoff, 7=sentiment escalation, 8=reservation lookup, 9=DEMO trigger, 10=SUMMITDEMO

---

## Deploy a New Instance (new client)

### 1 — Push to GitHub
```bash
git push origin main
```

### 2 — Create Railway project
Railway → New Project → Deploy from GitHub repo → select `highmark-bot`

### 3 — Set environment variables
```
# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# AI
ANTHROPIC_API_KEY=

# Supabase DB1 (conversations + KB)
SUPABASE_URL=
SUPABASE_KEY=

# Supabase DB2 (CRM)
CRM_SUPABASE_URL=
CRM_SUPABASE_KEY=

# Client config (changes per client)
CLIENT_NAME=
CLIENT_PHONE=
HANDOFF_PHONE=
CLIENT_EMAIL=
CLIENT_ID=

# FareHarbor (Tier 2 only)
FAREHARBOR_ENABLED=false
FAREHARBOR_APP_KEY=
FAREHARBOR_USER_KEY_CSR=
FAREHARBOR_USER_KEY_REA=

# Booking confirmations
CONFIRMATIONS_ENABLED=false
CONFIRMATIONS_TEST_PHONE=

# Weather
OPENWEATHER_API_KEY=
```

### 4 — Connect Twilio
Twilio Console → Phone Numbers → Messaging → Webhook → `https://your-railway-url.up.railway.app/sms` (POST)

### 5 — Health check
```bash
curl https://your-railway-url.up.railway.app/
# Expected: {"status":"Highmark running ✅", "season":"winter", ...}
```

---

## Architecture

### SMS Flow (per message)
1. Twilio POSTs to `/sms`
2. Rate limiting (IP: 30/min, phone: 10/min) — 429 returns silent TwiML
3. TCPA check: STOP/HELP/START processed before anything else
4. Opted-out gate: message dropped silently if number is in opt_outs
5. Conversation loaded from Supabase (or created fresh)
6. Intent + sentiment classification
7. Booking state machine (null → 1 → 2 → 3 → 4)
8. Handoff gate: non-booking/conditions intents blocked if in handoff state
9. Claude called with full system prompt + KB context injected
10. Response saved to Supabase, returned as TwiML

### Knowledge Base Context (injected into every Claude call)
Four sections, always in this order:
- `WEATHER` — Steamboat + Rabbit Ears Pass conditions, 3-day forecast
- `AVAILABILITY` — open slot counts + next open date per tour (FH minimal API)
- `TOUR DETAILS` — item names, descriptions, price ranges from FH items API
- `BUSINESS INFO` — policies, seasonal hours, FAQ from website scrape

### Knowledge Base Refresh Schedule (zero Claude tokens for FH/weather)
| Data | Schedule | Method |
|---|---|---|
| FH items (catalog + pricing) | Every 24hr | JS-built from FH API, no Claude |
| FH availability (slot counts) | Every 3hr | JS-built from FH minimal endpoint, no Claude |
| Weather | Every 1hr | JS-built from OpenWeather JSON, no Claude |
| Website (policies, FAQ) | Every 7 days | Single Haiku call, hash-gated (skips if unchanged) |

### Booking State Machine
- `null` — not started
- `1` — tour menu shown, guest picking (menuOptions stored in bookingData)
- `2` — booking link sent
- `3` — confirmation text sent (pre-seeded by bookingConfirmations.js)
- `4` — 30-min follow-up sent

### Booking Rules
- Same-day bookings not allowed — minimum 1 day advance
- Groups 6+ always handed off to staff
- Menu shows numbered REA tour options + CSR browse-all link
- Individual item URLs built from cached FH PKs (auto-updates when new items added)

### Rate Limiting
Two layers on `/sms`:
- IP limiter: 30 req/min per IP (express-rate-limit package)
- Phone limiter: 10 msg/min per phone number (in-memory Map, 5-min prune)
Both return empty TwiML `<Response></Response>` on 429 so Twilio doesn't retry.

### TCPA Compliance Order
1. STOP/UNSUBSCRIBE/QUIT/END/CANCEL → opt-out + confirmation text
2. START/UNSTOP → opt-in + confirmation text
3. HELP → program info + frequency + STOP instruction (works for opted-out numbers)
4. Opted-out gate → silently drop message
5. Normal processing

### Special Triggers
- `DEMO` — resets + sends Highmark-branded opener + notifies owner at +17202892483
- `SUMMITDEMO` — resets conversation + sends seasonal opener (internal demos)

### Conversation Stage Machine
`convo.stage` tracks engagement level per turn (stored in `booking_data._stage`, no migration):
`new → discovery → engaged → considering → high_intent → lead_captured → closed | handoff`
- `detectBuyingSignals()` classifies each message (none/low/medium/high strength + named signals)
- `updateConversationStage()` advances stage, never downgrades, frustrated→handoff
- `shouldAttemptLeadCapture()` proactively triggers a soft lead ask at considering+ with medium/high signal
- `extractLeadInfo()` pulls explicit phone/email from message text
- `detectIntent` expanded to include `recommendation` intent
- Both system prompts include RESPONSE PRIORITY + PACING blocks

### Context-Aware Personality
Both system prompts include a `PERSONALITY & TONE` block. Claude classifies each message (playful sarcasm, bravado, irritated, literal) and adapts:
- Energy matching: playful → playful; concise → concise; frustrated → no humor
- Humor tied to the specific offering, machine, or trail — never generic
- Tone tightens as conversation moves toward booking or support
- Never re-asks questions already answered in prior turns
Base voice set by `client.tone` in `clients.js`. Automatically inherited by all future clients.

### Message Length
Default 320 chars (2 texts). `enforceLength(text, max=320)` — never truncates URLs.

---

## Tier Model

| Tier | Price | Features |
|---|---|---|
| Tier 1 | $200-300/mo | Bot Q&A + static booking links (`FAREHARBOR_ENABLED=false`) |
| Tier 2 | $400-500/mo | Real-time availability + live KB refresh (`FAREHARBOR_ENABLED=true`) |

---

## Running Costs (estimate at 500 conversations/mo)

| Service | Cost |
|---|---|
| Railway | ~$5/mo |
| Twilio | ~$0.0079/msg (send + receive) |
| Claude API | ~$0.003/conversation (Sonnet for replies, Haiku for website) |
| OpenWeather | Free tier |
| Supabase | Free tier (2 projects) |
| **Total** | **~$10-20/mo** |

---

## CRM (crm.js)

- Auto-creates contact records on first text
- Auto-tags contacts: `first_timer`, `experienced`, `group`, `returning`
- Campaign table for bulk SMS sends (sending via Twilio not yet wired — see CLAUDE.md TODOs)
- Opt-out registry (`opt_outs` table) — TCPA-compliant, never delete records
- RLS enabled on all 4 CRM tables; service role key bypasses automatically

---

## Booking Confirmations (bookingConfirmations.js)

- Listens at `/fareharbor/webhook` for FareHarbor booking events
- Falls back to 30-min polling if webhooks miss
- Sends confirmation text to guest (name, tour, date, time, location)
- Sends 30-min follow-up text
- Idempotency log in `confirmations_sent` table (never double-sends)
- `CONFIRMATIONS_ENABLED=false` until tested end-to-end

---

Built by Whiteout Solutions · Steamboat Springs, CO
