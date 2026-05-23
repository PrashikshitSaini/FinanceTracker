---
name: project-database-schema
description: Actual column layout of the Supabase tables — confirmed 2026-05-23. Multi-user app. Read before writing any migration or insert payload.
metadata:
  type: project
---

Schema verified via `information_schema.columns` on 2026-05-23. **This is a multi-user app** — multiple real users today.

## `payment_sources`

As of pre-migration schema (verified 2026-05-23):

| column | type | nullable | notes |
|---|---|---|---|
| id | uuid | NO | |
| name | text | NO | |
| created_at | timestamptz | NO | |

After `docs/sql/2026-05-22-phase1-android-automation.sql`:

| column | type | nullable | notes |
|---|---|---|---|
| id | uuid | NO | |
| name | text | NO | |
| created_at | timestamptz | NO | |
| user_id | uuid | YES | FK to `auth.users(id)` ON DELETE SET NULL. **NULL = shared/legacy row** (visible to every user). Non-NULL = owned by that user (visible only to them). |
| card_last_four | text | YES | 4-digit format, CHECK-constrained. |

**RLS model (post-migration):**

- SELECT: `(user_id IS NULL OR user_id = auth.uid())` — shared + own visible.
- INSERT: `WITH CHECK (user_id = auth.uid())` — must claim own user_id. NULL inserts denied for end-users; service role bypasses RLS.
- UPDATE / DELETE: own rows only. Shared rows are immutable from user-facing paths.

**Implication for code:** any INSERT into `payment_sources` from a user-facing path MUST include `user_id`. Service-role inserts can omit it (creating a shared row).

## `categories`

| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| name | text | NO |
| color | text | YES |
| created_at | timestamptz | NO |

**Still global as of 2026-05-23** — no `user_id`, all users see the same list. The same per-user migration pattern from `payment_sources` would apply if/when categories also need per-user scoping (e.g., if a future Phase 2 "Pools" feature wants user-specific categories). Not changed in Phase 1.

## `transactions`

| column | type | nullable | notes |
|---|---|---|---|
| id | uuid | NO | |
| amount | numeric | NO | |
| category | **text** | NO | UUID-as-string. No FK. |
| payment_source | **text** | NO | UUID-as-string. No FK. |
| notes | text | YES | |
| image_url | text | YES | |
| date | date | NO | |
| type | text | NO | |
| created_at | timestamptz | NO | |
| updated_at | timestamptz | NO | |
| user_id | uuid | **YES (nullable!)** | Existing rows may have NULL. |
| is_refund | boolean | NO (default FALSE) | Added 2026-05-22. |
| client_ref | text | YES | Added 2026-05-22. Partial unique index on `(user_id, client_ref) WHERE both IS NOT NULL`. |

Two surprises:

1. **`category` and `payment_source` are TEXT, not UUID/FK.** They store the UUID-as-string. No referential integrity at the DB level — application validates.
2. **`user_id` is nullable.** Existing rows may have NULL user_id; new code always populates it.

## `quick_add_api_keys`

| column | type | nullable |
|---|---|---|
| id | uuid | NO |
| user_id | uuid | NO |
| key_hash | text | NO |
| key_prefix | text | NO |
| name | text | NO |
| last_used_at | timestamptz | YES |
| created_at | timestamptz | NO |

User-scoped (as expected). Per-user API keys for the MacroDroid path.

## Recurring rule

**Before writing any migration or any INSERT payload, verify the columns exist.** This codebase has no schema dump in the repo and no SQL migration history committed — the only ground truth is querying `information_schema` on Supabase. The user has run that query for me at least once; if a future migration is needed, ask them to re-run it rather than guessing.

**Do not assume "single-user" when designing schema changes.** The app is multi-user. Per-user scoping must be considered for any shared table that grows new write paths.
