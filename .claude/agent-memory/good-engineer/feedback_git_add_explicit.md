---
name: feedback-git-add-explicit-paths
description: Never use `git add -A` / `git add .` in this repo — stage explicit file paths only. The exFAT volume spawns ._ AppleDouble files that -A will commit.
metadata:
  type: feedback
---

**Rule:** In this repo, NEVER suggest or run `git add -A` or `git add .`. Always `git add <explicit paths>` — only the exact files the task changed. When handing the user a commit command, list the specific files, not a wildcard.

**Why:** This project lives on an exFAT volume (`/Volumes/CORSAIR/...`) that creates a `._<name>` AppleDouble sidecar for nearly every file/dir. On 2026-07-04 I handed the user `git add -A && git commit ...`; they ran it and it committed **105 `._` junk files** alongside 6 real ones. The user was furious ("You're only supposed to commit code"). I *knew* about the exFAT ._ problem and used -A anyway — inexcusable.

**How to apply:**
- Staging: explicit paths only. e.g. `git add app/api/foo/route.ts components/Bar.tsx`.
- `._*` is now in `.gitignore` (added same day), so `-A` is less catastrophic — but still don't use it; belt and suspenders.
- Before suggesting any commit, sanity-check the staged set has no `._` entries: `git diff --cached --name-only | grep '\._'` should be empty.
- If a commit already contains ._ junk and is unpushed, fix with `git reset --soft HEAD~1` → `git reset` → `git add <real files>` → re-commit. Verify with `git show --name-only --format="" HEAD | grep '\._'`.
- Note: `.git/objects/pack/._pack-*.idx` sidecars make git print harmless "non-monotonic index" errors on most commands here — noise, not failure.
