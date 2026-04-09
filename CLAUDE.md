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
knowledgeBase.js       — FH items (24hr cron) + FH availability (3hr cron) + weather (1hr cron) + website (7-day cron, hash-gated) + crawler cron wiring
crawler.js             — Phase 2 whole-site crawler: crawlSite, classifyPageType, extractPageFacts (Haiku, hash-gated), buildCrawlerContext, runCrawlerForClient
clientConfig.js        — getRuntimeClientConfig(): merges DB settings into static client on every SMS request
phoneUtils.js          — phone normalization: normalizePhone, isValidPhone, formatPhoneForDisplay
livetruth.js           — live availability truth: isAvailabilitySensitive, resolveLiveTruth, buildTruthInstruction
conversationEngine.js  — config-driven conversation: getConversationConfig, buildMainMenu, routeMenuSelection
bookingConfirmations.js — FareHarbor webhook receiver + 30min polling + confirmation texts
crm.js                 — contacts, campaigns, opt-out/opt-in (TCPA), auto-tagging; opt_outs writes to DB1, contacts mirror to DB2
chat.js                — interactive terminal chat simulator (no Twilio cost)
scheduler.js           — durable scheduled SMS: scheduleMessage() + processScheduledMessages()
cron-worker.js         — standalone Railway cron service entry point (node cron-worker.js, */5 * * * *)
test.js                — automated test suite (788 tests), spawns its own server on port 3099
demoFlow.js            — guided demo state machine for bookingMode=demo clients
demoAnalytics.js       — demo funnel event tracking: trackDemoEvent() + admin summary/events endpoints
followUpEngine.js      — lead follow-up sequencing: scheduleFollowUps() + checkAndMarkLeadEngaged()
campaigns.js           — campaign engine: createCampaign, selectAudience, enqueueCampaign, getCampaignStats
adminCampaigns.js      — campaign admin routes: POST/GET/PATCH campaigns + POST :id/send
portalAuth.js          — portal JWT middleware factory: makePortalAuth(supabase) + resolvePortalClientId(req)
adminPortal.js         — portal API handlers: dashboard, leads, campaigns, analytics, settings + admin user mgmt
adminInvites.js        — invite lifecycle handlers: create, info, accept, revoke, resend, deactivate
leads.js               — lead capture module: saveLead() + notifyBusinessOfLead() for informational clients
adminLeads.js          — admin lead management: list, get, update, summary routes
adminScheduledMessages.js — scheduled message queue visibility: GET /admin/scheduled-messages
adminClients.js        — client provisioning: create/update/list/readiness routes
virtual-test.sh        — Twilio Virtual Phone test runner (10 scenarios)
public/portal-login.html — client portal login page
public/portal.html     — client portal SPA: Dashboard, Leads, Campaigns, Analytics, Settings, Users & Access
public/portal-accept.html — invite acceptance page
db1_schema.sql         — DB1 migration (Supabase Project 1 SQL editor)
db2_crm_schema.sql     — DB2 CRM schema (Supabase Project 2 SQL editor)
railway.json           — Railway deployment config
PROMPTS.md             — Session starter prompts
.env                   — local secrets (never commit)
```

**SQL migrations** (run once in Supabase DB1 SQL editor):
`db1_clients.sql`, `db1_client_pages.sql`, `db1_crawl_settings.sql`, `db1_lead_capture.sql`, `db1_lead_mgmt.sql`, `db1_lead_name.sql`, `db1_lead_followup.sql`, `db1_campaigns.sql`, `db1_portal.sql`, `db1_portal_invites.sql`, `db1_demo_analytics.sql`, `db1_cancellation_sent.sql`, `db1_opt_outs.sql`, `db1_waitlist.sql`

---

## Multi-Client Architecture

Client config lives in `clients.js` — edit that file to add or update clients.
Each client entry defines: `id`, `botName`, `tone`, `inboundPhones`, `supportPhone`, `handoffPhone`,
`bookingMode`, `fareharborCompanies`, `scrapeUrls`, `snotelStations`, `bookingUrls`, `services`, `faq`, `hours`, `crmEnabled`, `openerText`, `handoffReply`.

**To onboard a new client:**
1. Add an entry to `CLIENTS` in `clients.js`
2. Set `<CLIENT>_TWILIO_NUMBER` env var in Railway
3. No other code changes required — `resolveClient(toNumber)` routes automatically

**bookingMode values:** `fareharbor` | `informational` | `lead_capture` | `call_only` | `static_links` | `hybrid` | `api_live_booking` (alias for fareharbor) | `demo`

**Current clients:**
| Client | ID | Mode | Twilio Number |
|---|---|---|---|
| Colorado Sled Rentals + Rabbit Ears Adventures | `csr_rea` | `fareharbor` | +18335786496 (pending) · demo: +18668906657 |
| Lone Pine Performance | `lone_pine` | `informational` | +18336489744 (pending) |
| Highmark Demo | `highmark_demo` | `demo` | +18668906657 (active) |

**Railway env vars still needed per deployment:**
- `FAREHARBOR_ENABLED` — `true` for Tier 2 FH access
- `CONFIRMATIONS_ENABLED` — `true` when ready to text real guests
- `CONFIRMATIONS_TEST_PHONE` — redirect all confirmation texts here while testing

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
Spawns its own server on port 3099. Runs all 788 scenarios automatically.

### Server + curl tests (TEST_MODE)
```bash
# Terminal 1:
npm run dev:test
# Terminal 2:
curl http://localhost:3000/
curl -s -X POST http://localhost:3000/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=Hey&From=%2B15550001234&To=%2B15559999999"
```

### Twilio Virtual Phone testing
```bash
./virtual-test.sh          # show scenario menu
./virtual-test.sh 1        # new guest greeting
./virtual-test.sh 9        # DEMO trigger
```
Virtual Phone (acts as customer): `+18777804236`
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
5. `checkAndMarkLeadEngaged()` — marks lead engaged if they replied
6. `getRuntimeClientConfig()` — merge DB settings into client object
7. Demo routing (`bookingMode=demo` → `handleDemoFlow()`, bypasses all production logic)
8. Intent + sentiment classification
9. Booking mode routing (per client.bookingMode)
10. Claude called with system prompt + KB context
11. Save conversation to Supabase, return TwiML
12. CRM upsert/tagging — only if `client.crmEnabled` is true

### Conversation Stage Machine
`new → discovery → engaged → considering → high_intent → lead_captured → closed | handoff`
Stored in `booking_data._stage` (no schema migration needed). Never downgrades. Frustrated → handoff.
Commercial Decision Layer (`buildResponsePlan`) runs before every Claude call: enforces answer-first, expertise-first behavior. `containsPhoneAsk()` post-validates and regenerates if needed.

### Rate Limiting
- **IP limiter** — 30 req/min per IP (express-rate-limit)
- **Phone limiter** — 10 msg/min per phone number (in-memory Map)
Both return `<Response></Response>` TwiML on 429.

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
- `1` — tour menu shown, waiting for guest to pick
- `2` — booking link sent
- `3` — confirmation text sent
- `4` — 30-min follow-up sent

### Booking Rules
- Same-day bookings NOT allowed — minimum 1 day advance booking required
- Availability window always starts from tomorrow
- Groups 6+ always handoff
- `informational` clients: booking intent → 3-step lead capture (if `leadCaptureEnabled`) or phone CTA

### Lead Capture Flow (leads.js + informational mode)
Step 1: what service needed → Step 2: callback number → Step 3: preferred timeframe → `saveLead()` + `notifyBusinessOfLead()`. Abort on "call/phone/never mind/cancel/skip" → handoffReply.

### Demo Mode (demoFlow.js)
`highmark_demo` client owns +18668906657. Fully deterministic, no AI calls. 3 paths (Q&A / Lead Capture / Booking) + lead capture funnel. State in `booking_data._demo`. Global commands: MENU, BACK, START OVER, YES/4 → lead capture. Analytics tracked in `demo_events` via `demoAnalytics.js`.

### Lead Follow-up Engine (followUpEngine.js)
`scheduleFollowUps(supabase, lead, fromPhone)` queues SMS sequences into `scheduled_messages`. Cron worker cancels if lead becomes engaged/converted. Lead statuses: `new → contacted → engaged → converted/closed/ignored`. Edit `SEQUENCES` in followUpEngine.js to add/modify sequences.

### Campaign Engine (campaigns.js + adminCampaigns.js)
Outbound SMS to filtered audience (`all_leads`, `engaged_leads`, `new_leads`). Templates support `{{name}}` / `{{first_name}}`. Status: `draft → sending/scheduled`. Routes: `POST/GET/PATCH /admin/campaigns`, `POST /admin/campaigns/:id/send`.

### Client Portal (portalAuth.js + adminPortal.js)
`/portal` — Supabase Auth + `portal_users` table. Roles: `internal_admin`, `client_admin`, `client_user`. JWT validated on every `/portal/api/*` request. 3-layer client scoping. Sections: Dashboard, Leads, Campaigns, Analytics, Settings, Users & Access.
- `client_user` → read-only (403 on mutating operations)
- `client_admin` → manage own client + invite users (cannot escalate to internal_admin)
- `internal_admin` → access any client via `?client_id=`
- Settings PATCH: identity, contact info, booking mode, feature toggles (DB-backed clients only)

### Invite-Based Portal Access (adminInvites.js)
64-char token, 72h expiry, single-use. `portal-accept.html` → client sets password → auto sign-in. Admin routes: `POST/GET /admin/portal-invites`, `:id/resend`, `:id/revoke`. Portal routes: `GET/POST /portal/api/invites`, `GET/POST /portal/api/users`.

### Runtime Config Loader (clientConfig.js)
`getRuntimeClientConfig(client, supabase)` — called per request, applies DB overrides to static client objects. Normalizes `api_live_booking → fareharbor`. Builds `scrapeSources` from `client_scrape_sources` table and `bookingLinks` from `client_booking_options` table (both optional; fall back to static config). `humanHandoffEnabled: false` suppresses handoff routing.

### Scheduled Messages (scheduler.js)
`scheduleMessage()` inserts row; `processScheduledMessages()` worker: claim → opt-out check → send → update status. Retry: 5 min, 15 min, then `failed`. Stale lock recovery after 5 min. Railway cron service (`highmark-cron`) runs every 5 min.

### Booking Confirmations (bookingConfirmations.js)
FH webhook + 30-min poller. Confirmation link: `fareharbor.com/embeds/book/{shortname}/items/{pk}/booking/{uuid}/`. Cancellations idempotent via `cancellation_sent` column. Rebooking: cancel old + confirm new.

### Whole-Site Crawler (crawler.js)
BFS crawl from `crawlSettings.primaryUrl`, same-domain only, skips junk paths. Per-page: classify (10 types) → Haiku fact extraction (hash-gated). Output: `buildCrawlerContext()` assembles ≤1500 char `WEBSITE KNOWLEDGE:` block from `client_pages` table. Cron: Monday 4am.
Enable: `crawlSettings: { enabled: true, primaryUrl: "https://..." }` in `clients.js` or via `crawl_settings` JSONB on DB-backed clients.

### Knowledge Base Refresh
| Data | Cron | Method |
|---|---|---|
| FH items (catalog, pricing) | Daily 2am | JS from FH API |
| FH availability | Every 3hr | JS from FH minimal endpoint |
| Weather | Every 1hr | OpenWeather (Steamboat + Rabbit Ears Pass + Storm Peak) |
| Snow conditions | Every 3hr (:30) | SNOTEL 4 stations + CAIC avalanche danger |
| Website | Monday 3am | Single Haiku call, hash-gated |
| Whole-site crawl | Monday 4am | crawler.js BFS + per-page Haiku |

### Season Detection
- `getCurrentSeason()` → `winter` (Nov-Mar), `shoulder` (Apr-May), `summer` (Jun-Oct)
- Shoulder: BOTH snowmobile + RZR knowledge injected
- RZR does NOT use FareHarbor — books via Polaris Adventures platform

### Special Triggers
- `DEMO` — sends Highmark-branded opener + notifies owner (+17202892483)
- `SUMMITDEMO` — resets conversation + sends seasonal opener (internal demos)
- `STOP / UNSUBSCRIBE / QUIT / END / CANCEL` — TCPA opt-out (processed first)
- `START / UNSTOP` — opt-in
- `HELP` — program name, msg frequency notice, STOP instruction, support phone

### TCPA Compliance Order (in /sms)
1. STOP keywords → opt-out + confirmation text
2. START keywords → opt-in
3. HELP → compliance response (works even for opted-out numbers)
4. Opted-out gate → silently drop message
5. All other processing

### Message Length
Default 320 chars (2 texts). `enforceLength(text, max=320)` — never truncates URLs.

### DB1 vs DB2 — What Lives Where
- **DB1 (primary)**: conversations, leads, scheduled_messages, confirmations_sent, campaigns, campaign_recipients, portal_users, portal_invites, clients, demo_events, knowledge_base, client_pages, opt_outs (all clients)
- **DB2 (CSR/REA CRM)**: contacts, campaign_sends, opt_outs (mirror only — DB1 is authoritative)

**Test data cleanup:**
```sql
DELETE FROM conversations WHERE session_type = 'test';
DELETE FROM leads WHERE source = 'ui';
DELETE FROM opt_outs;  -- clear test opt-outs (DB1 only)
```

### Tier Model
- **Tier 1** ($200-300/mo): `FAREHARBOR_ENABLED=false` — bot Q&A + booking links
- **Tier 2** ($400-500/mo): `FAREHARBOR_ENABLED=true` — real-time availability + live KB

### FareHarbor API Notes
- Items: `/companies/{shortname}/items/`
- Availability: `/companies/{shortname}/items/{pk}/minimal/availabilities/date-range/{start}/{end}/`
  - Must use `minimal` endpoint (full date-range returns 403 for REA key)
  - Open slots: filter by `capacity > 0 || is_available === true`

### TEST_MODE
When `TEST_MODE=true` (local only, never set on Railway):
- Twilio sends skipped; `/sms` returns `{ reply: "..." }` JSON
- `/reset` endpoint available

---

## Open TODOs

20. **Confirmations live test** — Twilio toll-free verification submitted 2026-03-24. Once approved, flip `CONFIRMATIONS_ENABLED=true` and verify texts arrive.
21. **Website** — usehighmark.com landing page at `/home`. Next: billing, plan enforcement, or advanced analytics.
