-- =============================================================================
-- Migration: Native subscription tracking
-- Date: 2026-07-11
--
-- Adds recurring-expense plans and links recorded subscription payments back
-- to ordinary transactions. A plan is intentionally not a transaction: only
-- pressing "Record payment" creates an expense in the cash-flow ledger.
--
-- Run this once in the Supabase SQL Editor before using the Subscriptions tab.
-- It is non-destructive and safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  amount            NUMERIC NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  category          UUID NOT NULL REFERENCES public.categories(id),
  payment_source    UUID NOT NULL REFERENCES public.payment_sources(id),
  billing_cycle     TEXT NOT NULL CHECK (billing_cycle IN ('weekly', 'monthly', 'yearly')),
  next_billing_date DATE NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each transaction can belong to one subscription. When a plan is deleted,
-- retain the transaction but remove only the now-invalid link.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS subscriptions_user_active_next_billing_idx
  ON public.subscriptions (user_id, is_active DESC, next_billing_date);

CREATE INDEX IF NOT EXISTS transactions_subscription_id_idx
  ON public.transactions (subscription_id)
  WHERE subscription_id IS NOT NULL;

-- Keep updated_at in sync with edits and payment-date advances.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'subscriptions_set_updated_at' AND n.nspname = 'public'
  ) THEN
    CREATE FUNCTION public.subscriptions_set_updated_at()
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
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'subscriptions_set_updated_at_trg'
      AND tgrelid = 'public.subscriptions'::regclass
  ) THEN
    CREATE TRIGGER subscriptions_set_updated_at_trg
      BEFORE UPDATE ON public.subscriptions
      FOR EACH ROW EXECUTE FUNCTION public.subscriptions_set_updated_at();
  END IF;
END $$;

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions' AND policyname = 'subscriptions_select_own') THEN
    CREATE POLICY subscriptions_select_own ON public.subscriptions
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions' AND policyname = 'subscriptions_insert_own') THEN
    CREATE POLICY subscriptions_insert_own ON public.subscriptions
      FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions' AND policyname = 'subscriptions_update_own') THEN
    CREATE POLICY subscriptions_update_own ON public.subscriptions
      FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subscriptions' AND policyname = 'subscriptions_delete_own') THEN
    CREATE POLICY subscriptions_delete_own ON public.subscriptions
      FOR DELETE TO authenticated USING (user_id = auth.uid());
  END IF;
END $$;

COMMIT;
