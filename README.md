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
voice.js                — Voice AI Phase 1: Twilio Voice webhooks (/voice/incoming|status|recording), per-client agent config, TwiML builders, call logging
db1_voice.sql           — migration: voice_numbers, voice_agents, voice_calls (Voice AI Phase 1)
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
verticals.js            — Sprint 6: vertical landing pages (/tour-operators, /snowmobile-rentals, /service-businesses) — VERTICALS config + renderVerticalPage()
selfSignup.js           — Sprint 7: public /signup + POST /api/signup + onboarding status/approve handlers
db1_onboarding_status.sql — Sprint 7 migration: extends onboarding_drafts.status CHECK + adds owner_auth_user_id, error_message
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

## Voice AI — Phase 1 (voice.js)

The AI employee that answers phone calls, not just texts — a first-class,
multi-tenant module on the same clients/CRM/knowledge as the SMS bot.

- Twilio Voice webhook → `https://your-railway-url/voice/incoming` (HTTP POST)
- Answers with a per-client greeting, then **forwards to a human** (in business
  hours + an E.164 transfer target) or **takes a voicemail** — never drops a call
- Every call logged to `voice_calls` keyed by Twilio `CallSid` (idempotent);
  `/voice/status` + `/voice/recording` callbacks patch the same row
- Portal: `GET /portal/api/voice/calls` → client-scoped log + dashboard counters
- Same `validateTwilioSignature` (P0-1) guard as `/sms`
- Go live: run `db1_voice.sql` in DB1, add a `voice_numbers` row (+ optional
  `voice_agents` row with `forwarding_number` / `business_hours`), point the Twilio
  number's Voice webhook at `/voice/incoming`
- Outcomes: spam · lead · customer · booking · support · voicemail · transferred ·
  completed · no_answer. Realtime AI conversation, lead scoring, missed-call SMS
  recovery, and a shared spam network land in Phases 2–5.

---

Built by Whiteout Solutions · Steamboat Springs, CO

## Ride Recap emails (rideRecap.js)

A branded "thanks for riding" email to every guest whose tour or rental finished that day (Rabbit Ears tour, CSR guided
backcountry, CSR rental). It asks for a Google review (with a "Tell us directly" link for every guest), shares the
FRIEND10 referral code, offers prints/merch and the next ride. Spec: `docs/sprints/sprint-ride-recap.md`.

**How it runs.** The cron worker checks every 5 minutes. When the local clock reaches `recap_settings.send_hour` (default
18:00 America/Denver) and the job hasn't run that day, it queues one recap per guest in `email_sends`
(`transport='gmail'`, `category='recap'`). The Apps Script `drainQueue` trigger sends them from info@ within 10 minutes and
fills in the ride photo from Drive (`Tour Photos/<date>/<Label> <time> - … .jpg`, see `rideMedia.js`).

**Migration:** `db2_ride_recap.sql` (DB2, applied 2026-11-22).

**Edit tours and settings** in the Supabase Table Editor (DB2, no deploy):
- `recap_tours`: `match` is a piece of the FareHarbor item name. `type` is `rea`, `backcountry`, `rental`, or `skip` (never email).
  `label` is shown in the email and used to find the photo. Fill in `miles`, `high_point_ft` and `stops` (REA) when you have
  them; anything blank is left out of the email. Set `active` to false to stop a tour.
- `recap_settings` (one row, `csr_rea`): `send_hour`, `features` (remove `merch` to hide it), `friend_code`/`friend_percent`,
  `weather_points` (list of `{name, type, match, lat, lon}`; the first entry whose type matches the recap and whose `match` is in the
  item name wins — REA ranch, Columbine trailhead, Kremmling shop, Steamboat shop), `weather_lat`/`weather_lon` (fallback; blank =
  no weather labels), `reward_code` (blank = referral rewards off; currently FRIEND10).

**Turn off dry run.** While `dry_run` is true (the default), every recap goes to `test_to` with "[TEST]" in the subject.
Set `dry_run` to false to start emailing guests. Recaps already sent in dry run are not re-sent to the guests.

**Check what happened.**
- `recap_log`: one row per booking (guest `email`, `sent_to`, `type`, `dry_run`, `photo` once sent, `send_id` → `email_sends`
  for status/opens/clicks). Bookings folded into one email (e.g. two sleds on one order) point at `primary_booking_id`.
- `recap_review`: bookings skipped because the email is missing or invalid. Fix the email in FareHarbor; the next run
  (within `lookback_days`) picks it up.
- `recap_settings.last_run_on` / `last_run_summary`: when it last ran and what it queued. To re-run today, clear `last_run_on`
  (bookings already in `recap_log` are never emailed twice).

**Preview without sending:** `node --env-file=.env rideRecap.js` prints today's plan (nothing written);
`node rideRecap.js --snapshots out/` writes the six sample renders as HTML. Snapshots are in `snapshots/ride-recap/`
(`UPDATE_SNAPSHOTS=1 npm test` accepts a template change).

**Sharing.** The recap's share card has two buttons: **Send to a friend** and **Post your ride on Instagram**. Both open
`/r/share?b=<booking>&t=<type>` (Gmail strips `sms:` links from emails). That page has one main button per section: **Send to a
friend** (the phone's share sheet with the FRIEND10 message, or a text) and **Share to Instagram** (a 1080×1920 story image drawn in
the browser, shared through the share sheet where Instagram Stories appears). Where the browser can't share images (e.g. Gmail's
in-app browser) it says: press and hold the picture → Save to Photos → post it as your story. Small links: Copy message, Facebook,
Copy link. Facebook/Copy link share `/r/ride?b=…`, a public page showing only the tour, date and ride stats (no names), with a brand
preview image (`public/og-rea.png`, `og-csr.png`; regenerate with `node docs/og/render.cjs`) and a "Book your ride" button that
credits the guest (`ref=friend-<id>`). The ride photo joins the story card and preview once the Guide Ride Log provides a public copy
(`photoUrl` hook).

**A/B testing (automatic).** Every recap gets version A or B of each experiment: `subject` (statement vs question), `layout`
(review card after the stats vs right after the photo) and `share_cta` ("Send to a friend" vs "Give a friend 10% off"). Each is judged
by the click it's meant to drive (any click / the Google review button / the share buttons), from real sends only. 50/50 until each
version has 20 real sends, then traffic shifts toward the winner (Thompson sampling) while still testing the other a little. Lock or stop
one in `recap_settings.experiments`, e.g. `{"subject":"B","share_cta":"off"}` ("auto" is the default). Report:
`GET /api/v1/recaps/experiments` (sends, clicks, click rate, chance each version is best, "winner: A" at 95%). Every link carries the
versions in `utm_term`, so FareHarbor/Google Analytics bookings can be attributed too. Uses `db2_ride_recap_ab.sql` (applied 2026-11-22).

**Referral rewards.** When `reward_code` is set, each run looks for new bookings made through a shared link
(`ref=friend-<booking id>`, stored by FareHarbor as `online_booking_references`) and queues one "Your friend booked!" email
with the code to the referring guest, at most once per guest per season (`recap_rewards`).

### Templates: `v1` and `simple` (recapSimple.js, added 2026-11-22)

`recap_settings.template` picks the layout (migration `db2_ride_recap_v2.sql`). **`v1`** (default) is the email above,
byte-for-byte unchanged. **`simple`** is the v2 layout from the "Simple v2" design page: logo, one hero, kicker + headline +
one sentence, one stat line, "Your photos are ready", "Had a good day?", "Bring a friend", optional gear, book again, footer.

- **Switch:** in DB2 `recap_settings`, set `template` to `simple` (or back to `v1` for an instant fallback). No deploy needed;
  the next daily run uses it. Unknown values count as `v1`.
- **Preview first:** `npm run recap:preview -- --template=simple` writes the six sample cases to `tmp/recap-preview/*.html` and
  sends each as a `[TEST]` email to `recap_settings.test_to` only. `--booking=<FareHarbor id>` renders a real booking
  (read-only lookup; `--photo` adds the sample photo), `--case=a,b` picks cases, `--no-send` only writes files. Cloud sessions:
  prefix with `NODE_USE_ENV_PROXY=1`.
- **Photos are hosted, not attached.** For a simple recap the Apps Script finds the ride photo in Drive and uploads it to
  `POST /api/v1/recaps/photo`. The bot checks it is a strict match, resizes it with `sharp` (1200px JPEG under 250 KB, a
  1200×900 hero cropped ~35% from the top, three 400×300 thumbnails), stores it in the public Supabase Storage bucket
  `recap-photos` at `<YYYY-MM-DD>/<booking id>*.jpg`, and returns the finished email. An Apps Script without that code (or any
  upload problem) sends the no-photo version, so nothing breaks before Code.gs is pushed. v1 keeps its inline photo.
- **Strict photo matching (both templates):** the Drive day folder must be the ride date, the file name must contain the tour
  label (`recap_tours.label`), and a winter ride never takes a summer/RZR/UTV/ATV photo or a Jun–Sep folder. No match = no
  photo; there is no "any image" fallback.
- **Add a loop map:** export the map as a 1080×660 PNG (SVG is stripped by Gmail), upload it to Storage bucket `recap-maps`
  as `<tour-slug>.png` (e.g. `first-tracks.png`), and put its public URL in `recap_tours.map_url` for that loop's row(s).
  The Grand Tour map is `docs/maps/rea-grand-tour-map.png` → `recap-maps/grand-tour.png`.

**Hidden-when-missing rules (simple):**

| Block | Shown only when |
|---|---|
| Hero photo + "Your photos are ready" | the Apps Script found and uploaded a strict-match photo |
| Route map hero | REA tour, no photo, and `recap_tours.map_url` is set |
| Stat line | at least 2 of: miles (`recap_tours.miles`), high point (`high_point_ft`), hours (booking start/end) |
| "Next storm: ~N″ Day" | CSR recap and a live Open-Meteo forecast (fetched that day) shows ≥3″ in the next 7 days; else "Ready for your next ride?" |
| Bring a friend | `share` in `features` |
| Gear from your ride | `merch` in `features` |
| Guest's first name | a real-looking first name on the booking; else "Thanks for riding with us." |

Never shown: "Ride #N" (no booking-history source yet), snow depth / % of normal (no confirmed live station source yet),
emoji (a test fails on any character above U+FFFF).
