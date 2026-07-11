-- =============================================================================
-- Migration: Native subscription tracking
-- Date: 2026-07-11
--
-- Adds recurring-expense plans and links each automatically-recorded payment
-- back to ordinary transactions. Active subscriptions are processed daily by
-- the protected Vercel Cron job; a plan itself is not immediately a payment.
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

-- A retry of the daily job must never duplicate a charge for the same plan and
-- scheduled billing date. This also makes the cron job safe if Vercel retries
-- a request after a timeout.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_subscription_charge_once_idx
  ON public.transactions (subscription_id, date)
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

-- Atomically record every due recurring charge and move its schedule forward.
-- If the job was unavailable for a while, the loop records each missed billing
-- date in order, so the ledger still reflects the services that were due.
-- This function is deliberately service-role-only: browser clients may manage
-- their own subscription plans through RLS, but cannot manufacture scheduled
-- charges for arbitrary accounts.
CREATE OR REPLACE FUNCTION public.process_due_subscriptions(
  p_today DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (processed_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  subscription_row RECORD;
  due_date DATE;
  inserted_rows INTEGER;
BEGIN
  processed_count := 0;

  FOR subscription_row IN
    SELECT id, user_id, name, amount, category, payment_source, billing_cycle, next_billing_date
    FROM public.subscriptions
    WHERE is_active = TRUE
      AND next_billing_date <= p_today
    FOR UPDATE SKIP LOCKED
  LOOP
    due_date := subscription_row.next_billing_date;

    WHILE due_date <= p_today LOOP
      INSERT INTO public.transactions (
        user_id,
        amount,
        type,
        category,
        payment_source,
        subscription_id,
        date,
        notes
      ) VALUES (
        subscription_row.user_id,
        subscription_row.amount,
        'expense',
        subscription_row.category,
        subscription_row.payment_source,
        subscription_row.id,
        due_date,
        format('Subscription: %s', subscription_row.name)
      )
      ON CONFLICT (subscription_id, date) WHERE subscription_id IS NOT NULL DO NOTHING;

      GET DIAGNOSTICS inserted_rows = ROW_COUNT;
      processed_count := processed_count + inserted_rows;

      due_date := CASE subscription_row.billing_cycle
        WHEN 'weekly' THEN due_date + 7
        WHEN 'monthly' THEN (due_date + INTERVAL '1 month')::DATE
        WHEN 'yearly' THEN (due_date + INTERVAL '1 year')::DATE
      END;
    END LOOP;

    UPDATE public.subscriptions
    SET next_billing_date = due_date
    WHERE id = subscription_row.id;
  END LOOP;

  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.process_due_subscriptions(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_due_subscriptions(DATE) TO service_role;

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
