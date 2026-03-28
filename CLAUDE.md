# Highmark Bot — Project Instructions

## What This Is
Summit is an AI SMS concierge built by Whiteout Solutions as a POC to demo to Steamboat Springs outdoor businesses (tour operators, lodges, activity companies) what an AI-powered guest texting service can do. Stack: Twilio + Claude API + Node.js/Express, deployed on Railway.

**Clients:**
- Colorado Sled Rentals + Rabbit Ears Adventures (CSR/REA) — +18335786496 (pending verification) | demo: +18668906657 (active)
- Lone Pine Performance — +18336489744 (pending verification)

**Railway URL:** https://highmark-bot-production.up.railway.app

---

## Roadmap
Before starting any new feature or task, read the `Roadmap` file in this directory. It defines the current state, phase priorities, and the strict order of next builds. Use it to understand what to build next and to avoid work that conflicts with planned direction.

---

## Rules — Follow These on Every Change
1. **Read the Roadmap** — check `Roadmap` to confirm the task aligns with current priorities
2. **Write tests** — add or update test cases covering the change
3. **Test locally** — run the full test suite and verify all scenarios pass
4. **Deploy** — commit and push to GitHub; Railway auto-deploys from `main`
5. **End-to-end verify** — run the Railway health check and confirm the deploy is live
6. **Update docs** — update CLAUDE.md, README.md, Roadmap, and memory files to reflect the change

---

## File Structure
```
Roadmap                — project phases, priorities, next 5 builds — READ THIS BEFORE STARTING ANY TASK
clients.js             — per-client configuration registry + resolveClient(toNumber) — ADD NEW CLIENTS HERE
index.js               — main Express server, SMS webhook, all bot logic, booking state machine
knowledgeBase.js       — FH items (24hr cron) + FH availability (3hr cron) + weather (1hr cron) + website (7-day cron, hash-gated)
bookingConfirmations.js — FareHarbor webhook receiver + 30min polling + confirmation texts
crm.js                 — contacts, campaigns, opt-out/opt-in (TCPA), auto-tagging
chat.js                — interactive terminal chat simulator (no Twilio cost)
scheduler.js           — durable scheduled SMS: scheduleMessage() + processScheduledMessages()
cron-worker.js         — standalone Railway cron service entry point (node cron-worker.js, */5 * * * *)
test.js                — automated test suite (301 tests), spawns its own server on port 3099
demoFlow.js            — guided demo state machine for bookingMode=demo clients (Chunk 7)
leads.js               — lead capture module: saveLead() + notifyBusinessOfLead() for informational clients
adminLeads.js          — admin lead management: list, update, summary routes (Chunk 5)
adminClients.js        — client provisioning: create/update/list/readiness routes (Chunk 6)
db1_clients.sql        — migration: creates clients table for DB-backed client provisioning (Chunk 6)
db1_lead_capture.sql   — migration: adds lead_step/lead_data to conversations + creates leads table
db1_waitlist.sql       — migration: adds waitlist_pending/waitlist_context to conversations + lead_type to leads
db1_lead_mgmt.sql      — migration: extended status values + updated_by audit column on leads
db1_lead_name.sql      — migration: adds contact_email to leads table (run after db1_lead_mgmt.sql)
db1_cancellation_sent.sql — migration: adds cancellation_sent column to confirmations_sent
virtual-test.sh        — Twilio Virtual Phone test runner (10 scenarios)
db1_schema.sql         — DB1 migration (Supabase Project 1 SQL editor)
db2_crm_schema.sql     — DB2 CRM schema (Supabase Project 2 SQL editor)
railway.json           — Railway deployment config
PROMPTS.md             — Session starter prompts
.env                   — local secrets (never commit)
```

---

## Multi-Client Architecture

Client config lives in `clients.js` — edit that file to add or update clients.
Each client entry defines: `id`, `botName`, `tone`, `inboundPhones`, `supportPhone`, `handoffPhone`,
`bookingMode` (`fareharbor` | `informational` | `lead_capture`), `fareharborCompanies`, `scrapeUrls`,
`snotelStations`, `bookingUrls`, `services`, `faq`, `hours`, `crmEnabled`, `openerText`, `handoffReply`.

**To onboard a new client:**
1. Add an entry to `CLIENTS` in `clients.js`
2. Set `LONE_PINE_TWILIO_NUMBER` (or `<CLIENT>_TWILIO_NUMBER`) env var in Railway
3. No other code changes required — `resolveClient(toNumber)` routes automatically

**bookingMode values:**
- `fareharbor` — FareHarbor booking menu + real-time availability (CSR/REA)
- `informational` — Q&A + optional lead capture flow if `leadCaptureEnabled: true` (Lone Pine)

**Current clients:**
| Client | ID | Mode | Twilio Number |
|---|---|---|---|
| Colorado Sled Rentals + Rabbit Ears Adventures | `csr_rea` | `fareharbor` | +18335786496 (pending) · demo: +18668906657 |
| Lone Pine Performance | `lone_pine` | `informational` | +18336489744 (pending) |

**Railway env vars still needed per deployment:**
- `FAREHARBOR_ENABLED` — `true` for Tier 2 FH access
- `CONFIRMATIONS_ENABLED` — `true` when ready to text real guests
- `CONFIRMATIONS_TEST_PHONE` — redirect all confirmation texts here while testing
- `CLIENT_PHONE` / `HANDOFF_PHONE` — overrides csr_rea defaults if needed

---

## Testing

### Local interactive chat (no Twilio cost)
```bash
npm run chat
```
Commands: `/reset` (fresh conversation), `/quit`

### Full automated test suite
```bash
npm test
```
Spawns its own server on port 3099. Runs all 116 scenarios automatically.

### Server + curl tests (TEST_MODE)
**Terminal 1:**
```bash
npm run dev:test
```
**Terminal 2 — example curl tests:**
```bash
# Health check
curl http://localhost:3000/

# Fresh greeting
curl -s -X POST http://localhost:3000/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=Hey&From=%2B15550001234&To=%2B15559999999"

# Reset conversation
curl -s -X POST http://localhost:3000/reset \
  -H "Content-Type: application/json" \
  -d '{"from":"+15550001234"}'
```

### Twilio Virtual Phone testing (real Twilio flow)
Requires: Twilio number webhook set to `https://highmark-bot-production.up.railway.app/sms`, `TEST_MODE` NOT set on Railway.

```bash
chmod +x virtual-test.sh
./virtual-test.sh          # show scenario menu
./virtual-test.sh 1        # new guest greeting
./virtual-test.sh 3        # beginner booking flow
./virtual-test.sh 9        # DEMO trigger (owner notified)
```

Virtual Phone numbers:
- Bot demo number (From): `+18668906657` (active — use for demos until new numbers verified)
- Bot CSR/REA primary (From): `+18335786496` (pending Twilio verification)
- Bot Lone Pine (From): `+18336489744` (pending Twilio verification)
- Virtual Phone (acts as customer): `+18777804236`

Scenarios: 1=greeting, 2=snow conditions, 3=beginner booking, 4=experienced rider, 5=group of 8 handoff, 6=explicit handoff, 7=sentiment escalation, 8=reservation lookup, 9=DEMO trigger, 10=SUMMITDEMO

### Key scenarios to verify after every change
1. **Greeting** — fresh number gets the seasonal hardcoded opener
2. **Weather/forecast** — "snow forecast" returns live temps + 3-day forecast from LIVE DATA
3. **Booking menu** — "I want to book a tour" → numbered list of REA tours + CSR browse link
4. **Tour pick** — reply "2" → correct individual booking link sent
5. **No availability** — date with no slots → explicit message + browse-all links
6. **Same-day** — "can I book for today" → policy message + next available date
7. **Handoff** — "I want to speak to a person" returns handoff with client.handoffPhone
8. **Booking after handoff** — asking about tours after handoff re-engages (does NOT get redirect)
9. **HELP** — returns program info + STOP instruction + phone number
10. **STOP** — opt-out confirmation sent, subsequent messages dropped
11. **Reset** — `/reset` clears conversation and greeting fires again
12. **Rate limiting** — 11th message from same phone in 1 min returns 429

---

## Deployment
```bash
git add <changed files>    # never commit .env
git commit -m "your message"
git push origin main
```
Then verify:
```bash
curl https://highmark-bot-production.up.railway.app/
```
Expected: `{"status":"Highmark running ✅", ...}`

---

## Architecture Notes

### SMS Flow (per message, in order)
1. Rate limiting (IP + phone)
2. STOP/HELP/START keywords (TCPA — processed before anything else)
3. Opted-out gate (silently drop)
4. Load conversation from Supabase
5. Intent + sentiment classification
6. Booking mode routing (per client.bookingMode):
   - `fareharbor`: booking state machine (null → 1 → 2) + FareHarbor tour menu
   - `informational`: booking intent → phone CTA via Claude, no state machine
7. Claude called with system prompt + KB context (prompt dispatched by bookingMode)
8. Save conversation to Supabase, return TwiML
9. CRM upsert/tagging — only if `client.crmEnabled` is true

### Conversation Stage Machine
Tracked in `convo.stage` (stored inside `booking_data._stage` — no schema migration needed):
`new → discovery → engaged → considering → high_intent → lead_captured → closed | handoff`
- `updateConversationStage(convo, buyingSignals, intent, sentiment)` — runs once per turn, never downgrades, frustrated→handoff
- `detectBuyingSignals(body, convo)` → `{ strength: none|low|medium|high, signals[], inferredGoal }`
- `shouldAttemptLeadCapture(convo, signals, client)` — fires proactive soft ask at considering+ with medium/high signal; respects all guard conditions (min 2 turns, not frustrated, not already attempted)
- `extractLeadInfo(body)` — pulls phone/email from message text; used in waitlist + organic YES handlers
- `buildLeadCapturePrompt(client, inferredGoal)` — context-aware soft ask matched to brand and conversation goal
- `detectIntent` expanded: adds `recommendation` for "what's best for me / which option" messages
- TEST_MODE meta: now includes `stage`, `buyingSignalStrength`, `buyingSignals`
- Response priority + pacing rules added to both system prompts (RESPONSE PRIORITY + PACING blocks)
- SMS channel awareness: bot never asks for phone number (already have it from `From`); on YES asks for name only; saves lead after name received
- Name capture pre-flight: `leadCapturePendingName` flag stored in `booking_data._leadCapturePendingName`; resolves before waitlist pre-flight
- `saveLead()` uses `contact_name` column; `contact_email` included only post-migration (`db1_lead_name.sql`)
- 243/243 tests pass

### Commercial Decision Layer (index.js)
Deterministic logic layer that runs before every Claude call to enforce answer-first, expertise-first behavior:

- `scoreBuyingIntent(body, convo)` → `{ score: 0-100, strength, reasons[] }` — numeric weighted scoring; 15+ = low, 35+ = medium, 60+ = high
- `needsExpertiseFirst(intent, buyingSignals, convo)` → boolean — returns true when bot must answer/recommend BEFORE any lead capture attempt; clears once `commercialState.recommendationGiven = true`
- `getMicroClose(client, inferredGoal)` → string — per-client soft close library; one ask only, never stacked
- `buildResponsePlan(intent, sentiment, buyingSignals, convo, client)` → plan object — deterministic pre-call decision: `{ primaryGoal, mustRecommend, mustIncludeLocalContext, shouldSoftClose, shouldAttemptLeadCapture, forbiddenMoves[], microClose }`
- `formatResponsePlanInstruction(plan, client)` → string — converts plan to Claude instruction injected as CURRENT CONTEXT
- `containsPhoneAsk(text)` → boolean — post-gen validator; if true, response is regenerated once with a correction instruction
- `commercialState` persisted in `booking_data._commercialState` (no schema migration): `{ recommendationGiven, leadCaptureAttempts }`
- `recommendationGiven` set to true in DEFAULT block after any `recommendation` intent response — unlocks proactive lead capture on next turn
- Proactive lead capture block now requires `!needsExpertiseFirst()` — recommendation turns always answer first
- TEST_MODE meta includes `recommendationGiven`

### Context-Aware Personality
Both system prompts (`buildSystemPromptCsrRea` and `buildSystemPromptInformational`) include a `PERSONALITY & TONE` block that instructs Claude to:
- Match energy to the guest (playful → playful, concise → concise, frustrated → no humor)
- Classify sarcasm before responding: playful bravado vs. irritated vs. literal
- Tie any humor to the specific offering, machine, or trail being discussed — never generic
- Tighten tone as the conversation moves toward booking or support resolution
- Never re-ask questions already answered in prior turns
The base voice is set by `client.tone` in `clients.js`. The PERSONALITY & TONE block governs how that voice adapts in real time. Automatically inherited by all future clients via `bookingMode`.

### Rate Limiting
Two layers on `/sms`:
- **IP limiter** — 30 req/min per IP (express-rate-limit)
- **Phone limiter** — 10 msg/min per phone number (in-memory Map)
Both return `<Response></Response>` TwiML on 429 so Twilio doesn't retry.

### Conversation Store
Persisted in Supabase DB1 `conversations` table, keyed by (from_number, to_number):
```js
{
  messages:               [{ role, content, timestamp, intent, sentiment }],
  booking_step:           null | 1 | 2 | 3 | 4,
  booking_data:           { activity, date, groupSize, company, booking_pk, menuOptions },
  handoff:                false,
  consecutive_frustrated: 0,
  session_type:           "live" | "test",
  client_id:              "csr_rea"
}
```

### Booking State Machine
- `null` — not started
- `1` — tour menu shown, waiting for guest to pick (menuOptions stored in bookingData)
- `2` — booking link sent
- `3` — confirmation text sent (pre-seeded by bookingConfirmations.js)
- `4` — 30-min follow-up sent

### Booking Rules
- Same-day bookings NOT allowed — minimum 1 day advance booking required
- Availability window always starts from tomorrow in both KB refresh and real-time checks
- Groups 6+ always handoff
- `informational` clients never enter the FH booking state machine
  - If `leadCaptureEnabled: true`: booking intent starts 3-step lead capture flow (service → callback → timeframe)
  - Otherwise: booking intent routes directly to phone CTA

### Lead Capture Flow (leads.js + informational mode)
Used by Lone Pine Performance — collects service request without pretending to confirm appointments.
- **Step 1** (leadStep=1): bot asks what service is needed; includes phone CTA as escape hatch
- **Step 2** (leadStep=2): bot asks for callback number; "same" uses guest's inbound number
- **Step 3** (leadStep=3): bot asks for preferred timeframe
- **Complete** (leadStep→null): `saveLead()` writes to `leads` table; `notifyBusinessOfLead()` SMS to `client.leadNotificationPhone`; confirmation sent to guest
- Abort: guest replies with "call/phone/never mind/cancel/skip" during step 1 → handoffReply
- DB: `lead_step` (int) + `lead_data` (jsonb) columns on `conversations` — migration: `db1_lead_capture.sql`

### Per-Client Behavior Config (clients.js fields)
- `bookingMode` — `fareharbor` | `informational`
- `leadCaptureEnabled` — enables 3-step lead capture for informational clients
- `leadNotificationPhone` — SMS destination for new lead notifications
- `crmEnabled` — gates all CRM upsert/tagging; `false` means no contact records created
- `openerText` — first-message text (overrides getSeasonalOpener generic logic)
- `handoffReply(phone)` — function returning text sent on explicit handoff intent

### Admin Lead Management (adminLeads.js — Chunk 5)
Internal API for viewing and updating captured leads. Protected by `requireUiAccess` (same `UI_SECRET` as the UI console).

**Routes:**
- `GET /admin/leads` — paginated list; query params: `client_id`, `status`, `lead_type`, `limit` (default 50), `offset` (default 0); newest first
- `PATCH /admin/leads/:id` — update `status`, `notes`, and/or `updated_by`; returns updated lead
- `GET /admin/leads/summary` — aggregate counts; query param: `client_id`; returns `{ by_status, by_type, total }`

**Valid statuses:** `new | contacted | scheduled | closed | ignored`

**Migrations required:**
- `db1_lead_mgmt.sql` — adds check constraint for status values + `updated_by` audit column

**Access:**
```bash
curl "https://highmark-bot-production.up.railway.app/admin/leads?key=YOUR_UI_SECRET"
curl -X PATCH "https://highmark-bot-production.up.railway.app/admin/leads/LEAD_ID?key=YOUR_UI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"status":"contacted","notes":"Left voicemail"}'
```

### Admin Client Provisioning (adminClients.js — Chunk 6)
Internal API for adding and managing clients without code edits. Protected by `requireUiAccess`.

**Routes:**
- `GET /admin/clients` — list all clients (static + DB-backed) with readiness; optional `?active=true/false`
- `GET /admin/clients/:id` — single client with readiness summary
- `POST /admin/clients` — create new DB-backed client; applies defaults automatically
- `PATCH /admin/clients/:id` — update DB-backed client (static clients → 400, edit `clients.js`)

**Validation on create/update:**
- `id`: required, lowercase alphanumeric + underscores, unique
- `booking_mode`: one of `fareharbor | informational | lead_capture`
- `inbound_phones`: E.164 format, globally unique across all clients
- Static clients (in `clients.js`) are read-only via API

**Defaults applied on create:**
- `bot_name`: "Summit" | `tone`: "warm, helpful, and knowledgeable" | `timezone`: "America/Denver"
- `active`: true | `waitlist_enabled`: true | all feature flags: false
- `website_url`: auto-set from first `scrape_urls` entry if not provided

**Readiness checks** (`computeReadiness(client)`):
- `inbound_phone` — at least 1 Twilio number assigned
- `website_or_scrape` — website_url or scrape_urls present
- `support_contact` — support_phone or handoff_phone set
- `booking_mode` — valid mode set
- `bot_identity` — bot_name set

**Runtime loading:** `initClients(supabase)` runs at server startup, loads active DB rows into `_runtimeClients` via `loadDbClients()`. `resolveClient()` checks DB clients first, then static clients. After create/update, registry reloads automatically (no restart needed).

**Migration required:** `db1_clients.sql` — run in Supabase DB1 SQL editor before first use.

**Access:**
```bash
curl "https://highmark-bot-production.up.railway.app/admin/clients?key=YOUR_UI_SECRET"
curl -X POST "https://highmark-bot-production.up.railway.app/admin/clients?key=YOUR_UI_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"id":"new_client","name":"New Business","booking_mode":"informational","support_phone":"(970) 555-0001","website_url":"https://example.com"}'
```

### Demo Mode (demoFlow.js)
Guided, conversion-focused sales demo for prospects. No AI calls, no real APIs. Fully deterministic.

**Design principle:** This is a sales tool, not just a demo. Every response has a clear next step. No dead ends.

**Client:** `highmark_demo` in `clients.js` — owns +18668906657. `bookingMode: "demo"`, `isDemo: true`.

**Demo number:** +1 866 890 6657. Routes to `handleDemoFlow()` in index.js before any production logic.

**Flow overview:**
1. First text → opener with 4 options (Q&A / Lead Capture / Booking / Get started)
2. Pick 1/2/3 → feature path intro (simulated customer interaction)
3. Any reply → value followup + unexplored paths OR stronger CTA if all paths seen
4. YES / "4" / "get this" → lead capture (name → business → website) → save + notify admin
5. `complete` is NOT a dead end — MENU, path picks, and YES all work

**State machine steps:** `awaiting_menu → path_intro → path_followup → [path_cta] → lead_name → lead_business → lead_website → complete`

**State persisted in:** `conversations.booking_data._demo` (JSONB, no schema migration needed)

**Global navigation commands (work from any state):**
- `MENU` / `OPTIONS` — show main menu with ✅ markers for explored paths
- `BACK` — return to previous step
- `START OVER` / `DEMO` / `RESTART` / `RESET` — full reset to opener
- `4` or any YES intent — jump directly to lead capture

**Lead storage:** `leads` table, `lead_type="demo"`, `client_id="highmark_demo"`, `source="sms"`

**Admin notification:** SMS to `DEMO_NOTIFY_PHONE` env var (falls back to `CONFIRMATIONS_TEST_PHONE`)

**Pricing tier config:** `tier` field on all clients — `"free" | "growth" | "pro" | "demo"`. Config only, no billing.

**Extending the demo for new features (campaigns, CRM, analytics, etc.):**
Add an entry to `PATHS` in `demoFlow.js` with `label`, `menuLine`, `intro`, and `followup`. The state machine handles routing, menu rendering, ✅ markers, and CTA logic automatically. No other changes needed.

**Testing:**
```bash
npm run chat  # switch phone to +18668906657 in chat.js, or
./virtual-test.sh 9  # triggers DEMO keyword
# UI: https://highmark-bot-production.up.railway.app/ui?key=highmark2026
#   → select "Highmark Demo" client → test all menu paths, MENU/BACK/START OVER
```

**Testing UI:** All clients appear in the UI selector at `/ui?key=UI_SECRET`. Demo client is marked `isDemo: true`.

**Session tip:** Start a new Claude session when moving from demo/sales work to website/landing page work.

### Session Tips
Start a new Claude session when switching from architecture/refactor work to behavior tuning or UI work — when switching from SMS flow work to admin/internal workflow work — and when moving from admin provisioning work to public website/sales funnel work. Keeps context focused and saves credits.

### TEST_MODE
When `TEST_MODE=true` (local only, never set on Railway):
- Twilio sends are skipped entirely
- `/sms` returns `{ reply: "..." }` JSON instead of TwiML
- `/reset` endpoint becomes available

### Scheduled Messages (scheduler.js)
30-min follow-up and all future delayed SMS use the `scheduled_messages` Supabase table.
- `scheduleMessage(supabase, { phone, body, message_type, send_at, ... })` — inserts a row
- `processScheduledMessages(supabase, twilioClient, crmSupabase)` — worker: claim → opt-out check → send → update status
- Retry backoff: 5 min after attempt 1, 15 min after attempt 2, then `failed`
- Opt-out check: cancels with reason before Twilio call (TCPA safe)
- Stale lock recovery: rows stuck in `processing` > 5 min are reclaimed on next worker run
- Railway cron: separate `highmark-cron` service running `node cron-worker.js` every 5 min
- Table: `scheduled_messages` in DB1 — see `db1_scheduled_messages.sql`

### Booking Confirmations (bookingConfirmations.js)
- Confirmation text includes FareHarbor booking link: `fareharbor.com/embeds/book/{shortname}/items/{item_pk}/booking/{uuid}/`
  - Uses `booking.uuid` + `booking.availability.item.pk` from FH webhook payload
  - Falls back gracefully (no link) if `uuid` is absent
- Cancellation texts are idempotent — `cancellation_sent` boolean in `confirmations_sent` prevents duplicate texts
- Poller catches missed cancellations: scans `confirmations_sent` for rows where FH status is now `cancelled` but `cancellation_sent=false`
- Rebooking flow: cancel text for old booking + confirmation text for new booking, resilient to downtime
- DB1 migration required: `db1_cancellation_sent.sql` (adds `cancellation_sent` column)

### Special Triggers
- `DEMO` — sends Highmark-branded opener + notifies owner (+17202892483)
- `SUMMITDEMO` — resets conversation + sends seasonal opener (internal demos)
- `STOP / UNSUBSCRIBE / QUIT / END / CANCEL` — TCPA opt-out (processed first)
- `START / UNSTOP` — opt-in
- `HELP` — returns program name, msg frequency notice, STOP instruction, support phone

### TCPA Compliance Order (in /sms)
1. STOP keywords → opt-out + confirmation text
2. START keywords → opt-in
3. HELP → compliance response (works even for opted-out numbers)
4. Opted-out gate → silently drop message
5. All other processing

### Message Length
Default 320 chars (2 texts) for all replies. `enforceLength(text, max=320)` — never truncates URLs.

### Knowledge Base Context (4 sections injected into every Claude call)
```
WEATHER (date): <Steamboat + Rabbit Ears Pass conditions, 3-day forecast>
AVAILABILITY: <open slot counts + next open date per tour>
TOUR DETAILS: <item names, descriptions, price ranges from FH items API>
BUSINESS INFO: <policies, seasonal, FAQ from website>
DYNAMIC BOOKING LINKS: <per-item FH URLs, auto-updated from cached PKs>
```

### Season Detection
- `getCurrentSeason()` → `winter` (Nov-Mar), `shoulder` (Apr-May), `summer` (Jun-Oct)
- `isWinter = season === "winter" || season === "shoulder"` → injects winter snowmobile knowledge
- `isSummer = season === "summer" || season === "shoulder"` → injects summer RZR knowledge
- In `shoulder`, BOTH knowledge blocks are included (season transition overlap)
- Summer RZR knowledge includes: 4 trail areas (Buffalo Pass, North Routt, Rabbit Ears Pass, Kremmling BLM), OHV rules, safety tips, fire restrictions, riding advice
- RZR does NOT use FareHarbor — books via Polaris Adventures platform

### Knowledge Base Refresh (zero Claude tokens for FH + weather)
| Data | Cron | Method |
|---|---|---|
| FH items (catalog, pricing) | Daily at 2am | JS from FH API — no Claude |
| FH availability (slots) | Every 3hr | JS from FH minimal endpoint — no Claude |
| Weather | Every 1hr | JS from OpenWeather (Steamboat + Rabbit Ears Pass + Storm Peak summit) — no Claude |
| Snow conditions | Every 3hr (offset :30) | SNOTEL 4 stations + CAIC avalanche danger — no Claude |
| Website (policies, FAQ) | Monday 3am | Single Haiku call, hash-gated — skips if content unchanged |

- `buildFhSummary()` formats availability string directly in JS
- `getPriceRange()` reads `customer_type_rates[].total_including_tax` from FH API
- `extractMeaningfulText()` pre-filters HTML to pricing/policy content before Claude
- `hashContent()` SHA-256s the pre-processed text — Claude skipped if hash matches last run

### FareHarbor API Notes
- Items endpoint: `/companies/{shortname}/items/` — returns catalog with pricing
- Availability: `/companies/{shortname}/items/{pk}/minimal/availabilities/date-range/{start}/{end}/`
  - Must use `minimal` endpoint (full date-range endpoint returns 403 for REA key)
  - Open slots: filter by `capacity > 0 || is_available === true`

### Booking URLs
- `csr_browse_all` — guest browses all CSR sled options (use for general requests)
- `rea_browse_all` — guest browses all REA tour options
- Individual item URLs built dynamically from FH item PKs cached in knowledge_base table

### DB2 CRM Security
- RLS enabled on all 4 tables: contacts, campaigns, campaign_sends, opt_outs
- Service role key bypasses RLS automatically — bot is unaffected

### Tier Model
- **Tier 1** ($200-300/mo): `FAREHARBOR_ENABLED=false` — bot Q&A + booking links
- **Tier 2** ($400-500/mo): `FAREHARBOR_ENABLED=true` — real-time availability + live KB

### Multi-Client Path (future)
Currently one Railway deployment = one client. When managing 4+ clients:
- `clients` table in Supabase keyed by `to_number`
- Load config at request time, no redeploy needed

---

## Known TODOs (Before Full Production)

1. ~~**Booking follow-up `setTimeout`**~~ — DONE. Durable `scheduled_messages` + `highmark-cron` Railway service (every 5 min).
2. ~~**Rebooking cancellations**~~ — DONE. Idempotent cancel texts, poller catches missed cancellations, `cancellation_sent` column tracks state.
3. ~~**Booking link in confirmation**~~ — DONE. Uses `booking.uuid` + `item.pk` from FH payload.
4. ~~**Lead capture flow (Lone Pine)**~~ — DONE. 3-step SMS flow + `leads` table + business notification. Run `db1_lead_capture.sql` migration in Supabase before deploy.
5. ~~**Admin lead management**~~ — DONE. List/filter/update/summary routes at `/admin/leads`. Run `db1_lead_mgmt.sql` migration to enable extended statuses + `updated_by`. Protected by `UI_SECRET`.
6. ~~**Client onboarding + provisioning**~~ — DONE. DB-backed client registry. POST/PATCH/GET `/admin/clients`. Validation, defaults, readiness checks. Run `db1_clients.sql` migration in Supabase DB1 before deploy.
7. ~~**Sales + Demo engine**~~ — DONE. `highmark_demo` client owns +18668906657. Guided 3-path SMS demo (Q&A / Lead Capture / Booking), lead capture, admin notification. `bookingMode: "demo"` in clients.js; demoFlow.js handles deterministic state machine.
8. **CRM campaign sending** — `/crm/campaigns/:id/send` logs sends but doesn't actually call Twilio yet
9. **Confirmations live test** — Twilio toll-free verification in progress (submitted 2026-03-24). Once approved, flip `CONFIRMATIONS_ENABLED=true` and verify texts arrive.
10. **Website** — usehighmark.com landing page not yet built. Next step: serve static HTML from Railway at `/home` or dedicated service.
