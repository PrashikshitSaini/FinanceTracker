# Phone Setup — MacroDroid (Simple Version)

About **5 minutes**. One trigger, one HTTP action. No variables, no regex, no sub-macros.

The server does all the parsing — your phone just forwards the raw Wallet notification.

---

## Prerequisites

- Samsung Galaxy S25+ (or any Android 13+).
- **MacroDroid** installed from the Play Store (free version is fine).
- An API key from Finance Tracker — log in → API Keys → Create. Copy the `ftqa_...` value, you'll need it in step 3.

---

## Step 1 — Grant the two Android permissions

Both are in Settings → Apps → **MacroDroid**:

1. **Special access → Notification access → ON.** Without this, MacroDroid can't read Wallet's payment notifications.
2. **Battery → Unrestricted.** Without this, Android will freeze MacroDroid in the background and miss notifications.

> **Samsung One UI 8.5 note:** if you also have Samsung's "Modes and Routines" doing anything with notifications, disable those rules — there's a current One UI bug where Samsung Routines double-fires notifications through MacroDroid.

---

## Step 2 — Create the macro

Open MacroDroid → **Add Macro** (+ button) → name it **`Wallet Auto-Log`**.

### Trigger

**Add Trigger → Device Events → Notification Received**

- **Applications:** select **Google Wallet** only.
- **Trigger Text:** leave blank (matches any notification text).
- Tap OK.

### Action

**Add Action → Connectivity → HTTP Request**

- **URL:**
  ```
  https://YOUR-APP.vercel.app/api/quick-add
  ```
  (replace with your actual deployed Finance Tracker URL, no trailing slash)
- **Method:** `POST`
- **Custom Headers** — add these two:
  - `Content-Type: application/json`
  - `X-API-Key: ftqa_...` (paste your full key)
- **Body type:** `Custom (Text)`
- **Body** (copy this exactly):
  ```json
  {"text": "[notification_title]: [notification_text]"}
  ```
  The `[notification_title]` and `[notification_text]` are MacroDroid's magic-text placeholders for the notification's title and body. Insert them via the magic-text picker (the {} icon in the body field) so they substitute at runtime.

Save the macro. **That's the whole setup.**

---

## Step 3 — Test it

Make any small payment with Google Wallet — coffee, snack, anything. Within ~5 seconds of the Wallet notification appearing, refresh Finance Tracker. The transaction should be there with an AI-suggested category.

If it doesn't appear, **open MacroDroid → System Log** (☰ menu → System Log). You'll see your macro's most recent run and the HTTP response code:

- **2xx** → success, transaction is in the DB. Refresh the app. If still not visible, RLS issue — check the response body in the log.
- **401** → API key is wrong. Recreate it in Finance Tracker → API Keys, update the `X-API-Key` header in your macro.
- **422 / 400** → server couldn't parse the notification. Paste the response body to me, I'll tune the AI prompt.
- **429** → rate limit (30 writes/min). Wait a minute. If you hit this regularly, you have a runaway macro — check the log.
- **No HTTP request entry at all** → the notification listener isn't picking up Wallet. Re-check the two permissions in Step 1.

---

## Optional polish — route to the right card

The server tries to extract the last 4 digits of your card from the notification text (`•• 1234` or `ending in 1234`) and route the transaction to the matching `payment_source`. For this to work:

- Open Supabase Dashboard → Table Editor → `payment_sources` → for each of your cards, set the `card_last_four` field. (Phase 2 will add an in-app UI for this; for now it's a direct DB edit.)
- If the server doesn't find a match, it auto-creates a row named `Card •• 1234` (scoped to your user, not visible to other users). You can rename it later.

If the regex doesn't find a last-4 in the notification (Wallet's format varies), the transaction still logs — it just lands on your default payment source. You can fix it manually in the app.

---

## What this macro does NOT do (by design)

- **No 2-minute "confirm this category" nudge.** Originally planned but dropped for simplicity. If a category comes back wrong, open the app and fix it on the transaction. We can add the nudge back later by extending this same macro — the server's `PATCH /api/transactions/[id]` endpoint is already built.
- **No phone-side parsing.** All amount/merchant/category extraction happens server-side via AI. If Wallet ever changes its notification format, only the server prompt needs updating — your phone macro keeps working.
- **No filter for declined or "card added" notifications.** Those go through to the server and get rejected by the AI as "no amount found" → no transaction created. Slightly wasteful (one HTTP call per non-payment), but Wallet doesn't fire many of those.

---

## Summary

- **What you configure on the phone:** 1 trigger + 1 HTTP action = the entire macro.
- **What happens on every payment:** Wallet notif → MacroDroid forwards raw text → server's AI parses → transaction logged in your dashboard within 5 seconds.
- **What you maintain:** nothing. Wallet format changes don't break the phone macro; only the server's AI prompt would need updating, and that's one place.

---

## Advanced — keep the 2-minute nudge

If you want the original lock-screen nudge with "✅ Correct / ✏️ Change / 💬 Type" buttons, the detailed guide is preserved at `docs/MACRODROID_SETUP_ADVANCED.md`. The simple version above is what we recommend starting with — you can graduate to the advanced flow once the basic auto-log is working reliably for you.
