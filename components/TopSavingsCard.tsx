'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Target, ArrowRight, PartyPopper } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { SavingsPlan } from '@/types'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'

/**
 * Dashboard widget: top 3 savings goals by recent activity.
 *
 * Sourced from `savings_plans ORDER BY updated_at DESC LIMIT 3`. The trigger
 * on the table bumps `updated_at` on every contribution / edit, so this
 * surfaces what the user is actively working on rather than just what was
 * created first.
 *
 * Hidden entirely when the user has no savings goals — keeps the dashboard
 * decluttered for new users until they create one.
 *
 * Accepts an optional `onViewAll` callback so the parent can switch to the
 * Savings tab from the in-card link. If not provided, the link is omitted.
 */
interface TopSavingsCardProps {
  onViewAll?: () => void
}

export default function TopSavingsCard({ onViewAll }: TopSavingsCardProps) {
  const { currency } = useCurrency()
  const [plans, setPlans] = useState<SavingsPlan[]>([])
  const [loading, setLoading] = useState(true)

  // Reusable loader. Each caller passes an `isActive()` predicate so it can
  // bail out before applying state updates if its scope was already torn
  // down (e.g., unmount, or the next event-driven refetch starting).
  const load = useCallback(async (isActive: () => boolean) => {
    const { data } = await supabase
      .from('savings_plans')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(3)
    if (!isActive()) return
    setPlans((data as SavingsPlan[]) ?? [])
    setLoading(false)
  }, [])

  // Initial fetch — cancellable on unmount.
  useEffect(() => {
    let cancelled = false
    load(() => !cancelled)
    return () => { cancelled = true }
  }, [load])

  // Mirror the Savings tab: re-fetch when Finn mutates plans. Each handler
  // call runs in its own scope, so we use a fresh `cancelled` flag — the
  // useEffect cleanup tears down the listener AND signals any in-flight
  // fetch from the previous handler to abandon its state update.
  useEffect(() => {
    let cancelled = false
    const handler = () => { load(() => !cancelled) }
    window.addEventListener('finn:savings-changed', handler)
    return () => {
      cancelled = true
      window.removeEventListener('finn:savings-changed', handler)
    }
  }, [load])

  // Hide the card entirely while loading (no flash) and when empty.
  // No saved goals = no point showing a half-empty placeholder.
  if (loading || plans.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-muted-foreground" />
            Top Savings Goals
          </CardTitle>
          {onViewAll && (
            <Button variant="ghost" size="sm" onClick={onViewAll} className="h-7 text-xs">
              View all <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {plans.map(plan => {
            const percentage = Math.min((plan.saved_amount / plan.target_amount) * 100, 100)
            const isComplete = plan.saved_amount >= plan.target_amount
            return (
              <div key={plan.id} className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium min-w-0">
                  {isComplete && <PartyPopper className="h-3.5 w-3.5 text-green-600 flex-shrink-0" />}
                  <span className="truncate">{plan.name}</span>
                </div>
                <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-1.5 rounded-full transition-all ${isComplete ? 'bg-green-600' : 'bg-primary'}`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
                <div className="text-xs text-muted-foreground tabular-nums truncate">
                  {formatCurrency(plan.saved_amount, currency)}
                  <span className="opacity-70"> / {formatCurrency(plan.target_amount, currency)}</span>
                  <span className="ml-1 opacity-70">({percentage.toFixed(0)}%)</span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
