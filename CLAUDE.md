# Highmark Bot — Project Instructions

## What This Is
Summit is an AI SMS concierge built by Whiteout Solutions as a POC to demo to Steamboat Springs outdoor businesses (tour operators, lodges, activity companies) what an AI-powered guest texting service can do. Stack: Twilio + Claude API + Node.js/Express, deployed on Railway.

**Current client:** Colorado Sled Rentals + Rabbit Ears Adventures (CSR/REA)
**Live number:** +18668906657
**Railway URL:** https://highmark-bot-production.up.railway.app

---

## Rules — Follow These on Every Change
1. **Write tests** — add or update test cases covering the change
2. **Test locally** — run the full test suite and verify all scenarios pass
3. **Deploy** — commit and push to GitHub; Railway auto-deploys from `main`
4. **End-to-end verify** — run the Railway health check and confirm the deploy is live
5. **Update docs** — update CLAUDE.md, README.md, and memory files to reflect the change

---

## File Structure
```
index.js               — main Express server, SMS webhook, all bot logic, booking state machine
knowledgeBase.js       — FH items (24hr cron) + FH availability (3hr cron) + weather (1hr cron) + website (7-day cron, hash-gated)
bookingConfirmations.js — FareHarbor webhook receiver + 30min polling + confirmation texts
crm.js                 — contacts, campaigns, opt-out/opt-in (TCPA), auto-tagging
chat.js                — interactive terminal chat simulator (no Twilio cost)
test.js                — automated test suite (79 tests), spawns its own server on port 3099
virtual-test.sh        — Twilio Virtual Phone test runner (10 scenarios)
db1_schema.sql         — DB1 migration (Supabase Project 1 SQL editor)
db2_crm_schema.sql     — DB2 CRM schema (Supabase Project 2 SQL editor)
railway.json           — Railway deployment config
PROMPTS.md             — Session starter prompts
.env                   — local secrets (never commit)
```

---

## Per-Client Variables
Search `CLIENT_CONFIG` in `index.js` to find every value that changes when onboarding a new business.
Set these as Railway environment variables:
- `CLIENT_NAME` — business name shown in handoff messages
- `CLIENT_PHONE` / `HANDOFF_PHONE` — phone for human handoff
- `CLIENT_EMAIL` — contact email
- `CLIENT_ID` — short slug (e.g. `csr_rea`) used to key CRM records
- `FAREHARBOR_ENABLED` — `true` for Tier 2, `false` for Tier 1
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
Spawns its own server on port 3099. Runs all 79 scenarios automatically.

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
- Bot Twilio number (From): `+18668906657`
- Virtual Phone (acts as customer): `+18777804236`

Scenarios: 1=greeting, 2=snow conditions, 3=beginner booking, 4=experienced rider, 5=group of 8 handoff, 6=explicit handoff, 7=sentiment escalation, 8=reservation lookup, 9=DEMO trigger, 10=SUMMITDEMO

### Key scenarios to verify after every change
1. **Greeting** — fresh number gets the seasonal hardcoded opener
2. **Weather/forecast** — "snow forecast" returns live temps + 3-day forecast from LIVE DATA
3. **Booking menu** — "I want to book a tour" → numbered list of REA tours + CSR browse link
4. **Tour pick** — reply "2" → correct individual booking link sent
5. **No availability** — date with no slots → explicit message + browse-all links
6. **Same-day** — "can I book for today" → policy message + next available date
7. **Handoff** — "I want to speak to a person" returns handoff with CLIENT_NAME
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
6. Booking state machine steps
7. Handoff gate — blocks non-booking/conditions intents when `convo.handoff=true`
   - booking and conditions intents BYPASS the handoff gate (re-engage the guest)
8. Claude called with system prompt + KB context
9. Save conversation to Supabase, return TwiML

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
- Booking/conditions intents bypass handoff gate so re-engaging guests get real answers

### TEST_MODE
When `TEST_MODE=true` (local only, never set on Railway):
- Twilio sends are skipped entirely
- `/sms` returns `{ reply: "..." }` JSON instead of TwiML
- `/reset` endpoint becomes available

### Booking Follow-up
30-min follow-up uses `setTimeout` — does NOT survive Railway restarts.
TODO: replace with Supabase Edge Function before production.

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

### Knowledge Base Refresh (zero Claude tokens for FH + weather)
| Data | Cron | Method |
|---|---|---|
| FH items (catalog, pricing) | Daily at 2am | JS from FH API — no Claude |
| FH availability (slots) | Every 3hr | JS from FH minimal endpoint — no Claude |
| Weather | Every 1hr | JS from OpenWeather JSON — no Claude |
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

1. **Booking follow-up `setTimeout`** — replace with Supabase Edge Function (survives restarts)
2. **CRM campaign sending** — `/crm/campaigns/:id/send` logs sends but doesn't actually call Twilio yet
3. **Confirmations live test** — run real FareHarbor test booking, verify confirmation text arrives
4. **REA availability 403** — fixed (minimal endpoint), but verify with real REA API key in prod
