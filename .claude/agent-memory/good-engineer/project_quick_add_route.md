---
name: project-quick-add-route
description: How app/api/quick-add/route.ts now handles Android payment automation, what's sensitive, and what to preserve on future edits
metadata:
  type: project
---

`app/api/quick-add/route.ts` is the entry point for ALL transaction inserts made outside the browser (MacroDroid, scripts, anything API-key-auth'd). After the 2026-05-22 Android-automation work, it has three responsibilities layered together — touching one means understanding the other two.

**1. Three auth paths in priority order:** Bearer header → session cookie → `X-API-Key` header. Each path produces `user` (always) plus optional `accessToken` (Bearer) and `apiKeyAuth` (X-API-Key). The signed-JWT trick (`signUserJwt`) only fires on the API-key path so PostgREST applies normal user-level RLS on inserts — do not propagate `accessToken`/`apiKeyAuth` to a helper without preserving this distinction.

**2. New optional body fields:** `is_refund` (strict `=== true`), `card_last_four` (must match `^[0-9]{4}$`), `client_ref` (≤128 chars, trimmed). Extracted up-front and applied across both simple and AI modes.

**3. Phase 1 invariants the future must not break:**
- **Capture beats correctness.** If AI fails, `card_last_four` doesn't match, or RLS denies auto-create-payment-source, the transaction still logs against the user's default — never error out.
- **`paymentSourceOverrideId` is authoritative.** When `card_last_four` resolved to a payment source (existing or auto-created), the body's `payment_source` and the AI's `payment_source` are both ignored. Wallet knows which card was tapped; nothing else gets to override that.
- **`client_ref` idempotency has two layers.** Lookup *before* insert (cheap fast path) AND unique-violation handling *on* insert (race backstop). Both must stay. The DB unique index is on `(user_id, client_ref) WHERE client_ref IS NOT NULL`; legacy callers with NULL client_ref are unaffected.
- **JSON parse has a fallback.** If `JSON.parse(jsonStr)` fails, we retry on `jsonStr.slice(firstBrace, lastBrace+1)` to recover prose-wrapped JSON from reasoning-mode responses. Don't remove this — the AI model is configurable via `OPENROUTER_QUICK_ADD_MODEL`, and not all models honor `response_format: json_object`.
- **Refund post-processing is the last step before insert.** It forces `type=income` and prefixes notes with `Refund: `. Both happen regardless of simple/AI mode — do not move it inside either branch.

**Helpers added:** `tryCreatePaymentSource` (best-effort insert; null on any failure) and `findExistingByClientRef` (best-effort lookup; null on any error). Both swallow errors by design — surfacing them would defeat "capture beats correctness."

**Model:** `OPENROUTER_QUICK_ADD_MODEL` env var, default `deepseek/deepseek-v4-pro`. Standard (non-reasoning) mode. `response_format: { type: 'json_object' }` is requested but not relied on.

**Migration prerequisite:** `docs/sql/2026-05-22-phase1-android-automation.sql` must be applied to Supabase before this file's new behavior works (the new fields read/write `is_refund`, `client_ref`, `card_last_four` columns).
