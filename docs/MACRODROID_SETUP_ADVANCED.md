# MacroDroid Setup — Samsung Galaxy S25+ (One UI 8.5 / Android 15)

This sets up your phone so every Google Wallet payment auto-logs into Finance Tracker, and a 2-minute lock-screen nudge lets you confirm or correct the AI's category guess.

**Time to complete:** ~30 minutes the first time. Zero ongoing maintenance.

**Prerequisites:**
- Samsung Galaxy S25+ on Android 15 / One UI 8.5 (already true if you bought it new in 2026).
- The Finance Tracker app deployed and accessible at a public URL (you should already know this — it's where you log in from).
- Your existing app login.

---

## Step 1 — Generate an API key in Finance Tracker

1. On your computer or phone browser, open Finance Tracker and log in.
2. Open the **API Keys** section (it's already wired into the app — same place you'd manage them today).
3. Click **Create API Key**, name it `MacroDroid (S25+)`.
4. **Copy the full key the moment it appears.** It starts with `ftqa_` followed by 32 hex characters. You will not see it again — if you lose it, just delete the key and make a new one.

Keep this key handy for Step 5.

---

## Step 2 — Pre-register every card you'll pay with

Each card you use through Google Wallet needs to exist as a payment source in Finance Tracker, with the **last 4 digits of the card** recorded. This is how the server knows which card you tapped.

For each card in your Wallet:

1. In Finance Tracker, go to your **Payment Sources** list.
2. Add a new payment source: e.g. `Chase Sapphire (1234)`.
3. Set its `card_last_four` field to **the 4 digits Google Wallet shows on the notification** (e.g. `1234`). This is the *device account number*'s last 4 — what Wallet displays after you pay. It may differ from the physical card's last 4 on some virtual-card setups.

> Don't know the exact 4 digits Wallet uses? Skip ahead, make one test payment, and look at the notification text. Then come back and fill them in. The transactions still log; they just won't route to the right card yet.

If you forget to add a card, **the transaction still logs** — it lands on your default payment source. You can also recover by adding the card later: the next payment will route correctly, and you can manually fix older entries.

---

## Step 3 — Install MacroDroid

1. Open the **Play Store** on your S25+.
2. Search for **MacroDroid** (by *ArloSoft*).
3. Tap **Install** (the free version is fine — we don't need any pro features).
4. Open MacroDroid once after install so it can request its initial permissions.

---

## Step 4 — Grant Notification Access

This is the permission MacroDroid needs to read Google Wallet's payment notifications.

1. Open **Settings** on your S25+ → **Apps** → **MacroDroid**.
2. Scroll to **Special access** (Samsung One UI may call it **Special app access** under a "Permissions" sub-menu).
3. Find **Notification access** → toggle MacroDroid **ON**. Confirm the warning dialog.

> **Samsung One UI 8.5 quirk:** Do NOT use Samsung's built-in **Modes and Routines** alongside MacroDroid for notification automation — there's a known bug in this version where Samsung Routines re-fires notifications in a loop. MacroDroid alone is fine; we just sidestep Samsung's automation system entirely.

While you're in Settings:

1. Settings → Apps → MacroDroid → **Battery** → set to **Unrestricted**. (Otherwise Android may freeze MacroDroid in the background and miss notifications.)
2. Settings → Apps → MacroDroid → **Mobile data** → enable **"Allow background data usage"** and **"Allow data usage while Data saver on"**.

---

## Step 5 — Configure MacroDroid GLOBAL variables

Variables hold your server URL, API key, and the most recent transaction id. These need to be **Global** (not local) so multiple macros can read them — Macro #1 will set `transaction_id` and Macro #2 will read it.

In MacroDroid:

1. Tap **☰ menu → Variables**.
2. Make sure you're on the **Global** tab (NOT "Local"). Tap **+** to add each of these as **Global** variables:

| Name | Type | Initial value |
|---|---|---|
| `api_base_url` | String | `https://YOUR-APP.vercel.app` (your deployed Finance Tracker URL — no trailing slash) |
| `api_key` | String | `ftqa_...` (the key from Step 1, full thing) |
| `transaction_id` | String | *(leave blank — Macro #1 will populate it)* |

Triple-check the URL — no trailing slash, must start with `https://`. **All three must be on the Global tab, not Local.** Local variables don't survive across macros and the nudge step will silently fail to find the transaction id otherwise.

---

## Step 6 — Build the "Wallet → Auto-Log" macro

This is the macro that fires when Wallet posts a payment notification.

1. In MacroDroid, tap **Add Macro** (+ icon, bottom right).
2. Name it **`Wallet Auto-Log`**.

### Trigger

1. Tap **Add Trigger** → **Device Events** → **Notification Received**.
2. Configure:
   - **Applications:** select **Google Wallet** (`com.google.android.apps.walletnfcrel`).
   - **Trigger Text:** leave **Any** for now — we'll filter inside the macro.
   - Tap **OK**.

### Actions (in order)

For each action below, tap **Add Action**, navigate to the category, configure it, tap **OK**.

#### 6a. Initialize defaults FIRST, then capture the notification text

Set safe default values for every field we're about to parse. If a regex misses, these defaults keep the JSON body well-formed (zero amount → server's existing zero-skip kicks in, instead of a malformed POST that loses the transaction silently).

1. **Add Action → Variables → Set Variable**
   - New local variable: `amount` (String) = `0`
2. **Add Action → Variables → Set Variable**
   - New local variable: `merchant` (String) = `Unknown`
3. **Add Action → Variables → Set Variable**
   - New local variable: `card_last_four` (String) = *(leave blank)*
4. **Add Action → Variables → Set Variable**
   - New local variable: `is_refund_str` (String) = `false`
   - (String, not boolean — MacroDroid's boolean-to-JSON serialization is unpredictable. We'll write the literal `true` / `false` strings ourselves so the JSON body is always valid.)

Now capture the notification text:

5. **Add Action → Variables → Set Variable**
   - New local variable: `notif_text` (String) = `[notification_text]` (magic-text picker → *Notification Text*).
6. **Add Action → Variables → Set Variable**
   - New local variable: `notif_title` (String) = `[notification_title]`.

#### 6b. Filter — only proceed for actual payments

Add a constraint so promos, "card added", and similar notifications don't trigger a log.

1. **Add Action → Logic → If/Else/Stop**
2. Condition: **Variable Compare → `notif_text` Contains** → `$` (a dollar sign — every payment notification includes the amount).
3. Below the **If**, add: **If condition is false → Stop Macro**.

Also filter out "declined":

1. After the dollar-sign check, add another **If**: **`notif_text` Contains "declined"** → **Stop Macro** (treat declined as not-a-payment).

#### 6c. Detect refunds (overwrites the default if matched)

1. **Add Action → Logic → If**
   - **`notif_text` Contains "refund"** OR **`notif_text` Contains "returned"** OR **`notif_text` Contains "credited"**
2. Inside the If: **Set Variable → `is_refund_str` (String) = `true`**.
3. End If.

#### 6d. Parse amount (overwrites the default of `0` if matched)

Wallet US notifications typically look like *"$5.40 at Starbucks"* or *"You paid $5.40 with Visa •• 1234"*. The amount is the first dollar value.

1. **Add Action → Variables → Set Variable**
   - Variable: `amount` (String) — same variable from 6a.
   - Value: use **Regex Extraction** (advanced) on `[lv=notif_text]` with pattern:
     ```
     \$\s?(\d+(?:\.\d{1,2})?)
     ```
   - Pick group 1.

If the regex misses, `amount` stays `0` (from 6a) and the server's existing zero-amount logic silently skips the insert — the JSON body remains valid and your macro doesn't blow up. You'll see "no transaction created" in the System log; that's your signal to widen the regex.

#### 6e. Parse card last-4

The pattern in the notification is typically `•• 1234` or `••1234` or `ending in 1234`.

1. **Add Action → Variables → Set Variable**
   - Variable: `card_last_four` (String).
   - Value: regex on `[lv=notif_text]` with pattern:
     ```
     (?:••\s?|ending in )(\d{4})
     ```
   - Group 1.

If the regex returns empty (some Wallet versions don't include the card on the lock-screen notif), the transaction still logs — it just routes to your default payment source.

#### 6f. Parse merchant

Merchant appears after **at** in most US Wallet notifs: *"$5.40 **at** Starbucks"*.

1. **Add Action → Variables → Set Variable**
   - Variable: `merchant` (String).
   - Value: regex on `[lv=notif_text]` with pattern:
     ```
     \bat\s+([^.,\n]+?)(?:\s+with|\s*$|\.|,)
     ```
   - Group 1.

If empty, fall back to `notif_title` (often Wallet uses the title for merchant).

#### 6g. Build a client_ref for idempotency

Same notification firing twice (Samsung quirk) should NOT create two transactions. We build a unique-per-notification key.

1. **Add Action → Variables → Set Variable**
   - Variable: `client_ref` (String).
   - Value: `wallet_[lv=amount]_[lv=card_last_four]_[notification_when]`
   - (`[notification_when]` is the magic-text timestamp of when this notification was posted — same notification = same value, so retries dedupe at the server.)

#### 6h. HTTP POST to /api/quick-add

> **JSON safety note:** `amount` and `is_refund_str` are substituted without quotes in the body so they become JSON number / boolean literals. We pre-initialized both in 6a so substitution always produces valid JSON even if a regex missed. Strings (`merchant`, `card_last_four`, `client_ref`) ARE quoted; if they're empty, you get a valid `""` rather than malformed JSON.

1. **Add Action → Connectivity → HTTP Request**.
2. Configure:
   - **URL:** `[lv=api_base_url]/api/quick-add`
   - **Method:** `POST`
   - **Custom headers:**
     - `Content-Type: application/json`
     - `X-API-Key: [lv=api_key]`
   - **Body type:** `Custom (Text)`
   - **Body:**
     ```json
     {
       "amount": [lv=amount],
       "description": "[lv=merchant]",
       "card_last_four": "[lv=card_last_four]",
       "is_refund": [lv=is_refund_str],
       "client_ref": "[lv=client_ref]"
     }
     ```
   - **Save response to variable:** `api_response` (String, local — only used by this macro run).

> We use simple mode (`amount` as a number). The server doesn't need AI to parse anything because we've already extracted everything from the Wallet notification. AI runs server-side only for category guessing based on the merchant name.

#### 6i. Extract the transaction id into the GLOBAL variable

1. **Add Action → Variables → Set Variable**
   - Variable: **`transaction_id`** — pick from the **Global** tab (not Local).
   - Value: regex on `[lv=api_response]` with pattern:
     ```
     "id"\s*:\s*"([^"]+)"
     ```
   - Pick group 1.

If the regex fails (server returned an error or `mode: idempotent` with no `id` in the response), `transaction_id` will be empty — the nudge step below skips itself in that case.

#### 6j. Schedule the 2-minute nudge

1. **Add Action → MacroDroid Specific → Wait Before Next Action**.
   - **Wait 2 minutes**. **In background** (so it doesn't block other macros).
2. **Add Action → Logic → If `transaction_id` is not empty**.
3. Inside the If:
   - **Add Action → Notifications → Display Notification**.
   - Title: `Logged $[lv=amount] at [lv=merchant]`
   - Text: `Categorized by AI — tap to confirm or change`
   - Tap action: launch URL `[lv=api_base_url]/transactions/[lv=transaction_id]` (deep-link to the transaction in Finance Tracker — opens the app).
   - **Notification action buttons** (up to 3; this is the Android limit):
     - **Button 1 — `✅ Correct`** → action: **Dismiss notification**.
     - **Button 2 — `✏️ Change`** → action: launch URL `[lv=api_base_url]/transactions/[lv=transaction_id]?edit=1`.
     - **Button 3 — `💬 Type`** → action: **Trigger macro by name → `Wallet Nudge — Type Reply`** (the sub-macro we build in Step 7).

Save the macro.

---

## Step 7 — Build the "Type Reply → AI Patch" sub-macro

When you tap the **💬 Type** button on the nudge, this macro shows a dialog where you type a correction (e.g. *"actually that was a refund, restaurants"*) and PATCHes the server with that text. The server's DeepSeek re-parse handles the rest.

> **Why a dialog, not inline-reply?** MacroDroid's "Notification Reply" action is for *responding to other apps' notifications* (WhatsApp, Telegram), not capturing replies on notifications you display. Quick-reply inline text capture from a self-displayed notification isn't reliably supported. A Display Prompt dialog is the robust path — and only one extra tap.

1. **Add Macro** → name it exactly **`Wallet Nudge — Type Reply`** (Step 6j's Button 3 references this name).

### Trigger

1. **Add Trigger → MacroDroid Specific → Macro Run from Action**. (This is the "I'm called by another macro" trigger.)

### Actions

1. **Add Action → User Input → Display Prompt**.
   - Title: `Correct $[gv=amount_for_prompt] at [gv=merchant_for_prompt]`
     - (Use `[gv=…]` magic text — global variables. We'll set these from Macro #1 just before triggering this macro. If you don't want the title to show context, just use a static title like `Correct transaction`.)
   - Message: `Type the correction — e.g. "actually put that under coffee" or "this was a refund"`
   - Input type: **Text** (multi-line OK).
   - Store result in: **Global** variable `nudge_reply_text` (String).
   - On cancel: **Stop Macro**.
2. **Add Action → Logic → If `nudge_reply_text` is not empty AND `transaction_id` is not empty**.
3. Inside the If:
   - **Add Action → Connectivity → HTTP Request**.
   - **URL:** `[gv=api_base_url]/api/transactions/[gv=transaction_id]`
   - **Method:** `PATCH`
   - **Headers:**
     - `Content-Type: application/json`
     - `X-API-Key: [gv=api_key]`
   - **Body type:** `Custom (Text)`
   - **Body:**
     ```json
     { "text": "[gv=nudge_reply_text]" }
     ```
   - **Save response:** not needed (the app will reflect the change next time you open it).
4. **Add Action → Notifications → Display Notification (Toast)**.
   - Message: `Update sent` — gives you a visual confirmation that the macro ran.

Save.

> **One small addition to Macro #1, Step 6j:** Before calling **Trigger macro by name** for the `💬 Type` button, set two more globals so the prompt title reads naturally:
> - **Set Global Variable** `amount_for_prompt` (String) = `[lv=amount]`
> - **Set Global Variable** `merchant_for_prompt` (String) = `[lv=merchant]`
> - (Add these as the first two actions inside the *If `transaction_id` is not empty* block, before the Display Notification action.)

---

## Step 8 — Test the whole thing

1. Go somewhere that takes contactless payment and **make a real payment of any amount** with Google Wallet. (A coffee or a candy bar is fine.)
2. **Within ~5 seconds** of the Wallet notification appearing, open Finance Tracker in your browser — the transaction should already be there, with an AI-suggested category.
3. **Two minutes later**, your phone should buzz with the nudge: *"Logged $X at MERCHANT — tap to confirm or change."*
4. Try each button:
   - **✅ Correct** → dismisses, transaction stays as-is.
   - **✏️ Change** → opens the app on the transaction page.
   - **💬 Type** → quick-reply field appears. Type *"actually put that under coffee"* and hit send. Within a few seconds, the transaction's category should be updated in the app.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Transaction never appears | Notification access not granted | Settings → Apps → MacroDroid → Special access → Notification access **ON** |
| Transaction never appears, notif access IS on | MacroDroid is being battery-frozen | Settings → Apps → MacroDroid → Battery → **Unrestricted** |
| Two transactions per payment | Samsung Routines is duplicating notifications | Disable any Samsung Routines that touch notifications |
| Wrong card | `card_last_four` doesn't match Wallet's last-4 (virtual card vs physical card) | Make a test payment, copy the 4 digits Wallet shows, update the payment source |
| Amount is off (e.g. logged as $5 instead of $5.40) | Regex truncated | Open MacroDroid → System log → find the notification → check the exact text → adjust the regex in action 6d |
| Nudge never fires | `transaction_id` extraction failed (server returned error) | Open MacroDroid → System log → find the macro run → look at `api_response` content |
| Nudge fires but `transaction_id` is empty | `transaction_id` was set as a Local variable, not Global. The second macro can't read it. | Step 5 — recreate it as a **Global** variable. Same for `api_base_url` and `api_key`. |
| Type-reply dialog never appears | Sub-macro name in Step 6j Button 3 doesn't exactly match the macro name in Step 7 | Check spelling — Step 7's macro must be named exactly `Wallet Nudge — Type Reply` (with the em-dash) for the "Trigger macro by name" action to resolve it |
| HTTP request fails with 400 "Invalid JSON" | A regex captured an empty value and the JSON body has `"amount": ,` (missing literal) | Confirm Step 6a's default-initialization block ran — `amount` should start as `0` BEFORE any extraction. Open System log to see the actual body posted. |
| HTTP request fails with 401 | API key wrong or expired | Delete and recreate the key in Finance Tracker, update `api_key` variable in MacroDroid |
| HTTP request fails with 429 | Rate-limited (30 writes/min/user) | Wait a minute. If you hit this regularly, something's looping — check System log |

---

## What happens if something goes wrong

This is designed so partial failures still capture the transaction:

- **Server is down** → MacroDroid logs the failed HTTP request in its System log. The payment is NOT recorded. (Solution: MacroDroid's HTTP action has a "retry on failure" option — turn it on.)
- **Internet is out at the moment of payment** → Same as above. Turn on retry-with-backoff in the HTTP action.
- **AI mis-categorizes** → Transaction still logged with the wrong category. Use the nudge or open the app to fix it. The amount and merchant are correct.
- **Card last-4 doesn't match anything** → Transaction still logged, but on your default payment source. Fix by adding the card to Finance Tracker, then editing the transaction.
- **Same notification fires twice** → Server idempotency dedupes via `client_ref`. Second attempt returns the original transaction without inserting again.

---

## Summary

- **What you set up once:** API key, card last-4s, MacroDroid macros (~30 min).
- **What happens every payment:** Tap Wallet → 5 seconds later transaction is in Finance Tracker → 2 minutes later your phone asks you to confirm/correct.
- **What it costs:** $0/month. (DeepSeek V4 Pro on OpenRouter is roughly $0.0004 per transaction — about 40¢/year if you make ~1,000 payments.)

If anything in this guide doesn't match what you see on your S25+, MacroDroid's interface may have shifted slightly — most option names should still be findable via the app's search. Worst case, drop the exact notification text into a chat with me and I'll adjust the regex.
