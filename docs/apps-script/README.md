# Sending email + text from Google Apps Script

`Code.gs` in this folder replaces your old `Real Send.gs` / `Test Email Send.gs`. The Highmark database is now the list;
Gmail (as `info@coloradosledrentals.com`) is just the delivery truck.

## How it works
1. **Highmark decides** who may be emailed (opted in; never unsubscribed / bounced), writes each email with the legally-required
   footer (your address + a working unsubscribe link) and records what happened.
2. **Apps Script delivers** the messages through your Gmail, *as* `info@coloradosledrentals.com` (already a "Send mail as" address in
   your Gmail), then reports each result back. No DNS changes, no FareHarbor, no cost.
3. **Gmail's daily limit** (about 100 recipients/day on a free account, ~1,500 on Google Workspace) is respected automatically: a
   bigger list finishes over several days by itself, each morning, until done.

## Why this is better than the old Sheet flow
| Old (Sheet + GmailApp) | Now |
|---|---|
| The sheet is the list; "Sent" typed into a column | The database is the list; every recipient is tracked (queued → sent / failed / bounced) |
| Unsubscribes in a separate sheet nobody's code checked | Unsubscribe, bounce and never-opted-in are enforced on **every send**, server-side |
| Re-running can double-send | Idempotency key: a re-run never double-sends |
| No proof anyone opted in | Every contact records where and when it consented |
| Bounces invisible | `checkBounces()` reads Gmail's delivery-failure notices and stops emailing dead addresses |
| Times out after ~6 min | Sends a small batch at a time, resumes by itself |

## One-time setup (~5 minutes)
1. **Get the key:** Railway → `highmark-bot` service → **Variables** → click the eye on `OUTBOUND_API_KEY` → copy.
2. **Apps Script** → Project Settings (gear) → **Script properties** → add
   `HIGHMARK_API_URL` = `https://highmark-bot-production.up.railway.app/api/v1` and `HIGHMARK_API_KEY` = the key.
3. **Add the code:** Files **+** → Script → paste `Code.gs`. (Only one `onOpen()` is allowed per project — if you already have one,
   merge the menu lines into it.)
4. **Edit `index_3.html`:** delete the old hand-made unsubscribe link (the footer is added for you).
5. Run **`checkConnection()`** and approve the permission prompts. It tells you: connected ✓, Gmail can send as info@ ✓, and how many
   emails you can still send today.

## Sending a newsletter
Menu **Highmark → Preview newsletter audience** → **Send me a test** → **Send newsletter…**
Edit the `NEWSLETTER` block at the top of `Code.gs` first (change `id` for every new newsletter — it's the double-send guard).

## Safety rails
- **Dry run first**, and a confirmation shows the exact count and how long it will take.
- **Explicit consent only** unless `segment.include_grandfathered: true` is set deliberately.
- **Unknown segment fields are rejected** (a typo can't widen a send). `expected_recipients` refuses a surprise-sized audience.
- **Marketing sends are refused without a mailing address** (CAN-SPAM).
- The script refuses to send unless `info@…` is a real Gmail alias (it will never quietly send as someone else).
- **Booking emails** go only to that booking's own guest; they ignore a marketing unsubscribe but never a bounce or complaint.

## Deliverability (be honest with yourself)
Google isn't signing your domain's mail yet (no DKIM record for Google Workspace, and SPF doesn't list Google), so Gmail-sent
newsletters are more likely to land in spam than they should. It works, and it's what your old newsletters already did, but the day
someone with DNS access adds those records (Google Admin → Apps → Gmail → Authenticate email, plus an SPF include and DMARC), inbox
placement improves noticeably. The same DNS access would also let you send through Resend (`transport: "resend"`) with no daily cap.

## API reference
All requests: `Authorization: Bearer <OUTBOUND_API_KEY>`, JSON. Full docs in the header of `outboundApi.js`.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | connection + configuration check |
| `POST /email/audience` `{segment}` | who would receive it, and why others are excluded |
| `POST /email/send` `{subject, html, segment, transport:"gmail", dry_run:false, idempotency_key}` | queue a newsletter (transport `"resend"` sends from the server instead) |
| `POST /email/preview` `{subject, html}` | the fully rendered message, for a test to yourself |
| `POST /email/pull` `{campaign_id, limit}` | claim rendered messages to send with GmailApp |
| `POST /email/report` `{results:[{send_id, ok, error?, deferred?}]}` | report what was sent |
| `POST /email/bounces` `{emails:[…]}` | addresses that bounced → never emailed again |
| `GET /email/campaigns/:id` | delivery counts |
| `POST /email/transactional` `{booking_pk, subject, html, transport:"gmail", dry_run:false, idempotency_key}` | booking email (returns the rendered message to send) |
| `POST /sms/audience`, `/sms/send`, `/sms/transactional` | same shapes for text |

Segment fields: `tags_any`, `tags_all`, `exclude_tags`, `sources`, `min_bookings`, `active_since`, `include_grandfathered`,
`include_assumed_sms`. Useful tags: `waiver`, `trailer_rental`, `avalanche_gear`, `booked`, `fareharbor`, `csr`, `rea`, `rzr`.
Merge fields: `{{first_name}}`, `{{last_name}}`, `{{business_name}}`; booking sends also get `{{activity}}`, `{{trip_date}}`, `{{trip_time}}`, `{{booking_pk}}`.
