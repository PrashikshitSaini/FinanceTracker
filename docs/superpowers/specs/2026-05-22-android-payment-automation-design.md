# Phase 1 — Android Payment Automation

**Date:** 2026-05-22
**Status:** Implemented
**Owner:** prash

## Goal

Eliminate manual transaction entry. When the user taps to pay with Google Wallet on their Samsung Galaxy S25+, the transaction should appear in the Finance Tracker automatically, with an AI-suggested category, plus a 2-minute lock-screen nudge to confirm or correct.

This is Phase 1 of three:

- **Phase 1 (this doc):** Android automation that calls existing server endpoints.
- **Phase 2 (future):** "Pools" — Save / Invest / Spend Smart buckets with AI-assisted allocation.
- **Phase 3 (future):** AI plan editor — chat that creates and modifies pools.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Trigger source | Google Wallet payment notification, parsed by MacroDroid on the phone |
| Helper app | MacroDroid (free) |
| Auto-log behavior | Immediate, silent, on every payment notification |
| AI categorization | Run at log time (DeepSeek V4 Pro). Falls back to default category if AI fails. "Capture beats correctness." |
| Payment source | Multi-card. Each card pre-registered with `card_last_four` in the app. Wallet notif's last-4 is authoritative. |
| Refunds | Auto-logged with `is_refund` flag, forced `type=income`, notes prefixed "Refund:". Preserves running balances without polluting income totals (once the UI separates them). |
| Nudge cadence | Fires after every auto-log, 2 minutes later. |
| Nudge "Change" interaction | Three alternate-category buttons (B) plus a free-text reply (C). Free text is re-parsed by DeepSeek V4 Pro and applied as a partial PATCH. |
| AI model | `deepseek/deepseek-v4-pro` via OpenRouter, standard (non-reasoning) mode. Env-overridable. |

## Architecture

```
Google Wallet → Notification → MacroDroid (parses) → HTTP POST /api/quick-add
                                                  → returns { id, mode, data }
                                                  → MacroDroid stores id, sleeps 2 min
                                                  → MacroDroid fires local notif with action buttons
                                                  → User taps → HTTP PATCH /api/transactions/{id}
```

No new backend infrastructure. No mobile app. MacroDroid is the only piece running on the phone; everything else lives in the existing Next.js + Supabase stack.

## Changes shipped

### Database — `docs/sql/2026-05-22-phase1-android-automation.sql`

- `payment_sources.user_id` UUID (nullable, FK to `auth.users(id) ON DELETE SET NULL`). NULL = shared/legacy row visible to everyone; non-NULL = owned by that user only.
- `payment_sources.card_last_four` TEXT (nullable, 4-digit CHECK, non-unique partial index for fast lookup)
- RLS on `payment_sources`: SELECT covers shared ∪ own; INSERT/UPDATE/DELETE restricted to own rows.
- `transactions.is_refund` BOOLEAN NOT NULL DEFAULT FALSE
- `transactions.client_ref` TEXT (nullable, partial unique index `(user_id, client_ref) WHERE both IS NOT NULL` for idempotency)

**Multi-user considerations:** The app has multiple real users. Existing `payment_sources` rows had no `user_id` and were effectively global. The migration leaves their `user_id` as NULL so they remain visible to all users (preserves backward compatibility), while requiring all new rows (e.g., from MacroDroid auto-create) to carry the inserting user's `user_id`. This prevents one user's auto-created cards from polluting another's payment source list.

The `card_last_four` index is intentionally non-unique because a user can legitimately have multiple cards ending in the same four digits (expired + replacement). The application picks the first match.

Idempotent migration: safe to re-run. Apply via Supabase Dashboard → SQL Editor.

### `POST /api/quick-add` — extended (backward-compatible)

New optional body fields:

- `card_last_four` (4-digit string) — routes to the matching `payment_source`; auto-creates a placeholder named `"Card •• 1234"` if no match exists and RLS allows the insert. Otherwise falls back to the user's default payment source (capture beats correctness).
- `is_refund` (boolean) — forces `type=income`, prefixes notes with `"Refund:"`, sets `is_refund=true`.
- `client_ref` (string ≤ 128 chars) — idempotency token. Two-layer dedup: an up-front lookup AND unique-violation handling on insert. Retries return `mode: "idempotent"` instead of erroring.

Model swapped from `openai/gpt-4o-mini` to `deepseek/deepseek-v4-pro` (env: `OPENROUTER_QUICK_ADD_MODEL`). JSON `response_format` requested; defensive parser handles prose-wrapped JSON as fallback.

### `PATCH /api/transactions/[id]` — new endpoint

Partial update of a single transaction. Same auth pattern as quick-add (Bearer / cookie / X-API-Key). Rate-limited via shared `RATE_LIMITS.QUICK_ADD` budget.

Two modes:

- **Structured** — any subset of `{ category, payment_source, notes, is_refund }`. Category and payment_source resolved by name or UUID against the user's lists.
- **AI free-text** — `{ text }` is sent to DeepSeek with the existing transaction's context. The model returns only the fields it thinks changed. Server validates each against the user's lists. `amount`, `date`, `type` are stripped before write — Wallet is ground truth for those.

### `POST /api/ai-chat` — model swap

`openai/gpt-oss-120b` → `deepseek/deepseek-v4-pro` (env: `OPENROUTER_CHAT_MODEL`). No prompt or behavior changes.

## Invariants future edits must preserve

- **Capture beats correctness.** Any failure to resolve a category, payment source, or AI response must NOT prevent the transaction from being logged. Errors are swallowed; the row lands with whatever defaults are available.
- **`card_last_four` is authoritative.** When MacroDroid supplies a last-4, neither the body's `payment_source` nor the AI's pick may override it. (Wallet knows which card was tapped; nothing else does.)
- **Idempotency has two layers.** Pre-insert lookup + post-insert unique-violation handling. Both must stay.
- **PATCH AI free-text cannot edit `amount`, `date`, or `type`.** A hard `delete patch.amount / .date / .client_ref / .user_id / .id` runs immediately before the DB write, regardless of mode. This must stay even if a future edit removes it from the AI prompt's rules.
- **Refund post-processing applies in BOTH `/quick-add` and `PATCH /:id`.** Setting `is_refund=true` forces `type=income` and prefixes notes with `"Refund:"`. Both endpoints implement this; do not move the logic into only one.

## Open / deferred

- Dashboard.tsx does not yet distinguish `is_refund=true` rows from real income. Refunds inflate the income total in current reports. Tracked as Phase 2 polish.
- A "needs review" badge for AI-categorized-but-not-confirmed transactions was discussed and deferred — the user prefers to trust AI's categorization and fix wrong ones via the 2-min nudge.
- Recurring-charge detection (a Rocket Money signature feature) is deferred to Phase 2.5. Doable from existing transaction history alone — no new infra needed.

## Phone-side setup

Two paths, by user preference:

- **Simple (recommended):** `docs/PHONE_SETUP.md` — MacroDroid with a single macro: 1 notification trigger on Google Wallet + 1 HTTP POST to `/api/quick-add`. Body is `{"text": "[notification_title]: [notification_text]"}` — no variables, no regex, no sub-macros. ~5-minute setup. Server-side AI handles all parsing (amount, merchant, category) plus a regex for `card_last_four`. Refund auto-detection was removed because the keyword overlap with normal payments produced too many false positives.

- **Advanced:** `docs/MACRODROID_SETUP_ADVANCED.md` — original MacroDroid-based flow with the 2-minute lock-screen nudge for category correction. Preserved for users who want the richer UX. Most users should stick with the simple path; the PATCH endpoint is still available for editing transactions inside the app whenever needed.
