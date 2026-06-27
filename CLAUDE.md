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
4. **Deploy** — commit and push to GitHub; Railway auto-deploys from `main`. CI
   (`.github/workflows/test.yml`) runs the full suite on every push/PR — keep it green.
5. **End-to-end verify** — run the Railway health check and confirm the deploy is live
6. **Update docs** — update CLAUDE.md, README.md, Roadmap, and memory files to reflect the change

### CI (GitHub Actions — added 2026-06-10)
`.github/workflows/test.yml` runs `npm test` (full 2,615-case suite) on every push + PR.
It's a real integration run (spawns the server in TEST_MODE, hits live Supabase DB1/DB2 +
Anthropic), serialized via a concurrency group since tests share live rows + fixed test
phone numbers. Required repo secrets + non-secret env (FAREHARBOR_ENABLED=true,
CONFIRMATIONS_ENABLED=false, CLIENT_ID/NAME/PHONE, PERF_BUDGET_MULTIPLIER=3, TZ=America/Denver)
are in the workflow header. Set secrets with `gh secret set NAME` reading **stdin** — NOT
`--body -` (that stores the literal string "-"). Local gh uses
`GH_CONFIG_DIR=/Users/sbartosewcz/.gh-config` (~/.config is root-owned).
**TODO:** enable Railway "Wait for CI" to block deploys on red (pending a GitHub API incident
when first attempted; revisit). Until then CI is advisory.

---

## File Structure
```
Roadmap                — project phases, priorities, next 5 builds — READ THIS BEFORE STARTING ANY TASK
clients.js             — per-client configuration registry + resolveClient(toNumber) — ADD NEW CLIENTS HERE
index.js               — main Express server, all bot logic, booking state machine; /sms route delegates to smsOrchestrator.js
smsOrchestrator.js     — /sms webhook body: keyword routing, opt-out gate, demo flow, booking state machine, lead capture, Claude default branch
voice.js               — Voice AI (Phase 1): Twilio Voice webhooks (/voice/incoming|status|recording), per-client agent config, TwiML builders, call logging to voice_calls, portal call-log endpoint
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
selfSignup.js          — Sprint 7: public self-serve signup + onboarding status/approve handlers
smsOptIn.js            — Progressive SMS opt-in (Prompt 7B): isSmsIntent, detectConsentReply, copy builders
onboardingConfig.js    — auto-config pipeline: startAutoConfig, commitDraftToDb, getDraft, slugifyName, buildNextSteps
virtual-test.sh        — Twilio Virtual Phone test runner (10 scenarios)
verticals.js           — Sprint 6: vertical landing pages (/tour-operators, /snowmobile-rentals, /service-businesses) — VERTICALS config + renderVerticalPage(slug)
public/portal-login.html — client portal login page
public/portal.html     — client portal SPA: Dashboard, Leads, Campaigns, Partners, Analytics, Settings, Users & Access
public/portal-accept.html — invite acceptance page
public/signup.html     — Sprint 7: public self-serve signup form (businessName, websiteUrl, email, password)
public/portal-onboarding.html — Sprint 7: polling page for crawl status + draft preview + approve
partnerActivities.js   — Sprint 5: partner distribution — scoring, season filter, /track/partner resolver (Source 5 in bookingLinks)
ownerMode.js           — owner detection (detectOwner) + Phase X system prompt (buildOwnerInstruction) + pending-action confirmation gate
operatorIntentParser.js — deterministic operator NLP: detectOperatorIntent, parseDateRange, parseSeasonRange, extractCompanyFilter, isVagueFollowUp, mergeOperatorContext, extractOperatorContext
operatorBriefing.js    — operator command shortcut (detectAndHandleOperatorCommand), morning briefing builder, operational issue detection, per-employee location scoping + FLEET work-order section
mpwrWorkOrders.js      — MPWR fleet work-order sync (open WOs per outfitter → DB2 work_orders); reuses mpwrSync token + turbo-stream decoder
priorityEngine.js      — Operator Intelligence 2.0: deterministic issue scoring (scorePriorities/buildTodaysPriorities); ranks "what needs attention" per role
operatorRoles.js       — Operator Intelligence 2.0: role model (8 canonical + legacy normalize), detail tiers, ROLE_PROFILES (focus/cardOrder/priority weights)
mpwrSync.js            — MPWR (Polaris) booking sync → DB2; exports getToken + decodeMpwrStream (shared by mpwrWorkOrders.js)
actionEngine.js        — owner BI action handlers: get_bookings_by_date_range, report, daily_summary, get_lead_summary, send_campaign + buildOperatorInsight + Phase-X format helpers
agentOrchestrator.js   — multi-agent orchestrator (runOrchestrator); routes owner mode through detectAndHandleOperatorCommand before Claude
db1_schema.sql         — DB1 migration (Supabase Project 1 SQL editor)
db2_crm_schema.sql     — DB2 CRM schema (Supabase Project 2 SQL editor)
railway.json           — Railway deployment config
PROMPTS.md             — Session starter prompts
.env                   — local secrets (never commit)
```

**SQL migrations** (run once in Supabase DB1 SQL editor):
`db1_clients.sql`, `db1_client_pages.sql`, `db1_crawl_settings.sql`, `db1_lead_capture.sql`, `db1_lead_mgmt.sql`, `db1_lead_name.sql`, `db1_lead_followup.sql`, `db1_campaigns.sql`, `db1_portal.sql`, `db1_portal_invites.sql`, `db1_demo_analytics.sql`, `db1_cancellation_sent.sql`, `db1_opt_outs.sql`, `db1_waitlist.sql`, `db1_partner_activities.sql`, `db1_onboarding_status.sql`, `db1_sms_consent.sql`, `db1_operator_phones.sql`, `db1_operator_phones_rls.sql`, `db1_conversation_type.sql`, `db1_processed_messages.sql` (P0-4 inbound idempotency; applied to DB1 + RLS enabled), `db1_conversation_lock.sql` (P1-1 optimistic concurrency: `conversations.lock_version` — applied to DB1), `db1_voice.sql` (Voice AI: voice_numbers, voice_agents [+ai_enabled, voice], voice_calls — applied), `db1_voice_spam.sql` (Phase 4 shared spam network: spam_numbers — applied), `db1_operator_locations.sql` (per-employee briefing scoping: `operator_phones.locations TEXT[]` — applied to DB1), `db2_work_orders.sql` (+ RLS; MPWR fleet work orders — applied to DB2), `db1_operator_intelligence_2.sql` (OI 2.0: widen `operator_phones.role` to 8 canonical roles + `briefing_detail` to 4 tiers + add `display_name` — applied to DB1), `db1_dashboard_layout.sql` (OI 2.0 Phase 2: `portal_users.dashboard_layout` JSONB for Mission Control — applied to DB1)

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
0. Twilio signature validation (P0-1) → 403 on forgery
1. Rate limiting (IP + phone)
1.5. **ACK-first + idempotency (P0-4, real SMS only):** respond `<Response></Response>`
   to Twilio immediately, then `claimInboundMessage(MessageSid)` — a duplicate (Twilio
   retry) is dropped. The reply is delivered out-of-band via `messages.create`, so the
   webhook never blocks on Claude (no 15s-timeout retry storms). TEST_MODE/UI keep the
   synchronous JSON response. `ack()` helper sends the empty TwiML exactly once.
2. STOP/HELP/START keywords (TCPA — processed before anything else)
3. Opted-out gate (silently drop)
4. Load conversation from Supabase
5. `checkAndMarkLeadEngaged()` — marks lead engaged if they replied
6. `getRuntimeClientConfig()` — merge DB settings into client object
7. Demo routing (`bookingMode=demo` → `handleDemoFlow()`, bypasses all production logic)
8. Intent + sentiment classification
9. Booking mode routing (per client.bookingMode)
10. Claude called with system prompt + KB context
11. Save conversation to Supabase
12. CRM upsert/tagging — only if `client.crmEnabled` is true
(`processed_messages` table = idempotency keys; cron worker prunes rows >3 days old.)

### Conversation Stage Machine
`new → discovery → engaged → considering → high_intent → lead_captured → closed | handoff`
Stored in `booking_data._stage` (no schema migration needed). Never downgrades. Frustrated → handoff.
Commercial Decision Layer (`buildResponsePlan`) runs before every Claude call: enforces answer-first, expertise-first behavior. `containsPhoneAsk()` post-validates and regenerates if needed.

### Webhook Security (P0-1)
`/sms` is guarded by `validateTwilioSignature` (twilioSignature.js) BEFORE the rate
limiters — forged requests get `403 <Response></Response>` and never reach the handler
or burn Claude/Twilio spend. Verifies the `X-Twilio-Signature` HMAC against the
reconstructed request URL + POST params using `TWILIO_AUTH_TOKEN`.
- **Bypasses** (no signature expected): `TEST_MODE=true`, and authenticated UI/console
  requests (`isUiReq`, x-internal-key).
- **Env knobs:** `TWILIO_VALIDATE=false` = ops kill-switch to disable validation without
  a deploy; `PUBLIC_BASE_URL` = override the signed-URL base if proxy host reconstruction
  is wrong (set to `https://highmark-bot-production.up.railway.app` if needed).
- Validation is ACTIVE in prod whenever `TWILIO_AUTH_TOKEN` is set. If legit inbound SMS
  starts returning 403, set `TWILIO_VALIDATE=false` to restore service immediately, then
  fix `PUBLIC_BASE_URL`.
- `evaluateTwilioRequest` (pure) is unit-tested.

**FareHarbor webhook auth (P0-2)** — `/fareharbor/webhook` (+ `/fareharbor/webhook/:token`)
gated by a shared secret in `FAREHARBOR_WEBHOOK_SECRET`. Secret accepted via path
segment (most robust), `?token=`, or `x-webhook-secret` header; forged requests → 403.
- **Opt-in / non-breaking:** if the env var is UNSET, the webhook stays open (current
  behavior) and logs an "UNAUTHENTICATED" warning. To enable: set the env var AND append
  the secret to the FareHarbor dashboard callback URL (e.g. `.../fareharbor/webhook/<secret>`).
- `secretsMatch` (constant-time) + `evaluateFareharborWebhook` (pure) are unit-tested.

### Rate Limiting
- **IP limiter** — 30 req/min per IP (express-rate-limit, in-memory; coarse bot filter,
  acceptable per-instance)
- **Phone limiter** — 10 msg/min per phone number, backed by the **shared store** (P0-5):
  Upstash Redis when configured, in-memory otherwise. Holds correctly across multiple web
  instances; fail-open on store error.
Both return `<Response></Response>` TwiML on 429.

### Shared Store (sharedStore.js — P0-5)
KV abstraction so rate-limit counters + the daily-summary cache work across web instances.
Backends: **Upstash Redis (REST)** when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
are set; **in-memory** (TTL Map) otherwise — identical to prior behavior, so deploying before
provisioning Upstash is zero-risk. `@upstash/redis` is lazy-imported only when configured.
API: `incrWithTtl(key, ttlSec)` (atomic fixed-window counter), `cacheGet/cacheSet(key,val,ttlSec)`,
`storeMode()` (surfaced in `GET /` health as `store`). Set the two env vars on BOTH the web
and cron services for full cross-process sharing. AI-insights cache is already DB-backed (shared).

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
  client_id:              "csr_rea",
  lock_version:           0   // P1-1 optimistic-concurrency counter (see below)
}
```

**P1-1 — optimistic concurrency (saveConversation, index.js).** `getConversation`
(select *) → mutate → `saveConversation` is a read-modify-write; two concurrent inbound
messages from the same phone (or a Twilio retry that slips past the MessageSid claim) both
load the same base row and a full-row upsert would last-write-wins, clobbering a turn.
`saveConversation` now does a **compare-and-swap on `lock_version`**: `UPDATE … WHERE
from_number AND to_number AND lock_version = <read value>` SET … `lock_version+1`. On a lost
race (0 rows updated) it reloads the winner's row, **merges this turn's new messages** onto
the winner's latest history (`diffNewMessages` by object identity — survives the `slice(-10)`
truncation; `mergeConversationMessages` bounded to 20), and retries (up to 6×, one per
serial writer ahead of it). `getConversation` stamps transient `_lockVersion` +
`_loadedMessages` (a snapshot copy, NOT the live array) on the convo; neither is persisted.
**Degrades gracefully:** if the `lock_version` column is absent (`isMissingColumnError`) or on
any unexpected error / retry exhaustion, it falls back to the prior last-write-wins upsert —
so deploying before running `db1_conversation_lock.sql` is zero-risk. Pure helpers
(`buildConversationRow`, `diffNewMessages`, `mergeConversationMessages`, `isMissingColumnError`)
are unit-tested. Migration `db1_conversation_lock.sql` (additive `ADD COLUMN IF NOT EXISTS`)
applied to DB1.

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

### Reporting — revenue by all 4 locations + cleaner visuals (2026-06-26)
Operations revenue was grouped by the **coarse** `daily_manifest.location` (only Steamboat/Kremmling — North Routt + Rabbit Ears were lumped into Steamboat). `resolveBookingLocation(bookings.location, activity, manifest.location)` (adminOperations.js) now resolves the finest location per row: MPWR `bookings.location` wins → else `deriveLocationFromTitle(activity)` (mpwrSync) → else the coarse manifest location. Applied at the shared fetches (`fetchBookingsForRevenue`, `fetchBookingsInWindow` both dims), so **revenue-by-location, tomorrow-prep, and the bookings list all split across Kremmling / Steamboat / North Routt / Rabbit Ears**; labels capitalized via `capLoc`. The portal Operations revenue render (`renderRevenue`) was cleaned up: **Revenue by location is the hero** (full-width bars + $ + bookings + % of total), Revenue by guide is **hidden when everyone's Unassigned** (was redundant), and the 30-day daily breakdown is collapsed into a `<details>`. The Mission Control **revenue widget** gained a "Next 7d by location" mini-breakdown (`revenue.by_location`). The **SMS briefing** matches: `enrichManifestRows` (operatorBriefing.js) now resolves the finest location for every manifest row (`bookings.location → deriveLocationFromTitle(activity) → coarse`), so the today/upcoming location lines split all 4 posts, and the 💰 revenue card adds a `By location (7d): Kremmling $… · Rabbit Ears $… · …` line (when >1 location has revenue).

**Revenue window + 4-location split fix (2026-06-26, follow-up).** Two related changes:
(1) **The location split was still Steamboat-only past 7 days** — `getUpcomingManifest()` (operatorBriefing.js) returned the coarse `daily_manifest.location` because it never called `enrichManifestRows`. It now routes the deduped rows through `enrichManifestRows(deduped, crmSupabase)`, so the finest location resolves in **both** the Mission Control revenue widget and the SMS briefing revenue card (verified live: next-30d csr_rea now splits Rabbit Ears \$2,112 + North Routt \$1,302 out of Steamboat). (2) **Revenue widget date-range window** — `handlePortalDashboardWidgets` (adminPortal.js) accepts `?rev_days=7|14|30|90` (default 7) and fetches a separate revenue-window manifest (`getUpcomingManifest`/`getUpcomingRevenue` at the wider window) for `revenue.upcoming`, `revenue.upcoming_bookings`, and `revenue.by_location`; the fixed-7-day "Upcoming Week" card is unchanged. The portal revenue widget renders a touch-friendly `7d/14d/30d/90d` segmented control (`mcSetRevDays`, persisted in `_mcState.revDays`) with per-location bars + booking counts + an empty state.

### Mobile-first UX pass — Leads + Operations cards, role-aware briefing menu (2026-06-26)
A focused mobile-first pass (PR #16) across the three daily-driver surfaces; verified via a Playwright render harness (375/390/1100px) + unit tests, suite 2797/2797.
- **Leads list → cards (public/portal.html `loadLeads`).** The 7-column table horizontal-scrolled on mobile; replaced with a tappable **card list** (`.lead-card`, works at 320px): whole card opens the detail panel (action controls `stopPropagation`), inline **Call/Text** (`tel:`/`sms:`) that are full-width thumb targets on mobile / a compact cluster on desktop (`Open →` pushed right), a status pill that **recolors in place** on inline change (`inlineStatusChange` swaps `pill-*`), a left rail flagging **new** (blue) / **contacted** (amber), and a "N new leads need a first touch" summary line. List capped at 860px on desktop for readability.
- **Operations bookings table → mobile cards (public/portal.html `renderOpsBookingCard` + `#opsCardList`).** The 8-col table hid Location + Status on mobile and had 11px tap targets. A card list shows ≤720px (desktop keeps the full **sortable table** — both populated from the same sorted rows in `renderOpsTableRows`): time + status pill, customer + pax, **activity · location** (no longer hidden), color-coded risk pills (Waiver / $due / No guide / VIP / Repeat), 44px Text/Call/Open. Reuses `openOpsBooking` + `statusPill`. The old mobile column-hiding CSS was removed in favor of the card swap.
- **Briefing → role-aware reply menu (operatorBriefing.js `buildReplyMenu`).** The SMS footer always listed all 8 commands; now it shows only those relevant to the recipient's role (owner/GM = all 8 unchanged, mechanic = 3, guide = 4), packed ≤4/line. **Canonical numbers never change** (every inline "Reply N" + `OPERATOR_MENU` depend on them); `1 Schedule` + `8 Ask AI` are universal. `ROLE_REPLY_MENU` maps role→numbers; pure + exported; +5 tests in `testOperatorIntelligence2`.

### Test-data hide + UX pass 3 — Leads panel, Ops filter, Analytics funnel (2026-06-27)
PR #18. Suite 2797/2797; UI verified via Playwright render harness.
- **Hide synthetic test data from the production portal (server).** Conversations from the fictional 555/999 test numbers (e.g. `+15550009999`) have a live `session_type`, so they showed in the Conversations list AND inflated the dashboard ROI/time-saved counts. Mirrored the leads test-phone exclusion (`from_number NOT ilike +1555%/+1999%`) on: `handleListConversations` + `handleConversationBadgeCount` (adminConversations.js), the dashboard all-time/period/activity convo queries (adminPortal.js `exTestConv` helper), and `handlePortalUsage` conversations_this_month. All gated on `TEST_MODE !== 'true'` (the suite uses +1555 numbers on the live DB). `session_type='test'` exclusion was already in place; this adds the test-*phone* exclusion.
- **Leads detail panel → action-first (public/portal.html).** Reordered the slide-in: big **Call/Text** at top, the request (`.lp-want`) prominent, ✨ AI follow-up, Status, then the six reference fields collapsed into one compact `.lp-kv` key:value list (was seven tall `.lp-grid` cards). Same element IDs → `openLeadPanel` unchanged.
- **Operations filter bar (public/portal.html).** Split the crammed Dim+Season horizontal-scroll row into two labeled rows so all four seasons fit. (Bar already collapses to an informative summary on mobile via `_opsFilterOpen = innerWidth > 720`.)
- **Analytics lead funnel (public/portal.html `renderLeadFunnelChart`).** Replaced four flat funnel stat-cards with a proportional bar chart (New→Contacted→Engaged→Converted) + stage-to-stage conversion %, so drop-off is visible at a glance. Uses existing funnel data (no API change).

### Mobile-first UX pass 2 — nav fix, Conversations thread, Mission Control widgets (2026-06-27)
PR #17, all `public/portal.html`; verified via Playwright render harness (390/1200px); suite 2797/2797.
- **Mobile nav badge fix (user-reported).** `fetchConvBadge` appended a `margin-left:auto` unread badge to **every** `[data-section="conversations"]` element — including the centered mobile bottom-nav item, knocking its icon off-center + showing a count the bottom nav doesn't need. Scoped the badge selector to `.nav-item[data-section="conversations"]` (sidebar only).
- **Conversations thread (`renderMsgBubble` + `openConversation`).** Consecutive messages from the same sender are **grouped** — the Guest/Bot/Agent label shows only when the sender changes (was on every bubble); continuation rows get `.msg-cont` (tuck up `-6px`). Mobile bubbles widened 72%→85% + roomier `#convMessages` padding. Added a "Pick a conversation" empty state (`#convEmptyState`) in the desktop thread pane.
- **Mission Control widgets (`mcWidgetBody` + `mcGotoCategory`).** Action Items are **tappable** — each priority routes by `category` to where you act on it (`handoff`→conversations, `leads`→leads, `fleet`/`safety`/`maintenance`→operator, else→operations) with a severity color rail (critical red / high amber) + a `›`. Leads widget leads with a hero "N new" number; hot leads tap → Leads. Shared widget CSS (`.mc-num`/`.mc-tap`/`.mc-chev`). The priorities endpoint already returns `category` (adminPortal.js line ~470).

### Leads — operator exclusion + AI follow-up (2026-06-26)
**Operators + test numbers are never leads.** `getOperatorPhoneSet(clientId, supabase)` (operatorBriefing.js) returns the client's registered operator phones; `isTestPhone(phone)` (phoneUtils.js) flags synthetic 555/999 numbers (test suite/portal, e.g. +15550009999). Lead reporting excludes both everywhere — `getHotLeads`/`getRecentLeads` (briefing + Mission Control leads widget), `handlePortalLeads` (portal list, via `.not("contact_phone","in",…)` + `.not(…ilike "+1555%"/"+1999%")`), and both funnels (dashboard ROI + widgets). **Test-phone exclusion is gated on `process.env.TEST_MODE !== "true"`** so the integration suite (which uses +1555 leads on the live DB) still works; operator exclusion is unconditional. `saveLead` (leads.js) refuses to create a lead for a registered operator phone (defense-in-depth; catches voice missed-call recovery etc.). One-time DB cleanups tagged existing operator-phone leads `lead_type='operator', status='ignored'` and test-phone leads `lead_type='test', status='ignored'`.
**AI follow-up.** `POST /portal/api/leads/:id/suggest` (`handleSuggestLeadFollowup`, Claude Haiku) returns `{ next_step, message }` from the lead + its recent conversation — a one-line next action + a ready-to-send SMS draft; degrades to a deterministic suggestion when Claude is off. The portal **Leads** UI: list columns are Name · **Wants** · **Came in via** (plain-English source badge — 📱 Text / 🌐 Website chat / 📞 Phone call / 🎬 Demo / 🤝 Partner / ✍️ Added by hand) · Phone · Status; the lead panel adds one-tap **📞 Call** (`tel:`) + **💬 Text** (`sms:`) and a **✨ Suggested follow-up** card with Copy + **Text it** (`sms:` prefilled with the draft).

### Lead Capture Flow (leads.js + informational mode)
Step 1: what service needed → Step 2: callback number → Step 3: preferred timeframe → `saveLead()` + `notifyBusinessOfLead()`. Abort on "call/phone/never mind/cancel/skip" → handoffReply.

### Demo Mode (demoFlow.js)
`highmark_demo` client owns +18668906657. Fully deterministic, no AI calls. 3 paths (Q&A / Lead Capture / Booking) + lead capture funnel. State in `booking_data._demo`. Global commands: MENU, BACK, START OVER, YES/4 → lead capture. Analytics tracked in `demo_events` via `demoAnalytics.js`.

### Lead Follow-up Engine (followUpEngine.js)
`scheduleFollowUps(supabase, lead, fromPhone)` queues SMS sequences into `scheduled_messages`. Cron worker cancels if lead becomes engaged/converted. Lead statuses: `new → contacted → engaged → converted/closed/ignored`. Edit `SEQUENCES` in followUpEngine.js to add/modify sequences.

### Campaign Engine (campaigns.js + adminCampaigns.js)
Outbound SMS to filtered audience (`all_leads`, `engaged_leads`, `new_leads`). Templates support `{{name}}` / `{{first_name}}`. Status: `draft → sending/scheduled`. Routes: `POST/GET/PATCH /admin/campaigns`, `POST /admin/campaigns/:id/send`.

**Test-safety outbound guard (2026-06-25).** The test suite spawns the web server with `TEST_MODE=true` but writes to the **shared prod DB1**, and the live `highmark-cron` worker delivers any queued sends — so a campaign/event/follow-up test once blasted the owner's real phone (an `engaged_lead`) with live SMS. The fan-out paths now refuse to enqueue when `process.env.TEST_MODE === "true"`: `enqueueCampaign` (campaigns.js) and `scheduleFollowUps` (followUpEngine.js) short-circuit before touching the DB; `fireCampaign` (campaignTriggers.js) computes reach but skips enqueue when `dryRun || TEST_MODE`. `/admin/simulate-event` accepts `dry_run:true` (previews eligibility without sending — also a real ops feature). Direct unit tests call these in the runner process (no `TEST_MODE`) with mock DBs, so their assertions are unaffected. Regression-locked in `test34` (enqueue guard) + the `simulate-event dry_run` assertion. The direct `scheduleMessage` scheduler path is intentionally NOT guarded (test17 uses synthetic +1555 numbers + its own client + cleanup).

### Client Portal (portalAuth.js + adminPortal.js)
`/portal` — Supabase Auth + `portal_users` table. Roles: `internal_admin`, `client_admin`, `client_user`. JWT validated on every `/portal/api/*` request. 3-layer client scoping. Sections: Dashboard, Leads, Campaigns, Partners, Analytics, Settings, Users & Access.
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
FH webhook (authenticated — see Webhook Security/P0-2) + 30-min poller (runs in the cron
worker). Confirmation link: `fareharbor.com/embeds/book/{shortname}/items/{pk}/booking/{uuid}/`.
**Idempotency (P0-2):** the "booked" path now does an atomic CLAIM — inserts the
`confirmations_sent` row (UNIQUE `booking_pk`) BEFORE sending; only the winning caller
texts, so webhook + poll can't double-send. On Twilio send failure the claim is rolled
back (deleted) so the poll retries. Cancellations idempotent via `cancellation_sent`
column. Rebooking: cancel old + confirm new.

### Activity Distribution Network (partnerActivities.js — Sprint 5)
Partners listed in `partner_activities` (DB1) surface as **Source 5** inside `resolveBookingLink()` with confidence `0.60` — only when no config (1.0/0.75), api (0.85), or crawl (0.70) match. Never overrides the client's own booking links. Context (≤12 partners, season-filtered) is appended to the `KNOWLEDGE_BASE` block in `getKnowledgeContext()`. All outbound URLs are rewritten to `/track/partner?id=<uuid>` which 302-redirects to `booking_url` and fire-and-forget logs `partner_link_clicked` to `web_events`. SMS sends that pick Source 5 log `partner_link_sent`. Portal → Partners page: CRUD + per-partner CTR analytics (`GET /portal/api/partners/analytics?days=30`). Categories: tour / rental / lodging / dining / transport / other. Seasons: all / winter / summer / shoulder (shoulder includes winter + summer partners).

### Voice AI — Phase 1: Infrastructure + Call Logging (voice.js)
First-class voice module that plugs into the existing platform (same clients, CRM, knowledge). Phase 1 answers inbound Twilio Voice calls per client, speaks a per-client greeting, then either **forwards to a human** (in business hours + an E.164 transfer target) or **takes a voicemail** (after hours / no target) — a call is never dropped. Every call is logged to `voice_calls` keyed by Twilio `CallSid` (idempotent upsert), with status + recording callbacks patching the same row.
- **Routes** (all guarded by the same P0-1 `validateTwilioSignature` as `/sms`, since Twilio signs voice callbacks too): `POST /voice/incoming` (answer + TwiML), `POST /voice/status` (Dial/voicemail action + status callback → status/duration/recording), `POST /voice/recording` (recording-status callback → `recording_url`, marks `outcome=voicemail`). Portal read: `GET /portal/api/voice/calls` (client-scoped log + `summarizeVoiceCallStats` dashboard counters).
- **Config resolution** (`buildVoiceAgentConfig`): `DEFAULT_VOICE_AGENT` ← client defaults (botName/industry) ← `voice_agents` DB row ← `voice_numbers.forwarding_number` (most specific). Last-resort transfer target is `client.handoffPhone` **only if E.164** (display numbers like `(970) 439-1707` are never dialed). Call routing prefers a `voice_numbers` row → `resolveClientById`, falling back to the SMS `resolveClient(toNumber)` mapping.
- **Pure helpers** (unit-tested, no I/O): `escapeXml`, `isE164`, `buildVoiceAgentConfig`, `buildGreeting`, `isWithinBusinessHours` (timezone-aware via `Intl`; `null` hours = always open), `buildIncomingTwiml` / `buildVoicemailTwiml` / `buildHangupTwiml`, `normalizeCallStatus` (Twilio status → our vocabulary), `summarizeVoiceCallStats`. DB writers (`claimCall`, `updateCallBySid`, `getVoiceAgent`, `getVoiceNumber`, `listVoiceCalls`) all degrade gracefully if `db1_voice.sql` hasn't been applied.
- **Migration:** `db1_voice.sql` — `voice_numbers`, `voice_agents`, `voice_calls`. Additive + non-breaking; SMS stack untouched. Run once in DB1, then point a Twilio number's Voice webhook at `/voice/incoming` and add a `voice_numbers` row (+ optional `voice_agents` row) for the client.
- **Outcomes vocabulary:** spam · lead · customer · booking · support · voicemail · transferred · completed · no_answer. (`spam_score`/`lead_score` columns exist now but are populated by later phases: Phase 3 lead qualification, Phase 4 shared spam network.)
- **Env:** reuses `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`; callbacks use `PUBLIC_BASE_URL` when set (else Twilio resolves relative paths against the webhook host). Tests: `testVoiceAI()` in test.js (pure builders + config merge + hours + stat rollups + route guards).

### Voice AI — Phase 2: Conversational AI Receptionist (voice.js)
When a client's `voice_agents.ai_enabled = true`, the call becomes a real two-way conversation instead of a straight forward. Built on Twilio's **built-in speech `<Gather>`** (no Media-Streams websockets, no external STT/TTS vendors): caller speaks → Twilio transcribes → Claude answers from the client's knowledge base → `<Say>` the reply → listen again. The AI transfers to a human or ends the call only when it decides to. Conversation state + transcript persist on the `voice_calls` row across turns.
- **Route:** `POST /voice/respond` (same P0-1 guard) — one conversational turn. `/voice/incoming` branches: `aiEnabled && enabled && anthropic` → greet + `<Gather input="speech" action="/voice/respond" actionOnEmptyResult="true">`; otherwise Phase 1 forward/voicemail.
- **Turn loop** (`handleVoiceRespond`): loads call state from `voice_calls.metadata` (`{ turns:[{role,text}], no_input, kb }`), resolves client + agent config, lazily caches `getKnowledgeContext` in metadata after the first turn, calls Claude (`generateVoiceReply`, model `VOICE_AI_MODEL` = `claude-haiku-4-5-20251001` for low latency, max 200 tokens), then `parseAgentDecision` reads a trailing control token: `[TRANSFER]` → `<Dial>` the E.164 forwarding number (voicemail fallback if no agent answers / no E.164 target), `[END]` → friendly hangup, else `<Gather>` again. Empty `SpeechResult` reprompts once, then transfers or takes a message. `detectCallerEndIntent` is a belt-and-suspenders sign-off catch.
- **Post-call** (`handleVoiceStatus`): on FINAL parent-call completion (not the mid-call Dial action; gated on absence of `DialCallStatus` + terminal `CallStatus`), `summarizeVoiceCall` (Haiku, JSON out) writes a one-line `summary` + classifies `outcome` (idempotent — skips if a summary already exists).
- **Pure helpers** (unit-tested): `cleanForSpeech` (strips control tokens / URLs→"our website" / markdown / emoji), `parseAgentDecision`, `detectCallerEndIntent`, `buildReceptionistSystemPrompt` (persona + spoken-reply rules + KB; notes "take a message" when no live agent), `buildGatherTwiml`, `buildTranscript`. Claude callers `generateVoiceReply` / `summarizeVoiceCall` degrade to a safe transfer/empty result on error.
- **Spam guard (conversation-level):** solicitors never reach the human transfer line. `detectSpamSignals` (deterministic phrase match in `SPAM_PHRASES`) short-circuits instantly → polite decline + hangup + `outcome=spam`, `spam_score=0.95`; Claude can also emit a `[SPAM]` control token for subtler pitches (`parseAgentDecision` → action `spam`). Neither path ever `<Dial>`s. (Pre-answer robocall blocking via Twilio Lookup line-type/CNAM is a future hard-block.)
- **Latency:** per-turn it (1) skips the `voice_agents`/`voice_numbers` lookups by caching `client_id` + `fwd` in `voice_calls.metadata` at answer time, (2) caps injected KB to ~2800 chars, and (3) `generateVoiceReply` uses a raw API call with `cache_control: ephemeral` on the system block (KB) — a prompt-cache hit on turns 2+ cuts input tokens ~90% and shaves latency; SDK path is the fallback. Model `claude-haiku-4-5`, 160 max tokens.
- **Portal config:** `GET /portal/api/voice/config` (number(s) + agent) and `PATCH /portal/api/voice/config` (`forwarding_number` E.164-validated, `ai_enabled`, `welcome_prompt`, `business_hours`; mirrors forwarding onto `voice_numbers`; `client_user` → 403) via `handlePortalVoiceConfig` / `handlePortalUpdateVoiceConfig` + `validateVoiceConfigInput` + `normalizeBusinessHoursInput`. Lives in its own mobile-friendly portal section **Voice AI** (`sec-voice`, nav + mobile More): receptionist config, business-hours editor, and the call log + stat chips (`loadVoiceSection` → `loadVoiceConfig`/`renderVoiceHours`/`loadVoiceCalls`).
- **Persona:** `buildReceptionistSystemPrompt` = warm, upbeat local expert who NEVER reveals it's an AI (says it's "with the team") and ends each answer with an engaging follow-up. Greeting drives nothing AI-ish.
- **Voice (TTS):** every `<Say>`/`<Gather>` uses Amazon Polly **neural** voices (default `Polly.Joanna-Neural`, far more human than standard Polly). Per-agent `voice_agents.voice` column, surfaced as a picker in the Voice AI tab (`VOICE_OPTIONS`), cached in `voice_calls.metadata.voice` and threaded through all turn TwiML. `generateVoiceReply` is capped at 120 tokens for snappier replies; the remaining per-turn delay is mostly Twilio's speech endpointing — a true low-latency upgrade is Media Streams (speech-to-speech).

### Voice AI — Phase 3: Hours, Seasons, Missed-Call Recovery (voice.js)
- **Business hours honored:** at answer time `isWithinBusinessHours(agent.business_hours)` is computed and cached in `voice_calls.metadata.within_hours`. The receptionist only transfers to a human when `isE164(fwd) && within_hours` — **outside hours it never dials**; the prompt switches to "team isn't available, take a message" mode and ends with `[END]`. Hours are edited in the Voice AI tab (per-day open/close, timezone from the client). Empty hours = always open (Phase 1/2 behavior).
- **Season awareness:** `resolveVoiceSeason(client)` reads the client's `seasonConfig` MM-DD ranges (the portal Season Ranges; winter wraps year-end), else month-based. Injected into the prompt so the receptionist only offers in-season activities and says when out-of-season ones return.
- **Missed-call recovery + lead scoring:** on final call completion `summarizeVoiceCall` now also returns `lead_score` (0–1, stored on the row). `runMissedCallRecovery` then logs every real (non-spam) caller as a lead via `saveLead` (`leadType/source: "voice"`) so they show in the Leads tab, and — for genuinely missed calls (after-hours / no-answer / voicemail, not transferred) — texts the caller back with `buildMissedCallSms` (TCPA-safe, "Reply STOP"). Idempotent via `metadata.recovery_done`; skipped in TEST_MODE. Deps wired in `voiceDeps`: `twilioClient`, `saveLead`.

### Voice AI — Phase 4: Shared Spam Network + Pre-Answer Block (voice.js)
A cross-client blocklist (`spam_numbers`, DB1) so a solicitor flagged on ANY client's call is hard-blocked for EVERYONE on their next call.
- **Learn:** whenever a call is classified spam (deterministic `detectSpamSignals` → score 0.95, or Claude `[SPAM]` → 0.9), `recordSpamNumber` upserts the caller into `spam_numbers` (increments `reports`, raises `score`, appends `sources`, sets `blocked` once `score ≥ SPAM_BLOCK_SCORE 0.9` OR `reports ≥ SPAM_BLOCK_REPORTS 2`).
- **Block (pre-answer):** `handleVoiceIncoming` looks up `From` FIRST; `isBlockedCaller(row)` true → `buildRejectTwiml()` (`<Reject/>`) — the robocaller is rejected **before the call is answered** (no greeting, no AI, no human, ~no cost), logged `outcome=spam`. One extra indexed DB read per call.
- **Portal:** `GET /portal/api/voice/spam` (`handlePortalVoiceSpam`) → network totals + this client's blocked-call count + recently blocked numbers; rendered as a "Spam screening" card in the Voice AI tab (`loadVoiceSpam`).
- **Migration:** `db1_voice_spam.sql` — `spam_numbers` (UNIQUE `phone_number`, RLS on). Applied.
- **Note:** pre-answer Twilio **Lookup** (line-type/CNAM) for unknown numbers is a future add (paid per-lookup); the shared blocklist is free + instant and covers repeat offenders.
- **Voice (TTS) default:** `Polly.Danielle-Neural` (newer, warmer). Per-agent override via the Voice AI tab picker.
- **Next:** Phase 5 industry agents. **COME BACK TO — real-time latency upgrade:** swap turn-based `<Gather>` speech for **Twilio Media Streams** (bidirectional audio websocket → streaming STT → Claude → streaming TTS) for sub-second, interruptible, speech-to-speech conversation, behind the same `/voice/*` routes. This is the true fix for per-turn delay (the current ~1–2s gap is mostly Twilio's speech endpointing).

### Self-Serve Signup (selfSignup.js — Sprint 7)
Public `/signup` page collects businessName / websiteUrl / email / password. `POST /api/signup` (rate-limited 10/hr per IP) validates, calls `auth.admin.createUser`, inserts a `portal_users` row (role=`client_admin`, client_id=null), inserts an `onboarding_drafts` placeholder (status=`processing`, `owner_auth_user_id`=auth user), kicks off `runOnboardingCrawl` via `setImmediate` (calls `startAutoConfig` then promotes the placeholder to status=`draft`, removing the duplicate row startAutoConfig creates internally), and texts `TEAM_NOTIFY_PHONE` (+17202892483). After signup the client signs in (same credentials), is redirected to `/portal/onboarding`, which polls `GET /portal/api/onboarding/status` every 3s. States returned: `processing` (spinner), `draft` (3-section preview Business/Bot/Booking + warnings + Approve), `failed` (error_message), `approved` / `saved` with `clientId` (redirect to `/portal/dashboard`). `POST /portal/api/onboarding/approve` calls `commitDraftToDb`, updates `portal_users.client_id`, notifies team. Migration `db1_onboarding_status.sql` extends `onboarding_drafts.status` CHECK to add `processing` and `failed` and adds `owner_auth_user_id` (+ index) and `error_message` columns. Dashboard handler (`adminPortal.js`) computes an `onboarding_banner` (kind: `twilio_pending` when no inbound phone yet, `test_mode` when inbound phone exists but `bot_mode='test'`) which `portal.html` renders above the checklist.

### Vertical Landing Pages (verticals.js — Sprint 6)
Three industry pages render server-side from a single `VERTICAL_SLUGS` array: `/tour-operators`, `/snowmobile-rentals`, `/service-businesses`. Each has a unique `<head>` (meta + canonical + FAQPage + SoftwareApplication JSON-LD), hero, dual-channel SMS + Web Chat demo conversations, and 3-item industry FAQ. Nav, demo CTAs, pricing section (Free/Growth/Pro — must mirror `public/home.html`), demo band, and footer are shared via `renderVerticalPage(slug)`. Homepage `.use-card` blocks now link to the matching vertical. `public/sitemap.xml` lists all 3 at priority 0.8.

### Whole-Site Crawler (crawler.js)
BFS crawl from `crawlSettings.primaryUrl`, same-domain only, skips junk paths. Per-page: classify (10 types) → Haiku fact extraction (hash-gated). Output: `buildCrawlerContext()` assembles ≤1500 char `WEBSITE KNOWLEDGE:` block from `client_pages` table. Cron: Monday 4am.
Enable: `crawlSettings: { enabled: true, primaryUrl: "https://..." }` in `clients.js` or via `crawl_settings` JSONB on DB-backed clients.

### Operator/Owner Mode — Phase X Intelligence (ownerMode.js + operatorIntentParser.js + operatorBriefing.js + actionEngine.js)
Two-layer system. **Layer 1** (deterministic, ~95% of operator queries): `detectOperatorIntent` parses intent + season/date range + grouping + metric + company/location filter. `detectAndHandleOperatorCommand` routes to action handlers in `actionEngine.js` (`get_bookings_by_date_range`, `report`, `daily_summary`, `get_lead_summary`, `analyze_performance`, `get_missed_leads`, `get_campaign_stats`, `send_campaign` w/ YES confirm, `flag_issue`). DB2 `daily_manifest` preferred (real pax + total + location); DB1 `confirmations_sent` fallback. **Layer 2** (Claude fallback): when Layer 1 returns null, `agentOrchestrator` calls Claude with `buildOwnerInstruction` (full Phase X rules) appended to the system prompt.

**Context memory across turns** (Phase X b). `mergeOperatorContext` merges the freshly-parsed intent with the prior turn's `_operator` slot persisted on `convo.bookingData`. Vague follow-ups inherit timeframe + entity + metric: "kremmling" → swap entity, "what about steamboat?" → swap entity keep timeframe, "and revenue?" → swap metric keep entity + timeframe. `extractOperatorContext` is what gets stamped after each successful structured route; the orchestrator threads `convo` in so persistence is automatic via reference mutation. `FILLER_STARTS` includes `and / or / but / &` to stop spurious company_filter extraction.

**Fallback intelligence on 0 rows** (Phase X c). `handleGetBookingsByDateRange` retry ladder: drop location → drop company → broaden to last 90 days. Each level prepends a one-line "I'm not seeing X — here's Y:" note. Truly-empty state suggests a campaign rather than emitting "no records". `buildOperatorInsight` (exported pure helper) picks one operator-facing insight per response from a strategy ladder: location dominance ≥60% → barely-contributing 2nd <15% with top 50–60% → company dominance ≥70% → small-group pattern (avg pax ≤2.4) → top activity ≥40%. `formatPhaseXBookingReply` renders the bullet template (• Bookings / Guests / Revenue + insight + optional By location: / By company: / Top activities:) for both `handleGetBookingsByDateRange` and `handleReport`.

**Owner detection** (`ownerMode.detectOwner`). Matches `fromNumber` against `client.ownerPhone` (preferred) or `operatorPhones[]`, both normalized to E.164. `getRuntimeClientConfig` derives both **from the `operator_phones` table** (per-phone `internal_mode_enabled`) on every request, so portal-added phones are recognized. When true, the orchestrator: (1) intercepts pending-action YES/NO confirmations, (2) tries `detectAndHandleOperatorCommand` for a deterministic reply, (3) falls through to Claude with `buildOwnerInstruction` appended. Customer-only actions (`capture_lead`, `escalate_to_human`) blocked via `isOwnerActionAllowed`.

**Operator inbound routing (critical).** `smsOrchestrator.handleSmsRequest` routes a recognized operator phone to `runOrchestrator` as the **FIRST** branch of the message chain — bypassing ALL guest flows (booking menus, lead capture, demo). This is essential because several guest branches (booking-intent, `menuKey`/`routeMenuSelection`) are NOT `!isOwner`-gated, so without the early short-circuit an operator's numeric briefing reply ("1") would be parsed as a booking-menu selection and return guest booking links instead of the manifest. The orchestrator handles numeric briefing replies (1–8 via `OPERATOR_MENU`) + structured queries deterministically, and free-form questions ("who's missing waivers?") via Claude in owner mode — and is called directly so it works regardless of `AGENT_ORCHESTRATOR_ENABLED`. Regression: `testOperatorInboundRouting`.

**Per-employee location scoping + FLEET work orders** (operatorBriefing.js). Each `operator_phones` row carries `locations TEXT[]` (subset of `steamboat / north_routt / kremmling / rabbit_ears`; empty = unscoped = owner view). When a phone is scoped, `generateDailyBriefing` **strict-filters** every location-bearing array (manifest, upcoming, unpaid, waivers, high-value, missing-phones, location mix) to those locations via `filterManifestByLocations`, recomputes upcoming revenue from the filtered rows, and **suppresses company-wide aggregates** (collected/season revenue, pacing, new-booking counts) so a post never leaks another location's numbers. The header gets a scope tag (`… · Kremmling`). `digest_types` section gating is now actually wired via `wantsSection(digestTypes, category)` (was a latent no-op): `bookings`→TODAY'S LOAD + NEXT 7 DAYS, `staffing`→ACTIONS, `revenue`→REVENUE + INSIGHTS, `leads`→FOLLOW UP, `weather`→CONDITIONS, `issues`→SYSTEM, `fleet`→FLEET work orders. `['all']` (default) shows everything — backward compatible.

**Briefing altitude — summary vs detailed** (`db1_operator_briefing_detail.sql`, `operator_phones.briefing_detail` ∈ `auto|summary|detailed`). `resolveDetailLevel(detail, locations)`: `auto` → **detailed** when scoped to a specific post (1–3 of 4 locations), **summary** for owner / all-locations / unscoped; explicit values override. **Detailed** (staff) = per-booking lines with phone + inline `⚠ no waiver`, named "Chase waivers (N): …", and the full work-order list with `⚠️ OVERDUE`/`due` flags + MPWR links. **Summary** (owner) = compact breakdowns (no per-booking phones), waiver count, and the fleet collapsed to a one-line rollup via `buildWorkOrderRollup` (`N units out of service — A Kremmling, B Steamboat` + `M overdue (oldest: UNIT, due DATE)`, no links). `isWorkOrderOverdue` flags any WO whose est. completion is in the past (most never-closed ones). Threaded through `generateDailyBriefing`/`dispatchOperatorDigests`; portal exposes a per-phone "Detail level" dropdown. `buildBriefingText` defaults to `detailed` for legacy/direct callers.

### Operator Intelligence 2.0 — the SMS Operations Center (priorityEngine.js + operatorRoles.js + operatorBriefing.js)
The briefing is an **action center, not a report** — each employee gets *their next actions*, role-aware, highest-impact first. Routed by **altitude tier**: `executive` (owner pulse) · `standard` (manager actions) · `operational` (staff play-by-play) · `diagnostic` (raw → falls back to legacy `buildBriefingText`). Tier resolves from `operator_phones.briefing_detail` (legacy `auto/summary/detailed` mapped via `normalizeDetail`); `auto` → the role's `defaultDetail`.
- **Roles** (`operatorRoles.js`): 8 canonical (`owner, general_manager, operations_manager, reservations, fleet, mechanic, guide, marketing`); legacy `owner/manager/sales/staff` normalized via `normalizeRole`. `ROLE_PROFILES[role]` = `{ defaultDetail, focusAreas[], cardOrder[], priorityWeights }`. `resolveFocusAreas(role, digestTypes)` — explicit focus areas override the role default.
- **Priority engine** (`priorityEngine.js`, pure, unit-tested): `scorePriorities(ctx, {role})` scores candidate issues by a rubric (safety 100, no-waiver-today 90, OOS-unit-needed-for-a-today-departure 85, VIP/large group 80, large unpaid 70, overdue repair 65, handoff 60, underbooked 55, pacing-down/missing-phone 50, high-value 45, maintenance-due 40), then re-weights by `ROLE_PROFILES.priorityWeights` so a mechanic's #1 ≠ an owner's. `buildTodaysPriorities(scored, n)` → the "TODAY'S PRIORITIES" header. The OOS-needed join matches an out-of-service unit's model tokens against today's booked activities.
- **Action-card briefing** (`buildActionCardBriefing` in `operatorBriefing.js`, pure): conversational greeting (`🏔 Good morning, John.`) + lead priority + `📋 TODAY'S PRIORITIES` (1–3) + role-ordered **action cards** (`headline · status · Reply N`, expanded to detail lines at operational tier) + the 2.0 reply menu. **Owner/manager cards carry the full high-level picture** (mirroring the legacy briefing): the `bookings`/`today` card adds `Locations · Vehicles · Pickups` summary lines (which locations the day is at), the `upcoming` card is a NEXT-7-DAYS projection (bookings · guests · revenue + locations + vehicle mix + busiest day), the `revenue` card adds `Largest upcoming: <name> $X (date, vehicle)`, and the `fleet` card adds the location breakdown (`4 Kremmling, 1 Steamboat`) + oldest overdue. These summary lines show at every tier; only operational adds per-booking detail (`breakdownLines` helper) (`1 Schedule · 2 Revenue · 3 Waivers · 4 Late returns · 5 Work orders · 6 Hot leads · 7 Staff · 8 Ask AI`). `OPERATOR_MENU` remapped to these 8; new reply handlers: `late returns`, `work orders`, `ask ai`. Free-text questions still fall through to the Claude Layer-2 Ask-AI path.
- **Time-of-day** (`resolveTimeOfDay(hour)`): **morning** (<11) = today's plan; **evening** (≥16) = tomorrow prep (`📅 Tomorrow` card from the upcoming window, "TOMORROW'S PREP" header). `dispatchOperatorDigests` derives it from which `digest_times` slot fired and passes `role`/`displayName`/`timeOfDay` into `generateDailyBriefing`.
- **Portal** Settings → Operator Intelligence is now a per-person config (Person/Role/Locations/Detail level/Focus areas/Delivery/Channels). Email/Push channels are stubbed "coming soon". Tests: `testOperatorIntelligence2`.

**Portal reorg + dedicated Operator Intelligence hub.** The sidebar nav is grouped into labeled sections — **Customers** (Conversations/Leads/Campaigns/Messaging) · **Operations** (Operations/Operator Intelligence/Voice AI, client-admin) · **Growth** (Analytics/Optimization/Partners) · **Setup** (Knowledge/Settings/Users) · **Admin** (Clients/New Client). The per-phone briefing config (operator phones) moved OUT of Settings into its own **Operator Intelligence** section (`sec-operator`, was "Operator View") which holds **📟 Briefing Recipients** (the operator-phones cards) + **🔧 Open Work Orders**. Work orders are individually accessible: `GET /portal/api/work-orders` (`handlePortalWorkOrders`, season-filtered via `getOpenWorkOrders`) returns each open WO with work type, created + estimated-completion dates, notes, out-of-service/overdue/safety flags, and the MPWR deep link; `loadWorkOrders` renders them as tap-to-open cards. Settings shows a pointer card to the section. **Briefing copy:** the lead line frames the day (load + count) instead of repeating priority #1; safety-flagged work orders read "Open work order: <unit> — <work type>" (not "Safety check").

**Phase 2 — Mission Control dashboard + midday briefing.** The portal **Dashboard** is now a per-user customizable **Mission Control**: a role-preset dropdown + draggable widget grid (SortableJS) above the existing ROI/funnel view. Widgets: Action Items (priority engine), Today's Bookings, Upcoming Week, Fleet & Work Orders, Revenue, Leads, Weather — all from one aggregator `GET /portal/api/dashboard/widgets?role=` (`handlePortalDashboardWidgets`, reuses the briefing detectors + `scorePriorities`). Layout persists per portal user via `PUT /portal/api/dashboard/layout` → `portal_users.dashboard_layout` JSONB (`db1_dashboard_layout.sql`). Widget registry + role→default-widget presets + `resolveDashboardWidgets(role, saved)` live in `operatorRoles.js` (`DASHBOARD_WIDGETS`, `DASHBOARD_PRESETS`). Briefing gained a **midday** variant (`resolveTimeOfDay` → `day` 11am–4pm): "Good afternoon" + `📋 STILL OPEN` header. **Still deferred:** Email/Push channels (no mailer/VAPID infra), the AI-module plug-in framework (priorityEngine `category→score` + card registry are the extension points).

**Season-aware fleet + ordered SMS delivery (iteration).** `getOpenWorkOrders` filters out **out-of-season vehicles** via `isWorkOrderInSeason(wo, currentSeason())` — in **summer**, snowmobile work orders (RMK / Khaos / Indy / sled, per `vehicleSeason(asset_family)`) are parked and excluded from the briefing + priorities (RZR/GENERAL kept); winter/shoulder keep everything. The briefing is sent via `sendChunkedSms` → `splitForSms` (splits at blank-line/section boundaries, packs whole sections ≤480 chars, sends sequentially with a ~1.1s delay) so a long multi-segment digest **arrives top-to-bottom in order** instead of as out-of-order concatenated SMS (greeting/priorities first, reply menu last). Both are pure-helper unit-tested in `testOperatorIntelligence2`.

The **🔧 FLEET / WORK ORDERS** section surfaces open MPWR maintenance scoped to the recipient's fleet(s) (`locationsToFleets`: Kremmling→`kremmling`, everything else→`steamboat`). `mpwrWorkOrders.runWorkOrderSync` (cron worker, same :00/:30 window as the booking sync) pulls `/work-orders.data` per outfitter, fetches `/work-orders/{id}.data` for each **open** WO to enrich model + rentability, and upserts into DB2 `work_orders`. **Out-of-service is derived from the vehicle, not the WO** — `rentabilityStatus` "Not Rentable" on an active unit = down; dispositioned/inactive vehicles are flagged `retired` and **excluded** from the briefing (never-closed cruft). `getOpenWorkOrders` returns open, non-retired WOs sorted by `workOrderUrgencyCmp` (out-of-service → safety issue → soonest est. completion). The MPWR deep link is always included. Pure helpers (`fleetForLocation`, `normalizeLocations`, `locationsToFleets`, `filterManifestByLocations`, `wantsSection`, `workOrderUrgencyCmp`, `buildWorkOrdersLines`, `humanizeWorkType`, `deriveOutOfService`, `isVehicleRetired`, `normalizeWorkOrderRow`) are unit-tested in `testLocationFleetBriefing`. Portal **Settings → Operator Intelligence** card adds a per-phone Locations checkbox row + a `fleet` section toggle. Reuses `MPWR_TOKEN` + `MPWR_OUTFITTER_*` (must be set on the **highmark-cron** service). Degrades gracefully if `db2_work_orders.sql` / the `locations` column are absent.

### Knowledge Base Refresh
All recurring refresh jobs run in the **cron worker** (`cron-worker.js`), NOT the web
process (P0-3). The worker ticks every 5 min; `knowledgeBase.dueKnowledgeJobs(now)`
maps each schedule below to a UTC window check, so each job fires exactly once per
occurrence regardless of how many web instances run. The web process only does a
one-shot, staleness-gated **boot warm-up** in `initKnowledgeBase`. The FareHarbor
fallback poll likewise moved to the worker (`pollNewBookings` + `isFareHarborPollDue`,
:00/:30 windows); the web keeps only the `/fareharbor/webhook` route.

| Data | Schedule (UTC) | Method |
|---|---|---|
| FH items (catalog, pricing) | Daily 2am | JS from FH API |
| FH availability | Every 3hr | JS from FH minimal endpoint |
| Weather | Every 1hr | OpenWeather (Steamboat + Rabbit Ears Pass + Storm Peak) |
| Snow conditions | Every 3hr (:30) | SNOTEL 4 stations + CAIC avalanche danger |
| Website | Monday 3am | Single Haiku call, hash-gated |
| Whole-site crawl | Monday 4am | crawler.js BFS + per-page Haiku |
| Optimization analysis | Daily 5am | optimizationEngine per client |

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

### Progressive SMS Opt-In on Web Chat (smsOptIn.js — Prompt 7B)
Web chat does NOT show consent on open. The state machine in `runSmsOptInFlow`
(webChat.js) runs after the first-message gate, before handoff/Claude:
1. **Consent pending** (`sms_consent_requested=true`) → `detectConsentReply` classifies
   yes/no/unknown. Yes → flips `sms_opted_in=true`, asks for phone. No → low-friction
   "I'll keep everything here in chat." Unknown → clears the flag, falls through.
2. **Already opted in + phone present** → `saveLead({ leadType: "sms_opt_in" })`,
   `linkSessionToLead`, `trackWebEvent("sms_opt_in_captured")`, and CRM
   `upsertContact(phone, { tags: ["sms_lead"] })` (DB2, only when `client.crmEnabled`).
3. **Not opted in + `isSmsIntent(message)`** → sets `sms_consent_requested=true`, sends
   `buildConsentPrompt(client)` (benefit-led with "Msg & data rates may apply. Reply STOP").
The existing web→SMS bridgePhone path is now gated on `convo.smsOptedIn`, so a phone
mentioned in passing without consent is ignored on the SMS side. Persisted on the
`conversations` row via columns `sms_opted_in`, `sms_opted_in_at`, `sms_consent_requested`
(migration: `db1_sms_consent.sql`).

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
22. **Voice AI — LIVE (Phase 1 + Phase 2)** — `db1_voice.sql` applied to DB1; `voice_numbers` + `voice_agents` (ai_enabled=true) rows exist for the demo number `+18668906657` forwarding to `+17202892483`. Twilio Voice webhook → `POST /voice/incoming`, status callback → `POST /voice/status`. Phases 1–4 deployed & call-tested: forward/voicemail, conversational AI receptionist (`<Gather>` speech), hours/seasons honored, missed-call→lead+recovery SMS, and the shared spam network with pre-answer `<Reject/>`. Live numbers `+18668906657` (demo) + `+18335786496` (csr_rea) → forward `+17202892483`. Portal **Voice AI** tab = config + hours editor + spam screening + call log. Neural TTS (`Polly.Danielle-Neural` default). **Next:** Phase 5 industry agents. **COME BACK TO:** Twilio **Media Streams** real-time speech-to-speech upgrade (the true per-turn latency fix) behind the same `/voice/*` routes.
