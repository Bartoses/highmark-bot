# Highmark Bot — Deploy Guide

## What this is
AI-powered SMS concierge for outdoor businesses in Steamboat Springs.
Built by Whiteout Solutions.

---

## Deploy to Railway in 10 minutes

### Step 1 — Push to GitHub
1. Create a new repo on github.com (call it `highmark-bot`)
2. In your terminal:
```
git init
git add .
git commit -m "Initial Highmark bot"
git remote add origin https://github.com/YOURUSERNAME/highmark-bot.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to railway.app and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `highmark-bot` repo
4. Railway will detect Node.js and deploy automatically

### Step 3 — Add environment variables on Railway
In your Railway project → Settings → Variables, add:
```
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+18668906657
ANTHROPIC_API_KEY=your_anthropic_key
```

### Step 4 — Get your live URL
Railway gives you a URL like:
`https://highmark-bot-production.up.railway.app`

### Step 5 — Connect to Twilio
1. Go to Twilio → Phone Numbers → Active Numbers → your 866 number
2. Under Messaging Configuration
3. Set "A message comes in" → Webhook → your Railway URL + `/sms`
   Example: `https://highmark-bot-production.up.railway.app/sms`
4. Method: HTTP POST
5. Save

### Step 6 — Test it
Text "Hello" to +1 (866) 890-6657
You should get a response within 3-5 seconds.

---

## Customizing for a client

When you onboard a new client:
1. Buy them a new Twilio number ($1.15/mo)
2. Update the SYSTEM_PROMPT in index.js with their specific business info
3. Point their number's webhook to the same Railway URL
4. Or deploy a separate instance with their custom prompt

---

## File structure
```
highmark-bot/
├── index.js         ← bot logic + system prompt
├── package.json     ← dependencies
├── .env.example     ← environment variable template
├── .gitignore       ← keeps .env out of GitHub
└── README.md        ← this file
```

---

## Costs (monthly estimate)
- Railway hobby plan: $5/mo
- Twilio per message: ~$0.0079 sent + $0.0079 received
- Claude API: ~$0.003 per conversation
- At 500 conversations/mo: roughly $10-15 total running cost

---

Built by Whiteout Solutions · Steamboat Springs, CO
