-- =============================================================================
-- Migration: Phase 1 — Android payment automation
-- Date: 2026-05-22  (revised 2026-05-23 after schema check + multi-user model)
--
-- Adds:
--   1. payment_sources.user_id          — per-user scoping (nullable; existing
--                                         rows stay NULL = shared/legacy)
--   2. payment_sources.card_last_four   — for matching Google Wallet card by last-4
--   3. RLS policies on payment_sources  — visibility = shared ∪ own; mutations
--                                         only on own rows
--   4. transactions.is_refund           — flag for refunds auto-detected by MacroDroid
--   5. transactions.client_ref          — idempotency token from the phone client
--
-- IMPORTANT — preserving existing behavior for multi-user data:
--   The app has multiple real users today. `payment_sources` has historically
--   been a single shared table (no user_id column) — every user sees every
--   row. We CANNOT simply add user_id and assign existing rows to one user,
--   because we don't know who "owns" the shared rows. Solution:
--
--     • Existing rows: keep user_id = NULL ("shared/legacy"). RLS SELECT
--       policy says NULL rows are visible to every authenticated user, so
--       existing app behavior is preserved exactly.
--     • New rows (e.g. MacroDroid auto-create): must carry user_id =
--       auth.uid(). RLS INSERT policy enforces this. Other users won't see
--       them, no cross-user pollution.
--     • UPDATE/DELETE: only own rows. Shared (NULL) rows are immutable from
--       the user-facing API surface — they can still be edited via the
--       Supabase Dashboard (service role bypasses RLS), which is how they
--       were created in the first place.
--
-- Idempotent: safe to run multiple times. Uses ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, and pg_policies guards on every CREATE POLICY.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. payment_sources columns (user_id and card_last_four)
-- -----------------------------------------------------------------------------

ALTER TABLE public.payment_sources
  ADD COLUMN IF NOT EXISTS user_id UUID;

-- Foreign key to Supabase auth.users so deleting a user nulls out their
-- payment_sources (effectively donating them back to the shared pool).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_sources_user_id_fkey'
  ) THEN
    ALTER TABLE public.payment_sources
      ADD CONSTRAINT payment_sources_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.payment_sources
  ADD COLUMN IF NOT EXISTS card_last_four TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_sources_card_last_four_check'
  ) THEN
    ALTER TABLE public.payment_sources
      ADD CONSTRAINT payment_sources_card_last_four_check
      CHECK (card_last_four IS NULL OR card_last_four ~ '^[0-9]{4}$');
  END IF;
END $$;

-- Lookup index on card_last_four (RLS already filters by user_id, so this
-- index combined with the user_id index below is enough for fast matching).
CREATE INDEX IF NOT EXISTS payment_sources_card_last_four_idx
  ON public.payment_sources (card_last_four)
  WHERE card_last_four IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_sources_user_id_idx
  ON public.payment_sources (user_id)
  WHERE user_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. payment_sources RLS — applied IN ORDER: policies first, then enable.
--    Order matters: if RLS gets enabled with no SELECT policy in place,
--    existing reads would break between the ENABLE and the next CREATE POLICY.
--    Within a BEGIN/COMMIT transaction the outside world only observes the
--    final state, but being explicit about ordering keeps the migration safe
--    even if someone runs it section-by-section outside a transaction.
-- -----------------------------------------------------------------------------

-- SELECT: shared (NULL user_id) rows are visible to everyone, own rows are
-- visible to the owner. This is the policy that preserves backward-compat:
-- every existing row has NULL user_id, so every existing user still sees
-- every existing row exactly as before.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'payment_sources'
      AND policyname = 'payment_sources_select_shared_or_own'
  ) THEN
    CREATE POLICY payment_sources_select_shared_or_own
      ON public.payment_sources
      FOR SELECT
      TO authenticated
      USING (user_id IS NULL OR user_id = auth.uid());
  END IF;
END $$;

-- INSERT: must claim your own user_id. NULL inserts from the user-facing
-- API are denied — new shared rows are still possible but only via the
-- service role (Supabase Dashboard), which is how all current shared rows
-- were created in the first place. This prevents one user from creating a
-- payment_source that pollutes everyone else's list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'payment_sources'
      AND policyname = 'payment_sources_insert_own'
  ) THEN
    CREATE POLICY payment_sources_insert_own
      ON public.payment_sources
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- UPDATE: only your own rows. Shared (NULL user_id) rows stay immutable
-- from user-facing paths to prevent one user from renaming a row that
-- every other user sees.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'payment_sources'
      AND policyname = 'payment_sources_update_own'
  ) THEN
    CREATE POLICY payment_sources_update_own
      ON public.payment_sources
      FOR UPDATE
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- DELETE: only your own rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'payment_sources'
      AND policyname = 'payment_sources_delete_own'
  ) THEN
    CREATE POLICY payment_sources_delete_own
      ON public.payment_sources
      FOR DELETE
      TO authenticated
      USING (user_id = auth.uid());
  END IF;
END $$;

-- Now enable RLS. If it was already on, this is a no-op. If it was off,
-- the four policies above are now in effect and existing reads continue to
-- work because every existing row has user_id IS NULL (covered by SELECT
-- policy above).
ALTER TABLE public.payment_sources ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. transactions.is_refund
-- -----------------------------------------------------------------------------
-- Boolean flag. When TRUE: this transaction represents money returned to the
-- user (refund / return / chargeback reversal). The row's `type` will be
-- 'income' so totals balance, but is_refund=TRUE lets the UI separate "real
-- income" from "refund income" in reports.
-- -----------------------------------------------------------------------------

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT FALSE;

-- -----------------------------------------------------------------------------
-- 4. transactions.client_ref + partial unique index for idempotency
-- -----------------------------------------------------------------------------
-- Optional idempotency token supplied by the client (e.g. MacroDroid). The
-- partial unique index ensures at most one row per (user_id, client_ref)
-- where both are non-NULL. The server catches the unique-violation and
-- returns the already-stored row instead of erroring.
-- -----------------------------------------------------------------------------

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS client_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_client_ref_uniq
  ON public.transactions (user_id, client_ref)
  WHERE client_ref IS NOT NULL AND user_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- ROLLBACK (do not run unless you know what you're doing)
-- =============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.transactions_user_client_ref_uniq;
--   DROP INDEX IF EXISTS public.payment_sources_user_id_idx;
--   DROP INDEX IF EXISTS public.payment_sources_card_last_four_idx;
--   ALTER TABLE public.transactions    DROP COLUMN IF EXISTS client_ref;
--   ALTER TABLE public.transactions    DROP COLUMN IF EXISTS is_refund;
--   DROP POLICY IF EXISTS payment_sources_delete_own         ON public.payment_sources;
--   DROP POLICY IF EXISTS payment_sources_update_own         ON public.payment_sources;
--   DROP POLICY IF EXISTS payment_sources_insert_own         ON public.payment_sources;
--   DROP POLICY IF EXISTS payment_sources_select_shared_or_own ON public.payment_sources;
--   ALTER TABLE public.payment_sources DROP CONSTRAINT IF EXISTS payment_sources_card_last_four_check;
--   ALTER TABLE public.payment_sources DROP CONSTRAINT IF EXISTS payment_sources_user_id_fkey;
--   ALTER TABLE public.payment_sources DROP COLUMN IF EXISTS card_last_four;
--   ALTER TABLE public.payment_sources DROP COLUMN IF EXISTS user_id;
--   -- Leaving RLS enabled — disabling could break things if other policies
--   -- depend on it. Re-enable with: ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
-- COMMIT;
