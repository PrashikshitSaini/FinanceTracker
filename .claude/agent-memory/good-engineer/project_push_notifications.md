---
name: project-push-notifications
description: How PWA web-push spending alerts work (AIBubble-style infra), the platform constraints that shaped it, and required env/migration. Read before touching push, the service worker, or the daily cron.
metadata:
  type: project
---

Web Push "spending alerts" for the installed PWA. Added 2026-07-06 for an **Android** user who wanted always-on, low-battery, glanceable spend.

**Pieces:** `public/sw.js` (push + notificationclick handlers), `lib/push.ts` (server web-push helper), `app/api/push/{subscribe,test,send-daily}/route.ts`, `components/NotificationSettings.tsx` (subscribe UI in header menu), `components/PushBadgeSync.tsx` (clears badge on focus), `components/SpendReveal.tsx` (in-app count-up), `vercel.json` (daily cron), `docs/sql/2026-07-06-push-subscriptions.sql` (`push_subscriptions` table + RLS).

**Verified platform constraints (web-searched 2026-07-06 — do NOT re-assert from memory):**
- **A truly always-on / non-dismissable / animated notification is NOT possible on web/PWA.** That's native-only (Android foreground service / iOS Live Activity). `requireInteraction` is *ignored by Chrome on Android*.
- **Notifications can't be animated** — OS-rendered (icon/title/body/one image/actions). The "cool animation" is therefore the in-app `SpendReveal` count-up, triggered when the SW opens `/?from=push&spent=NNN`.
- **App-icon badge:** iOS installed-PWA (16.4+) shows the actual number; **Android Chrome shows only a dot** (setAppBadge unsupported → the `'setAppBadge' in navigator` check no-ops). So the real spend number lives in the **push text**, badge is just a "something new" dot.
- **iOS web push** requires the PWA be added to Home Screen; not available in the EU.

**Invariants a future edit must keep:**
- Daily summary uses a **stable tag `finance-daily-summary` + renotify** so each day replaces yesterday's in the tray ("standing" notification) instead of stacking.
- `send-daily` is **cron-only**, auth'd by `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this automatically when CRON_SECRET is set). It reads across users via the **service role** (scoped by explicit `user_id`); everything else uses the RLS cookie client.
- Dead endpoints (push send returns 404/410 → `gone`) are pruned one-by-one with `endpoint=eq.` — do NOT rebuild a PostgREST `in.(...)` list from raw endpoint URLs (they contain delimiters; encoding the whole list breaks it — this was a caught bug).
- **Amount is formatted USD server-side** (`send-daily`) and in `SpendReveal`. Known v1 limitation: the app is multi-currency (client-side) but the server doesn't persist the user's currency. For multi-currency, store currency in user metadata and format per user.

**Required setup (env NOT in repo — `.env` is gitignored; also set in Vercel before deploy):**
`VAPID_PUBLIC_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (same value, inlined at BUILD time), `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:/https:), `CRON_SECRET`. Plus the existing `SUPABASE_SERVICE_ROLE_KEY`. The SQL migration must be run in Supabase. Cron runs on deployed Vercel only (not localhost); schedule is 13:00 UTC daily.
