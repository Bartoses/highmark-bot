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

## Verify
- `clasp pull` after the push and confirm there's no diff (the push landed exactly).
- In the editor: run `checkConnection` (should say connected); Triggers page shows `drainQueue` every 10 min.
- A test that is safe any time: nothing is queued → `drainQueue` sends nothing and logs nothing.
