# Apps Script handoff: "CSR Emails" project (for a Claude Code session on Sean's Mac)

Script id `1IeZ8Qp-bFhWMV4FEefyz7db6Bto6EXCVDo4Eg_YKOVNXoRaWPeOWoK10`, a standalone script in a shared drive,
owned by sean@coloradosledrentals.com. Local clone: `~/code/csr-emails` (clasp + a git repo for rollback).

## Rule: improve, never break
- **`clasp push` replaces the WHOLE project with the local folder.** A file missing locally is DELETED from the project.
  So always `clasp pull` immediately before editing, never delete or rename local files unless asked, and
  `git diff --stat` before every push. The diff must show only the files you meant to change.
- Commit to the local git repo before and after every push, so `git checkout <commit> && clasp push` is a full rollback.
- Don't change behavior of the existing files (`real send 2`, `email`, `Phones`, `addnewslettertocontacts`,
  `addunsubscribefromform`, `GoogleUpload`, the `- OLD` files, `index_3.html`) except where listed below.
- Keep `Higmark.gs` byte-identical to `docs/apps-script/Code.gs` in the highmark-bot repo (it's the source of truth,
  is pure ASCII, and has tests).

## Change set 1 (2026-11-22)
1. **`Higmark.gs`** ← replace the whole file with `docs/apps-script/Code.gs` from highmark-bot, branch
   `claude/peaceful-franklin-0b2ch0` (or `main` once merged). Adds `drainQueue` (sends every queued Gmail row every
   10 min), Ride Recap photo slot / `photo_hint` / `from_name`, `photo` in send reports, and the merged menu.
   Emails without the new markers send exactly as before.
2. **`GoogleUpload.gs`**: rename `function onOpen() {` to `function addGoogleAdsMenu_() {`. Change nothing else.
   Two `onOpen()`s can't coexist; Higmark's `onOpen` now calls this helper so both menus build.
3. `git diff --stat` must show exactly these 2 files. Then `clasp push`, commit.
4. Sean runs **`setupQueueDrain`** once in the editor and approves the new Google Drive permission. Then run
   `checkConnection` to confirm the API still answers.
5. Optional: Project Settings → Script properties → `RECAP_PHOTO_FOLDER_ID` = the "Tour Photos" Drive folder id.

## Change set 2 (2026-11-22, later): safer photo matching
1. **`Higmark.gs`** ← replace the whole file again with the latest `docs/apps-script/Code.gs`. Only `hmFindPhoto_`
   changed, plus a new `hmPickPhotoName_` and `HM_EMAIL_IMAGE_TYPES`. It now uses `photo_hint.file_id` first, matches
   label **and** start time (two same-tour rides a day never swap photos), picks the `- 01` cover deterministically,
   and ignores HEIC, WebP and video.
2. `git diff --stat` must show only `Higmark.js`. Push, pull to verify, commit. No new permissions and no trigger changes.

## Change set 3 (2026-11-22, evening): shrink ride photos before attaching
1. **`Higmark.gs`** <- replace the whole file again with the latest `docs/apps-script/Code.gs` (branch `claude/recap-mobile-text`, or
   `main` once merged). New `hmEmailPhoto_`: the photo is sent as Drive's 1200px thumbnail (~200 KB) instead of the 3-5 MB original.
   iPhone Mail doesn't auto-download big attachments, so the full-size photo showed as a "download" placeholder that pushed the email
   out of shape. If resizing fails, photos over 1 MB are skipped (no broken email). Uses the Drive permission + UrlFetch the script
   already has; no new triggers.
2. `git diff --stat` must show only `Higmark.js`. Push, pull to verify, commit.

## Change set 4 (2026-11-22, night): strict photo matching + hosted photos for the simple template
Only after Sean OKs the PR (branch `claude/recap-v2-simple`).
1. **`Higmark.gs`** <- replace the whole file with the latest `docs/apps-script/Code.gs`. Changes: `hmPickPhotoName_` is strict
   (no "first word" fallback; a winter ride never takes a RZR/UTV/summer photo); `hmFindPhotoFile_` (new, returns the file + its
   day folder); `hmHostPhoto_` (new): for a simple-template recap (`photo_hint.hosted`) it uploads the photo to
   `POST /api/v1/recaps/photo` and sends the finished email the bot returns. v1 recaps work exactly as before. Uses only
   UrlFetch + Drive, which the script already has; no new triggers.
2. `git diff --stat` must show only `Higmark.js`. Push, pull to verify, commit.

## Verify
- `clasp pull` after the push and confirm there's no diff (the push landed exactly).
- In the editor: run `checkConnection` (should say connected); Triggers page shows `drainQueue` every 10 min.
- A test that is safe any time: nothing is queued → `drainQueue` sends nothing and logs nothing.
