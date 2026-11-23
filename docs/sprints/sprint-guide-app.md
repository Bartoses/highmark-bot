# Sprint: Guide Ride Log app (photos, videos, ride details, rider notes)

Draft 2, 2026-11-23, written with Sean. Decisions marked **(Sean)** came from him; everything else is a proposal to confirm.

## Read first

1. `Roadmap` → "Guide Ride Log" (the original idea) and "Ride Recap v2 — simple template".
2. What already exists and must be reused, not rebuilt:
   - **Ride Recap** (`rideRecap.js`, `recapSimple.js`): the simple template is live (dry run). It already takes a
     `rideLog` in `buildTripDetails` (guide, stops, miles, high point, highlight, photo) and shows only what exists.
   - **Hosted photos**: Supabase Storage bucket `recap-photos`, resize with `sharp` (`processRidePhoto`), signed
     `/r/photos` page (photo + loop map, Save or share), share story on `/r/share`.
   - **`ride_media`** (DB2, applied): one row per file, keyed by FareHarbor departure `availability_pk` + optional
     `booking_pks`. `pickRideMediaForBooking` already picks the right photo per booking.
   - **Guides are operator phones** (DB1 `operator_phones`, role `guide` etc.) and already get a morning SMS briefing.
   - **Portal** (`public/portal.html`, Supabase Auth) for managers.
3. Run `npm run test:cloud` and write down the baseline.

## Goal

Every recap shows the real ride (the group's photo, the route actually taken, a highlight from the guide) the same
evening, with no file naming and no Apps Script photo step. And the CRM learns about each rider.

## Decisions

| Topic | Decision |
|---|---|
| Photo storage | **(Sean)** Upload straight to Supabase Storage (instant for recaps), then copy each file into the Drive "Tour Photos" folder for social. |
| Which ride is mine | **(Sean)** A manager can assign guides to departures in the portal, a guide can claim an unassigned ride in the app, and if FareHarbor starts filling a guide/staff field on the booking we read it first. |
| Getting in | **(Sean)** Both: a signed link in the morning briefing text (no password) and a portal page for managers. |
| Who gets the link | **(Sean)** Guides, ops/general managers, shop/reservations staff, owner. |
| v1 scope | **(Sean)** Photos (cover + extras), ride stats + highlight, rider notes for the CRM, videos. |
| Recap timing | **(Sean)** Recaps still go at the evening send hour (`recap_settings.send_hour`, 6 pm). Whatever is logged by then is used; after that it sends with what exists. |
| Rider tags | **(Sean)** Skill level, upsell interest, celebration/VIP, issue/follow-up (the issue tag alerts a manager). Private, never shown to guests. |
| Photo permission | **(Sean)** The Smartwaiver release covers email and social use. |
| Videos | **(Sean)** Shown to the guest on their photos page (play + download) and copied to Drive for social. |
| Rentals | **(Sean)** Shop staff add photos and rider tags for rental bookings at pick-up or return, in the same app. |
| Ride stats | **(Sean)** Each loop has default miles + high point in `recap_tours` (fill once); the guide only edits them if the ride differed. |

## Core requirements

### A. Getting in (auth)

1. **Briefing link.** The morning briefing to each recipient above gets one extra line: `Log today's rides: <link>`.
   The link is signed (HMAC) for that operator phone + that local date, expires at 3 am the next day, and opens
   `/guide` with no password. A lost link can be re-sent by texting `LOG` to the bot (operator phones only).
2. **Portal.** A "Ride Log" section in the portal (managers: client_admin+) shows the same screens for any staff
   member, plus the assignment board (C3).
3. Roles: guide = their own rides + unassigned rides; shop/reservations = today's rentals + unassigned rides;
   managers/owner = everything. Nobody sees guest emails or phone numbers in the app (first names only).

### B. Today screen

1. Today's departures from DB2 `bookings` (FareHarbor rows only), grouped by `availability_pk`: tour label, start time,
   riders count, first names, and who it's assigned to. A date switcher for yesterday (late logging).
2. Filters by role (A3). Rentals appear as their own cards (one per order) for shop staff.
3. Each card shows status: not started / photos added / done.

### C. Assignment (which ride is mine)

1. Order of truth: FareHarbor guide field → manager assignment → guide claim. **(Sean)** The guide may be entered in
   either place on the departure, so read both: a custom field on the availability whose name contains "guide" or
   "staff" (`availability.custom_field_instances`), and the availability `headline`. Match the value to a staff
   member by name (case-insensitive, first name or full name, `operator_phones.display_name`); no confident match =
   ignore it and fall back to manager/claim. Show the source on the card ("from FareHarbor").
2. **Claim.** An unassigned departure has a "This is my ride" button. A departure split between guides: each guide
   ticks their riders (stored as `booking_pks`, so photos only reach those guests).
3. **Assignment board (portal).** Today's departures × guides; tap to assign. Assigned guides see it at the top.

### D. Photos and videos

1. Pick several from the camera roll or take new ones; star the cover. Converted on the phone to JPEG, longest edge
   1600 px (HEIC never uploaded). Videos up to 2 minutes / 200 MB.
2. Upload straight to Supabase Storage with retry/resume (weak signal at the ranch): photos to `recap-photos`, videos
   to a new `recap-videos` bucket (bigger size limit; resumable uploads). The server makes the hero/full/thumbnail set
   (`processRidePhoto`) as today.
3. Each file writes a `ride_media` row: `availability_pk`, `booking_pks` (if split), storage path + public URLs,
   `kind`, `cover`, `guide`. Add the storage columns to `ride_media` (migration).
4. **Recaps use the hosted photo directly.** At queue time the recap job finds the booking's photo in `ride_media`
   and fills `photo_hint.hosted_photo` itself, so the email has the photo with no Apps Script step. The Drive
   name-matching path stays as the fallback for photos dropped into Drive by hand.
5. **Drive copy.** A cron step copies new files to `Tour Photos/<date>/<Label> <time> - <Guide> - <NN>.<ext>` and
   stores the Drive file id. Needs a Google service account with Content manager access on the shared drive that
   holds Tour Photos (`GOOGLE_SERVICE_ACCOUNT_JSON` on Railway). Copy failures retry and never block a recap.
   **(Sean)** Tour Photos is in a shared drive: drive `0AJ8T1WA5ITQoUk9PVA`, folder `1QoyfkJfW2fNJDRabSC2c41JtusEhwGCL`.
   Drive API calls need `supportsAllDrives=true`. Until the service account exists, uploads still work; the Drive
   copy waits and catches up.
6. Videos show on the guest's `/r/photos` page (play + Save) and the email button reads "See photos & video".

### E. About the ride

1. Prefilled from the loop's `recap_tours` defaults (miles, high point, stops); the guide edits only what differed.
2. Optional: conditions (fresh snow, sky: one tap each), one highlight line ("moose at Rabbit Ears"), and a short
   note about the group. **(Sean)** The note is **internal only**, never in the recap; only the highlight is shown. Stored in `ride_logs` per departure (or per guide's riders when split).
3. These feed `buildTripDetails({ rideLog })`, so the recap's stat line, subline and stops are real. The guide's
   name fills "with guide Jake".

### F. About the riders (private)

1. Per rider (booking): chips for skill (first time / beginner / intermediate / advanced), upsell interest
   (backcountry / rental / another tour), celebration/VIP (birthday / anniversary / VIP / repeat), and
   issue/follow-up (complaint / injury / damage / call them) + an optional note.
2. Saved in `ride_log_riders`; tags are added to the guest's DB2 `contacts` row (by email/phone) for segments.
3. An **issue** tag texts **all managers** right away **(Sean)** (operator phones with role owner, general_manager or
   operations_manager) with the booking, tour and the note. Rider notes never appear in anything a guest sees (test enforced).

### G. Recap integration

1. The recap job (6 pm) reads `ride_logs` + `ride_media` for the day; whatever exists is used. Missing pieces keep
   today's hidden-when-missing rules.
2. A log saved after the recap went out does not resend it (one recap per guest). It still feeds the photos page and
   the CRM.

## Data (DB2, migration file for review)

- `ride_logs`: id, client_id, ride_date, availability_pk, booking_pks[] (empty = whole departure), guide (name +
  operator phone), miles, high_point_ft, stops[], conditions jsonb, highlight, group_note, status (open/done),
  timestamps. Unique per (availability_pk, guide).
- `ride_log_riders`: id, ride_log_id, booking_pk, tags[], note, issue boolean, created_by, timestamps.
- `ride_assignments`: availability_pk, ride_date, operator phone, assigned_by, source (fareharbor/manager/claim).
- `ride_media`: + storage_path, public_url, hero_url, thumb_urls, drive_copied_at, duration_s (videos).
- Storage: new public bucket `recap-videos` (video types only, larger limit).

## Automated tests

1. Signed link: right phone + date opens; expired, wrong phone or tampered link refused.
2. Role filters: a guide sees own + unassigned rides only; shop sees rentals; no emails/phones in any response.
3. Assignment order: FareHarbor field > manager > claim; split departure keeps photos to the ticked riders only.
4. Upload: HEIC refused or converted; photo set sizes; `ride_media` row written with the right keys; retry is idempotent.
5. Recap: a logged ride's recap has the hosted photo (no Apps Script step), the guide's highlight, edited stats;
   an unlogged ride looks exactly like today.
6. Rider notes and issue notes never appear in any guest-facing HTML or text.
7. Issue tag sends one manager alert (TEST_MODE: queued, not sent).
8. Drive copy: file named by the `rideMedia` contract; a failure retries and never blocks the recap.
9. Full suite: baseline count or higher, 0 failures.

## Definition of done

- `/guide` works on an iPhone at the ranch (slow network) for a guide, a shop staffer and a manager.
- Sean receives `[TEST]` recaps for a logged ride (photo + video + highlight) and an unlogged one, and OKs them.
- Migration applied after Sean reviews it; README + CLAUDE.md + Roadmap updated.

## Answered (2026-11-23)

- Tour Photos is in a shared drive (ids above). The service account still needs creating (steps in the setup note below).
- Issue alerts go to all managers. The guide's group note is internal. FareHarbor guide may be in either field: read both.

## Still open

1. Loop defaults in `recap_tours` (miles, high point, stops) for Grand Tour, First Tracks, Tree Line, Sunset Ride,
   Rabbit Ears Tour, On-Trail Guided and the backcountry routes. **(Sean: later.)** Until then the stat line shows
   only what guides enter.
2. Service account created and added to the shared drive (Sean, steps below).

## Setup: Google service account (Sean, ~10 minutes)

A service account is a Google "robot user" that the bot signs in as, so it can save files into the shared drive
without anyone's password. It only sees what it's added to.

1. Go to console.cloud.google.com signed in with your Workspace account. Create a project (e.g. "Highmark").
2. APIs & Services → Library → search "Google Drive API" → Enable.
3. IAM & Admin → Service Accounts → Create service account. Name it "highmark-photos". Skip the optional role steps.
4. Open it → Keys → Add key → Create new key → JSON. A file downloads. Keep it private.
   (If Google says key creation is disabled by policy, an organization admin must allow it under IAM → Organization
   policies → "Disable service account key creation".)
5. Copy the service account's email (ends in `.iam.gserviceaccount.com`). In Drive, open the shared drive →
   Manage members → add that email as **Content manager**. If Drive refuses an outside address, turn on the shared
   drive setting that allows people outside your organization, or ask the Workspace admin.
6. In Railway, on both `highmark-bot` and `highmark-cron`, add a variable `GOOGLE_SERVICE_ACCOUNT_JSON` and paste
   the whole contents of the JSON file. Never paste the key into chat or email.
