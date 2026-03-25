# Highmark Bot

AI-powered SMS concierge for outdoor businesses in Steamboat Springs.
Built by Whiteout Solutions.

**Live:** https://highmark-bot-production.up.railway.app
**Twilio number:** +18668906657

---

## Stack
- **Bot:** Node.js + Express on Railway (auto-deploy from GitHub `main`)
- **SMS:** Twilio
- **AI:** Claude (claude-sonnet-4-6) via Anthropic SDK
- **DB1:** Supabase — conversations + knowledge base
- **DB2:** Supabase CRM — contacts, campaigns, opt-outs
- **Bookings:** FareHarbor API (Tier 2 clients)

---

## File Structure
```
index.js                — Express server, SMS webhook, all bot logic
knowledgeBase.js        — FareHarbor + website scraper, KB caching
bookingConfirmations.js — FareHarbor webhook + confirmation texts
crm.js                  — contacts, campaigns, TCPA opt-out/opt-in
chat.js                 — local terminal chat simulator
test.js                 — automated test suite (port 3099)
virtual-test.sh         — Twilio Virtual Phone test runner
db1_schema.sql          — Supabase DB1 migration
db2_crm_schema.sql      — Supabase DB2 CRM migration
railway.json            — Railway config
```

---

## Local Development

```bash
npm install

# Interactive chat (no Twilio cost)
npm run chat

# Full automated test suite
npm test

# Server in test mode (for curl tests)
npm run dev:test
```

---

## Twilio Virtual Phone Testing

1. Make sure `TEST_MODE` is NOT set on Railway
2. Set webhook on `+18668906657` → `https://highmark-bot-production.up.railway.app/sms` (HTTP POST)
3. Run a scenario:

```bash
chmod +x virtual-test.sh
./virtual-test.sh        # menu
./virtual-test.sh 1      # new guest greeting
```

Watch replies appear in the Virtual Phone UI at console.twilio.com/us1/develop/sms/virtual-phone.

---

## Deploy to Railway (new instance)

### 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial Highmark bot"
git remote add origin https://github.com/YOURUSERNAME/highmark-bot.git
git push -u origin main
```

### 2 — Create Railway project
1. railway.app → New Project → Deploy from GitHub repo
2. Select `highmark-bot`

### 3 — Set environment variables on Railway
```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
CRM_SUPABASE_URL=
CRM_SUPABASE_KEY=
CLIENT_NAME=
CLIENT_PHONE=
HANDOFF_PHONE=
CLIENT_EMAIL=
CLIENT_ID=
FAREHARBOR_ENABLED=false
FAREHARBOR_APP_KEY=
FAREHARBOR_USER_KEY_CSR=
CONFIRMATIONS_ENABLED=false
CONFIRMATIONS_TEST_PHONE=
OPENWEATHER_API_KEY=
```

### 4 — Connect Twilio
Twilio Console → Phone Numbers → your number → Messaging:
- "A message comes in" → Webhook → `https://your-railway-url.up.railway.app/sms`
- Method: HTTP POST

### 5 — Health check
```bash
curl https://your-railway-url.up.railway.app/
```
Expected: `{"status":"Highmark running ✅", ...}`

---

## Onboarding a New Client

1. Buy a Twilio number ($1.15/mo)
2. Deploy a new Railway instance (or use multi-client Supabase table — see CLAUDE.md)
3. Set `CLIENT_CONFIG` env vars for the new business
4. Point the Twilio number webhook to the Railway URL
5. Run `virtual-test.sh 1` to verify the greeting

---

## Rate Limiting
- **IP:** 30 requests/min per IP
- **Phone:** 10 messages/min per phone number
- Both return valid TwiML 429 so Twilio doesn't retry

---

## Tier Model
| Tier | Price | Features |
|------|-------|----------|
| Tier 1 | $200-300/mo | Bot Q&A + booking links (`FAREHARBOR_ENABLED=false`) |
| Tier 2 | $400-500/mo | Real-time availability + live KB refresh (`FAREHARBOR_ENABLED=true`) |

---

## Running Costs (estimate)
- Railway: $5/mo
- Twilio: ~$0.0079/msg sent + received
- Claude API: ~$0.003/conversation
- At 500 conversations/mo: ~$10-15 total

---

Built by Whiteout Solutions · Steamboat Springs, CO
