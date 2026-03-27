# Highmark Bot — Session Starter Prompts

Copy one of these at the start of a new Claude Code session to get full context fast.

---

## General session start
```
Read CLAUDE.md, README.md, and the memory files in ~/.claude/projects/-Users-sbartosewcz-Desktop-highmark-bot/memory/ to get full context on the Highmark project. Tell me what the current state is and what's in the roadmap before we start.
```

---

## Starting a new feature
```
Read CLAUDE.md and the memory files. I want to add [FEATURE]. Before writing any code:
1. Tell me which files will be affected
2. Check if there are any DB schema changes needed
3. Confirm the test plan
Then implement it, write tests, deploy, run the health check, and update the docs.
```

---

## Debugging a live issue
```
Read CLAUDE.md. Something is wrong in production: [DESCRIBE ISSUE].
Check the Railway health check first, then read the relevant code sections.
Walk me through what you find before making any changes.
```

---

## Onboarding a new client
```
Read CLAUDE.md — specifically the Per-Client Variables and Architecture sections.
I want to onboard a new client: [CLIENT NAME], [BUSINESS TYPE], [TWILIO NUMBER].
Walk me through every step needed and confirm each env var value before we deploy.
```

---

## Demo prep
```
Read CLAUDE.md — the Demo Checklist section. Walk me through the full demo verification:
1. Run the Railway health check
2. Run virtual-test.sh scenario 9 (DEMO trigger)
3. Run virtual-test.sh scenario 3 (booking flow)
Tell me if anything looks off.
```

---

## General code review / cleanup
```
Read CLAUDE.md and these files: [LIST FILES].
Review for bugs, edge cases, or anything that could cause issues in production.
Don't refactor unless something is actually broken or risky.
```

---

## After a Railway restart / incident
```
Read CLAUDE.md. Railway may have restarted. Check:
1. Health check at https://highmark-bot-production.up.railway.app/
2. Whether any in-flight setTimeout follow-ups were lost (known limitation)
3. Whether the knowledge base needs a refresh
Tell me the current state.
```

---

## Admin / lead management session start
```
Read CLAUDE.md — specifically the "Admin Lead Management" section.
I want to work on [admin task]. Before writing any code:
1. Confirm which routes are already implemented (/admin/leads, /admin/leads/:id, /admin/leads/summary)
2. Confirm the migration status (db1_lead_mgmt.sql must be run for updated_by + status constraint)
3. Confirm the test plan
```

---

## Standing rules (remind Claude every session if needed)
```
Reminder of our workflow rules for this project:
- Always write tests before committing
- Always run the full test suite before deploying
- Always deploy and run the Railway health check after every change
- Always update CLAUDE.md, README.md, and memory files after changes
- Never commit .env
```
