# Sprint: Ride Recap emails (CSR + Rabbit Ears Adventures)

## Read First

This sprint file is standalone. Read these before writing any code:

1. **This repo (highmark-bot).** Find and read:
   - The email pipeline behind `/email/transactional`, `/email/pull`, `/email/bounces`, `/email/report` and `/email/audience`. Recaps must go through this existing queue rather than a new sender.
   - How client accounts are configured. CSR/REA is an existing client (FareHarbor Pro operator).
   - `test.js` and how `TEST_MODE=true` blocks real sends.
2. **Supabase project `aiiguzslqiemksrvfvwk` (CSR/REA CRM).** List the tables and read the schema of the bookings table that the csr-webhook service (FastAPI on Railway, repo `Bartoses/csr-webhook`) fills from FareHarbor webhooks. Confirm the column names for: booking id, company (CSR vs REA), item name, start time, end time, status/cancelled, contact name, email, phone, pax, guide name (if any), the FareHarbor `ref` value, the discount code used (if any), and the email opt-in ("Subscribed to Email?"). Don't guess. If a field doesn't exist, note it in the summary and design around it.
3. **Apps Script project "CSR Emails"** (script id `1IeZ8Qp-bFhWMV4FEefyz7db6Bto6EXCVDo4Eg_YKOVNXoRaWPeOWoK10`, owned by sean@coloradosledrentals.com). `Higmark.gs` drains the bot's email queue and sends through Gmail as `info@coloradosledrentals.com` (sender name "Colorado Sled Rentals"). Use `clasp` to pull it locally if it's available; otherwise ask Sean to paste the drain function.
4. **Reference files Sean will attach:**
   - `RideRecap.gs`: a working draft of the full email HTML (table-based, mobile-first), the missing-data rules and every link. Port the HTML builder and the rules; don't port its Supabase/Gmail plumbing.
   - Design mockups: https://claude.ai/artifact/1fU5725XrGC83AQwLkCueN. Six phone-width emails (3 types × full / missing data), plus the share page, story image and framed print.

## Goal

Every guest who finishes a tour or rental gets a branded "Ride Recap" email the same evening, with no manual work. The email drives four things, in order of value: a **Google review**, a **referral** (FRIEND10), **repeat bookings**, and **take-home sales** (framed prints, merch). Every link is tracked so Sean can see which emails and buttons produce reviews and bookings.

## Success Criteria

- A daily job (default 6:00 pm America/Denver, changeable from settings without a deploy) queues one recap per eligible booking.
- The emails are the three types in the mockups, Rabbit Ears tour, CSR guided backcountry and CSR rental, each branded correctly (REA = dark / cyan `#00B4E6` / orange `#F99E16` buttons / Bebas Neue; CSR = navy `#06121F` / blue `#1670C2` buttons / gold `#D9A24E` / Roboto).
- An email with missing data still looks finished (rules below). No "undefined", empty boxes or broken images, ever.
- No guest gets a recap twice, and nobody who unsubscribed gets one.
- A dry-run mode sends every recap to sean@coloradosledrentals.com instead of the guest. **Launch in dry-run.**
- Every link carries tracking (spec below).
- All existing tests pass, and the new tests below pass.

## Current Problem

There's no follow-up after a ride. Reviews, referrals and repeat bookings depend on guests remembering. The booking data already flows into Supabase, and the bot already has a Gmail-backed transactional email queue, but nothing connects "ride finished" to "send a great follow-up".

## Core Requirements

### 1. Config, stored in Supabase so Sean can edit it without a deploy
- `recap_settings` (one row per client): `send_hour` (default 18), `timezone` (`America/Denver`), `dry_run` (default **true**), `test_to` (`sean@coloradosledrentals.com`), `features` (text[]: `review, share, prints, merch, newsletter`; merch launch is undecided, so it must be removable), `friend_code` (`FRIEND10`), `friend_percent` (10), `reward_code` (null until Sean decides, see §7), `weather_lat` / `weather_lon` (trailhead, TBD).
- `recap_tours`: maps FareHarbor item names to a template and stats. Columns: `match` (substring of the item name), `type` (`rea` | `backcountry` | `rental`), `label`, `miles`, `high_point_ft`, `stops` (text[]), `active`. Seed it with:
  - REA: `Grand Tour`, `First Tracks`, `Tree Line`, `Sunset Ride`, `Rabbit Ears`, `On-Trail Guided` → type `rea` (miles, high point and stops are blank for now; Sean will fill them in).
  - `Backcountry` → `backcountry`.
  - `Polaris` (sled rentals) → `rental`.
  - Anything unmatched (Fuel, Trailer, gear, RZR) gets **no** email.

### 2. Eligibility (daily job)
- Bookings whose end time falls between the start of today and now (client timezone), not cancelled, with an item matching an active `recap_tours` row.
- One email per booking id. Ignore duplicate line items, and respect the `rebooked_from` handling already in the data.
- Skip: no or invalid email; on the unsubscribe list (reuse the bot's existing audience/unsubscribe source and the "Unsubscribe" sheet logic); already logged in `recap_log`.
- Opt-in: few guests have the FareHarbor "Subscribed to Email?" flag set (about 3% CSR, about 11% REA). Recaps go to **everyone not unsubscribed** as a post-purchase thank-you. Every email has a working unsubscribe link and the physical address in the footer.
- Write `recap_log` (booking_id, email, type, queued_at, dry_run, photo, weather) and `recap_review` (booking_id, reason) for anything skipped for a data problem.

### 3. Content and missing-data rules

| Data missing | Behavior |
|---|---|
| First name (or junk like "Guest", initials) | Generic headline ("Thanks for riding with us.") |
| Guide name | Drop the "with guide X" phrase |
| Photo | No hero photo and no print offer |
| Tour miles, high point or stops | Those stat tiles and stops are omitted. Always show at least hours (from start/end) and riders (pax). |
| Weather | Hide the weather labels |
| Miles on merch | Merch line falls back to tour + date |

Section order (all types): header logo → hero (kicker, headline, subline, photo) → stats (2×2) → stops (REA only) → weather labels → **review card** → **share/referral card** → take it home (prints if photo, merch if enabled) → next-ride card → newsletter → footer.

- **Review card:** the "Leave a Google review" button **plus** "Something not right? Tell us directly" (mailto info@), shown to **every** guest. Never show the review link only to happy guests; Google forbids that ("review gating").
  - CSR review link: `https://g.page/r/CfQGQSBK_KsOEAE/review`
  - REA review link: `https://g.page/r/CfQGQSBK_KsOEAg/review` (Sean to confirm which is which)
- **Share card:** "Give 10%, get 10%". The code FRIEND10 sits in a dashed box, with two buttons: "Text it to a friend" (`sms:?&body=…`) and "Email it to a friend" (`mailto:?subject=…&body=…`). Both prefilled messages include the code and a booking link carrying `ref=friend-<booking_id>`.
- **Next ride:** REA → "Come back for sunset" (Sunset Ride); backcountry → "Chase the next storm"; rental → "Want a guide next time?" (guided page).
- **Newsletter:** `https://coloradosledrentals.com/newsletter-signup/`
- **Footer:** REA → "Rabbit Ears Adventures · 4492 Hwy 14, Walden, CO 80480 · A Colorado Sled Rentals company". CSR → "Colorado Sled Rentals · 2151 Downhill Drive, Steamboat Springs, CO 80487". Both include (970) 439-1707, @coloradosledrentals and an unsubscribe link.
- **HTML must be email-safe:** tables, inline styles, no flex/grid, max-width 600, readable at 375 px. Port the builder from `RideRecap.gs`. Also send a plain-text version.
- **Subject lines:** "Your Rabbit Ears tour recap, {First}" / "Your backcountry day, recapped" / "Thanks for riding with CSR". Drop ", {First}" when there's no name.

### 4. Links and tracking
- FareHarbor booking links must carry `ref=followupemail&full-items=yes`:
  - REA: `https://fareharbor.com/embeds/book/rabbitearsadventures/?ref=followupemail&full-items=yes&flow=1491038`
  - CSR guided: `https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes&flow=1262220`
  - CSR general: `https://fareharbor.com/embeds/book/coloradosledrentals/?ref=followupemail&full-items=yes`
- Every link also gets `utm_source=ride_recap&utm_medium=email&utm_campaign=<type>&utm_content=<button>`.
- Referral links shared by guests use `ref=friend-<booking_id>` instead of `followupemail`.

### 5. Photos (Google Drive)
- Guides drop photos into a shared Drive folder: `Tour Photos/YYYY-MM-DD/` with file names that include the tour label (e.g. `Grand Tour 11am.jpg`).
- The bot can't read Drive directly, so the bot marks the photo slot in the HTML (e.g. `<!--PHOTO_SLOT-->`) and sends `photo_hint: {date, label}` with the queued email. The Apps Script drain looks the photo up with `DriveApp`, swaps the slot for an inline `cid:` image, or removes the slot if nothing is found. Add that small change to `Higmark.gs`'s drain and keep it backward-compatible with other email types.
- The framed on-site print is "2 for $25". The email offers a digital copy and more prints only when a photo exists.

### 6. Weather
- Open-Meteo (free, no key) daily values for the trailhead: snowfall, max temp, weather code → labels (SNOW, HIGH, SKY). If the call fails, hide the labels; never block the send.

### 7. Referral reward (phase 2; build the hook, ship it disabled)
- Daily: find new bookings whose `ref` starts with `friend-`. Map back to the referring booking and its email, and queue a short "Your friend booked! Here's 10% off your next ride" email with `reward_code`.
- Only run when `reward_code` is set (Sean is deciding, e.g. a separate code like THANKS10). One reward per referring guest per season.

### 8. Safety
- `TEST_MODE=true` must block real sends, as everywhere else in the repo.
- `dry_run=true` sends everything to `test_to`, with "[TEST]" at the front of the subject.
- No secrets in code. Use env vars for the Supabase key. Sean must create a **new** Supabase secret key for this and rotate the Highmark API key that appeared in a screenshot.

## Automated Tests

1. Item mapping: Grand Tour → rea; Backcountry → backcountry; Polaris 850 → rental; Fuel / Trailer / RZR → skipped.
2. Eligibility: cancelled → skipped; missing email → `recap_review`; unsubscribed → skipped; already in `recap_log` → skipped; two line items on one booking → one email.
3. Missing data: no name → generic headline; no guide → phrase removed; no photo → no photo slot and no print offer; no tour stats → hours and riders tiles still render; weather failure → labels hidden. The rendered HTML never contains "undefined", "null" or empty `<img src="">`.
4. Links: every `<a href>` in every template has the UTM params; FareHarbor links have `ref=followupemail&full-items=yes`; share links have `ref=friend-<id>`; the review link matches the brand.
5. Review card: the review button and the "Tell us directly" link both appear in every rendered email.
6. Settings: changing `send_hour` reschedules the job; `features` without `merch` removes the merch section; `dry_run` reroutes to `test_to`.
7. Referral hook: with `reward_code` null nothing is queued; with it set, a `friend-123` booking queues one reward for booking 123's email, and only one per season.
8. Snapshot tests: one full-data and one missing-data render for each of the 3 types (6 snapshots).
9. `node test.js`: all existing ~1,600 tests still pass.

## Definition of Done

- Migrations for `recap_settings`, `recap_tours` (seeded), `recap_log` and `recap_review` are applied.
- The daily recap job is live in **dry-run**. Sean receives a test batch and the six snapshot renders look right in Gmail on a phone.
- `Higmark.gs` drain handles `photo_hint` with no regression for other email types.
- The referral reward hook is built, tested and disabled.
- A short README section covers how to edit tours and settings, turn off dry-run, and read `recap_log` / `recap_review`.
- Open items are listed for Sean: loop miles, high points and stops; trailhead coordinates; confirming which review link is which; the reward code; merch go/no-go.
