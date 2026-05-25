-- =============================================================================
-- Migration: Phase 2 — Savings plans
-- Date: 2026-05-25
--
-- Adds a `savings_plans` table for per-user goal tracking. Each plan has a
-- target amount, an accumulated `saved_amount`, an optional target date, and
-- optional free-text notes. Contributions are recorded by bumping
-- `saved_amount` directly (no separate ledger table for v1 — keep the model
-- thin; a contributions sub-table can come later if you want history).
--
-- Decoupled from `transactions`: contributing to a goal does NOT auto-create
-- an expense row. The two are tracked independently, by design — the user
-- can manually log a transaction if they want it in their cashflow too.
--
-- RLS: strict per-user.
--
-- NON-DESTRUCTIVE: every CREATE is guarded behind a `NOT EXISTS` check or
-- uses `IF NOT EXISTS`. Re-running this script is a no-op; nothing is ever
-- dropped or overwritten. Safe to re-run any number of times.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.savings_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  target_amount NUMERIC NOT NULL CHECK (target_amount > 0 AND target_amount <= 1000000000),
  saved_amount  NUMERIC NOT NULL DEFAULT 0 CHECK (saved_amount >= 0 AND saved_amount <= 1000000000),
  target_date   DATE,
  notes         TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------------
-- `user_id` is the only column we filter on under RLS, plus we sort by
-- updated_at for the dashboard's "top 3" widget. A composite index covers
-- both the WHERE and the ORDER BY in one B-tree.

CREATE INDEX IF NOT EXISTS savings_plans_user_updated_idx
  ON public.savings_plans (user_id, updated_at DESC);

-- -----------------------------------------------------------------------------
-- 3. updated_at auto-bump function + trigger
-- -----------------------------------------------------------------------------
-- The dashboard widget sorts by updated_at to surface recently-active goals.
-- The trigger bumps it whenever any column changes (contribution, rename,
-- target tweak), so the app doesn't have to remember to set updated_at on
-- every PATCH.
--
-- Both the function and the trigger are created ONLY IF THEY DON'T EXIST —
-- no DROP, no REPLACE. If someone has already customized either, this
-- migration leaves their version alone.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'savings_plans_set_updated_at'
      AND n.nspname = 'public'
  ) THEN
    CREATE FUNCTION public.savings_plans_set_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'savings_plans_set_updated_at_trg'
      AND tgrelid = 'public.savings_plans'::regclass
  ) THEN
    CREATE TRIGGER savings_plans_set_updated_at_trg
      BEFORE UPDATE ON public.savings_plans
      FOR EACH ROW EXECUTE FUNCTION public.savings_plans_set_updated_at();
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. RLS — strict per-user
-- -----------------------------------------------------------------------------
-- ENABLE ROW LEVEL SECURITY is idempotent (no-op if already enabled).
-- Each policy is created only if missing.

ALTER TABLE public.savings_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_plans' AND policyname='savings_plans_select_own') THEN
    CREATE POLICY savings_plans_select_own ON public.savings_plans
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_plans' AND policyname='savings_plans_insert_own') THEN
    CREATE POLICY savings_plans_insert_own ON public.savings_plans
      FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_plans' AND policyname='savings_plans_update_own') THEN
    CREATE POLICY savings_plans_update_own ON public.savings_plans
      FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='savings_plans' AND policyname='savings_plans_delete_own') THEN
    CREATE POLICY savings_plans_delete_own ON public.savings_plans
      FOR DELETE TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;

COMMIT;
