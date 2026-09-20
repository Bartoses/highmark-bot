# Sending email + text from Google Apps Script

`Code.gs` in this folder replaces your old `Real Send.gs` / `Test Email Send.gs`. The spreadsheet is no longer
the list — the Highmark database is. Apps Script just says *what* to send and *to which segment*.

## Why this is better than Gmail + a sheet
| Old (GmailApp + Sheet) | New (Highmark API + Resend) |
|---|---|
| Gmail caps you at ~100 (personal) / 1,500 (Workspace) recipients a day and can suspend accounts that bulk-send | Purpose-built sending service, batches of 100, no daily Gmail cap |
| "Sent" tracked by typing into a column | Every recipient has a row: queued → sent → delivered / bounced / complained |
| Unsubscribes live in a separate sheet nobody's code checks reliably | One database; unsubscribe, bounce and spam-complaint are enforced **on every send, server-side** |
| Bounces are invisible — you keep mailing dead addresses (hurts deliverability) | Hard bounces and complaints auto-suppress the address |
| No proof anyone opted in | Every contact records *where and when* it consented |
| Re-running the script can double-send | Idempotency key: a re-run returns the original result |
| Script times out after ~6 min | Sending happens on the server; the script returns instantly |

## Setup (about 10 minutes, once)

**1. Resend (email provider — already connected).**
- Resend dashboard → *Domains* → add & verify `coloradosledrentals.com` (add the DNS records it shows).
  Then set `RESEND_FROM_EMAIL` in Railway to `Colorado Sled Rentals <info@coloradosledrentals.com>`.
  (Until then mail goes out from the shared `usehighmark.com` address.)
- Resend dashboard → *Webhooks* → add endpoint `https://highmark-bot-production.up.railway.app/webhooks/resend`,
  events: `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. Copy its **Signing secret**.

**2. Railway variables** (both the web service and `highmark-cron` unless noted):
| Variable | Value |
|---|---|
| `OUTBOUND_API_KEY` *(web)* | a long random secret — generate with `openssl rand -hex 32` |
| `RESEND_WEBHOOK_SECRET` *(web)* | the signing secret from step 1 (starts `whsec_`) |
| `MAILING_ADDRESS` *(web + cron)* | your business's physical postal address — **legally required in every marketing email (CAN-SPAM)**; sends are refused without it |
| `RESEND_FROM_EMAIL` | see step 1 |

**3. Apps Script.** Paste `Code.gs` into your project; in *Project Settings → Script properties* add
`HIGHMARK_API_URL` = `https://highmark-bot-production.up.railway.app/api/v1` and `HIGHMARK_API_KEY` = the key from step 2.
Run `checkConnection()` and approve the permission prompt. Remove any hand-made unsubscribe link from `index_3.html`.

## Safety rails you get for free
- **Dry run by default.** Every send endpoint does nothing unless you pass `dry_run: false`.
- **Explicit consent only** unless a segment deliberately sets `include_grandfathered: true` (email) / `include_assumed_sms: true` (text).
- **Typos can't widen a send** — unknown segment fields are rejected.
- **`expected_recipients` tripwire** — refuses if the audience is far bigger than the preview you approved.
- **Quiet hours** — marketing texts are refused before 8 am / after 9 pm Mountain.
- **Booking email/text** goes only to that booking's own guest (you can't supply an address); it ignores a marketing unsubscribe but never a STOP, bounce or complaint.

## API reference
All requests: `Authorization: Bearer <OUTBOUND_API_KEY>`, JSON bodies. Full docs in the header of `outboundApi.js`.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | connection + configuration check |
| `POST /api/v1/email/audience` `{segment}` | who would receive it, and why others are excluded |
| `POST /api/v1/email/send` `{subject, html, segment, dry_run:false, idempotency_key}` | newsletter / promo. `test_to` sends one test copy |
| `GET /api/v1/email/campaigns/:id` | delivery counts |
| `POST /api/v1/email/transactional` `{booking_pk, subject, html, dry_run:false, idempotency_key}` | booking email |
| `POST /api/v1/sms/audience`, `/sms/send`, `/sms/transactional` | same shapes for text |

Segment fields: `tags_any`, `tags_all`, `exclude_tags`, `sources`, `min_bookings`, `active_since`,
`include_grandfathered`, `include_assumed_sms`. Useful tags: `waiver`, `trailer_rental`, `avalanche_gear`, `booked`,
`fareharbor`, `csr`, `rea`, `rzr`.

Merge fields (subject + body): `{{first_name}}`, `{{last_name}}`, `{{business_name}}`; booking sends also get
`{{activity}}`, `{{trip_date}}`, `{{trip_time}}`, `{{booking_pk}}`.
