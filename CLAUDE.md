# Highmark Bot — Project Instructions

## What This Is
Summit is an AI SMS concierge built by Whiteout Solutions as a POC to demo to Steamboat Springs outdoor businesses (tour operators, lodges, activity companies) what an AI-powered guest texting service can do. Stack: Twilio + Claude API + Node.js/Express, deployed on Railway.

## After Every Change
1. **Test locally** — run the test suite (see Testing below) and verify all scenarios pass
2. **Deploy** — commit and push to GitHub; Railway auto-deploys from `main`
3. **End-to-end verify** — hit the Railway health check URL to confirm the new deploy is live

## Per-Client Variables
Search `CLIENT_CONFIG` in `index.js` to find every value that changes when onboarding a new business:
- `BUSINESS_NAME` — the client's business name
- `BOOKING_LINK` — their actual booking URL
- `BOT_SERVICES` — short description of what they offer (used in system prompt)

## Testing (Free — No Twilio Costs)

### Setup (one-time)
```bash
npm install
```

### Run Tests
**Terminal 1 — start server in test mode:**
```bash
npm run dev:test
```

**Terminal 2 — interactive chat simulator:**
```bash
npm test
```
Simulator commands: `/reset` (fresh conversation), `/quit`

### Automated curl tests
With server running (`npm run dev:test`), run individual scenarios:

```bash
# Health check
curl http://localhost:3000/

# First message (should return hardcoded Summit greeting)
curl -s -X POST http://localhost:3000/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=Hey&From=%2B15550001234&To=%2B15559999999"

# Reset conversation
curl -s -X POST http://localhost:3000/reset \
  -H "Content-Type: application/json" \
  -d '{"from":"+15550001234"}'
```

### Key test scenarios to verify after every change
1. **Greeting** — fresh number gets exact hardcoded greeting (96 chars)
2. **Conditions question** — follow-up reply stays under 160 chars
3. **Booking flow** — "I want to book" → ask activity → ask date/group → confirm + link
4. **Handoff** — "I want to speak to a person" (after greeting) returns handoff message with BUSINESS_NAME
5. **Reset** — `/reset` endpoint clears conversation and greeting fires again

## Deployment
Railway is connected to the `main` branch on GitHub. Push to deploy:
```bash
git add index.js          # stage only what changed (never commit .env)
git commit -m "your message"
git push origin main
```
Railway URL: https://highmark-bot-production.up.railway.app
Health check: `curl https://highmark-bot-production.up.railway.app/`

## Architecture Notes

### Conversation Store
In-memory keyed by phone number. Shape:
```js
{
  messages:    [{ role, content, timestamp, intent, sentiment }],
  bookingStep: null | "ask_activity" | "ask_date_group" | "confirm" | "followup_sent",
  bookingData: { activity, date, groupSize },
  handoff:     false
}
```
TODO: migrate to Supabase for persistence across Railway restarts.

### TEST_MODE
When `TEST_MODE=true`:
- Twilio sends are skipped entirely
- `/sms` returns `{ reply: "..." }` JSON instead of TwiML
- `/reset` endpoint becomes available

### Booking Follow-up
30-minute follow-up uses `setTimeout`. This does NOT survive Railway restarts.
TODO: replace with Supabase-backed scheduled job before production.

### Message Length
Enforced via system prompt (320 chars for first reply, 160 for follow-ups). The test CLI prints char count and estimated text count on every reply so you can spot regressions.
