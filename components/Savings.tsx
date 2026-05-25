'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, Target, AlertTriangle, PartyPopper, CheckCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { SavingsPlan } from '@/types'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'
import { parseLocalDate } from '@/lib/utils'
import { format } from 'date-fns'

/**
 * Savings goals dashboard.
 *
 * Pure CRUD over the `savings_plans` table. RLS enforces that the user can
 * only see their own rows, so we issue plain `supabase.from('savings_plans')`
 * queries without any explicit user_id filter — the policy adds it.
 *
 * Each plan card shows progress, remaining, and target-date status (if any),
 * with three actions: contribute, edit, delete. Add new goals via the
 * header button.
 *
 * Decoupling from transactions: contributing here does NOT create an expense
 * row in transactions. Savings is a separate tracker; if the user wants the
 * dollar amount also reflected in cashflow, they can manually log it.
 */
export default function Savings() {
  const { currency } = useCurrency()
  const [plans, setPlans] = useState<SavingsPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Dialog state — only one dialog open at a time, so we route via mode.
  const [dialogMode, setDialogMode] = useState<
    | { kind: 'closed' }
    | { kind: 'create' }
    | { kind: 'edit'; plan: SavingsPlan }
    | { kind: 'contribute'; plan: SavingsPlan }
    | { kind: 'delete'; plan: SavingsPlan }
  >({ kind: 'closed' })

  // Form fields — shared between create + edit; reset whenever dialog opens.
  const [formName, setFormName] = useState('')
  const [formTargetAmount, setFormTargetAmount] = useState('')
  const [formSavedAmount, setFormSavedAmount] = useState('')
  const [formTargetDate, setFormTargetDate] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formBusy, setFormBusy] = useState(false)

  // Contribute / delete state
  const [contributeAmount, setContributeAmount] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const fetchPlans = useCallback(async () => {
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('savings_plans')
      .select('*')
      .order('updated_at', { ascending: false })
    if (fetchError) {
      setError('Failed to load savings goals.')
    } else {
      setPlans((data as SavingsPlan[]) ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchPlans()
  }, [fetchPlans])

  // ─── Form helpers ──────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormName('')
    setFormTargetAmount('')
    setFormSavedAmount('')
    setFormTargetDate('')
    setFormNotes('')
    setError(null)
  }

  const openCreate = () => {
    resetForm()
    setDialogMode({ kind: 'create' })
  }

  const openEdit = (plan: SavingsPlan) => {
    setFormName(plan.name)
    setFormTargetAmount(plan.target_amount.toString())
    setFormSavedAmount(plan.saved_amount.toString())
    setFormTargetDate(plan.target_date ?? '')
    setFormNotes(plan.notes ?? '')
    setError(null)
    setDialogMode({ kind: 'edit', plan })
  }

  const openContribute = (plan: SavingsPlan) => {
    setContributeAmount('')
    setError(null)
    setDialogMode({ kind: 'contribute', plan })
  }

  const closeDialog = () => {
    if (formBusy || actionBusy) return
    setDialogMode({ kind: 'closed' })
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  /** Returns an error message string on failure, or null on success. */
  const validateForm = (): string | null => {
    if (!formName.trim()) return 'Name is required.'
    if (formName.trim().length > 100) return 'Name must be 100 characters or fewer.'

    const targetNum = parseFloat(formTargetAmount)
    if (!Number.isFinite(targetNum) || targetNum <= 0) return 'Target amount must be greater than 0.'
    if (targetNum > 1_000_000_000) return 'Target amount exceeds the maximum (1 billion).'

    if (formSavedAmount.trim()) {
      const savedNum = parseFloat(formSavedAmount)
      if (!Number.isFinite(savedNum) || savedNum < 0) return 'Saved amount cannot be negative.'
      if (savedNum > 1_000_000_000) return 'Saved amount exceeds the maximum.'
    }

    if (formTargetDate && !/^\d{4}-\d{2}-\d{2}$/.test(formTargetDate)) {
      return 'Target date must be in YYYY-MM-DD format.'
    }

    if (formNotes.length > 1000) return 'Notes must be 1000 characters or fewer.'

    return null
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    const validationError = validateForm()
    if (validationError) { setError(validationError); return }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError('Not signed in.'); return }

    setFormBusy(true)
    const payload = {
      user_id: user.id,
      name: formName.trim(),
      target_amount: parseFloat(formTargetAmount),
      saved_amount: formSavedAmount.trim() ? parseFloat(formSavedAmount) : 0,
      target_date: formTargetDate || null,
      notes: formNotes.trim() || null,
    }
    const { error: insertError } = await supabase
      .from('savings_plans')
      .insert([payload])

    setFormBusy(false)

    if (insertError) {
      if (process.env.NODE_ENV === 'development') console.error(insertError)
      setError('Failed to create goal. Please try again.')
      return
    }

    closeDialog()
    fetchPlans()
  }

  const handleEdit = async () => {
    if (dialogMode.kind !== 'edit') return
    const validationError = validateForm()
    if (validationError) { setError(validationError); return }

    setFormBusy(true)
    const payload: Record<string, unknown> = {
      name: formName.trim(),
      target_amount: parseFloat(formTargetAmount),
      saved_amount: formSavedAmount.trim() ? parseFloat(formSavedAmount) : 0,
      target_date: formTargetDate || null,
      notes: formNotes.trim() || null,
    }
    const { error: updateError } = await supabase
      .from('savings_plans')
      .update(payload)
      .eq('id', dialogMode.plan.id)

    setFormBusy(false)

    if (updateError) {
      if (process.env.NODE_ENV === 'development') console.error(updateError)
      setError('Failed to update goal. Please try again.')
      return
    }

    closeDialog()
    fetchPlans()
  }

  const handleContribute = async () => {
    if (dialogMode.kind !== 'contribute') return

    const amount = parseFloat(contributeAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Amount must be greater than 0.')
      return
    }
    if (amount > 1_000_000_000) {
      setError('Amount exceeds the maximum.')
      return
    }

    setActionBusy(true)
    const newSaved = Math.min(
      dialogMode.plan.saved_amount + amount,
      1_000_000_000,
    )
    const { error: updateError } = await supabase
      .from('savings_plans')
      .update({ saved_amount: newSaved })
      .eq('id', dialogMode.plan.id)

    setActionBusy(false)

    if (updateError) {
      if (process.env.NODE_ENV === 'development') console.error(updateError)
      setError('Failed to record contribution. Please try again.')
      return
    }

    closeDialog()
    fetchPlans()
  }

  const handleDelete = async () => {
    if (dialogMode.kind !== 'delete') return
    setActionBusy(true)
    const { error: deleteError } = await supabase
      .from('savings_plans')
      .delete()
      .eq('id', dialogMode.plan.id)
    setActionBusy(false)
    if (deleteError) {
      if (process.env.NODE_ENV === 'development') console.error(deleteError)
      setError('Failed to delete goal.')
      return
    }
    closeDialog()
    fetchPlans()
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Target className="h-6 w-6" />
            Savings Goals
          </h2>
          <p className="text-sm text-muted-foreground">
            Track what you&apos;re saving for. Independent from your transactions.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New Goal
        </Button>
      </div>

      {error && dialogMode.kind === 'closed' && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
      ) : plans.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Target className="h-10 w-10 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">
              No savings goals yet. Set your first one and start tracking.
            </p>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Create Goal
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              currency={currency}
              onContribute={() => openContribute(plan)}
              onEdit={() => openEdit(plan)}
              onDelete={() => setDialogMode({ kind: 'delete', plan })}
            />
          ))}
        </div>
      )}

      {/* ─── Create / Edit dialog ─────────────────────────────────────────── */}
      <Dialog
        open={dialogMode.kind === 'create' || dialogMode.kind === 'edit'}
        onOpenChange={open => { if (!open) closeDialog() }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogMode.kind === 'edit' ? 'Edit Savings Goal' : 'New Savings Goal'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sp-name">Name</Label>
              <Input
                id="sp-name"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="New laptop, Emergency fund, Hawaii trip…"
                maxLength={100}
                autoFocus
                disabled={formBusy}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="sp-target">Target {currency ? `(${currency})` : ''}</Label>
                <Input
                  id="sp-target"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={formTargetAmount}
                  onChange={e => setFormTargetAmount(e.target.value)}
                  placeholder="1000"
                  disabled={formBusy}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sp-saved">
                  Saved so far <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="sp-saved"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={formSavedAmount}
                  onChange={e => setFormSavedAmount(e.target.value)}
                  placeholder="0"
                  disabled={formBusy}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sp-date">
                Target date <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="sp-date"
                type="date"
                value={formTargetDate}
                onChange={e => setFormTargetDate(e.target.value)}
                disabled={formBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sp-notes">
                Notes <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Textarea
                id="sp-notes"
                value={formNotes}
                onChange={e => setFormNotes(e.target.value)}
                placeholder="Why are you saving for this? Anything to remember?"
                maxLength={1000}
                rows={2}
                disabled={formBusy}
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 border border-destructive/30 text-sm">
                <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={formBusy}>Cancel</Button>
            <Button
              onClick={dialogMode.kind === 'edit' ? handleEdit : handleCreate}
              disabled={formBusy || !formName.trim() || !formTargetAmount.trim()}
            >
              {formBusy ? 'Saving…' : (dialogMode.kind === 'edit' ? 'Save' : 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Contribute dialog ────────────────────────────────────────────── */}
      <Dialog
        open={dialogMode.kind === 'contribute'}
        onOpenChange={open => { if (!open) closeDialog() }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Add to {dialogMode.kind === 'contribute' ? dialogMode.plan.name : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sp-contrib">Amount {currency ? `(${currency})` : ''}</Label>
              <Input
                id="sp-contrib"
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={contributeAmount}
                onChange={e => setContributeAmount(e.target.value)}
                placeholder="50"
                autoFocus
                disabled={actionBusy}
              />
              <p className="text-xs text-muted-foreground">
                Adds to your saved amount. Doesn&apos;t create a transaction — log one manually if you want it in your cashflow too.
              </p>
            </div>
            {error && (
              <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 border border-destructive/30 text-sm">
                <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={actionBusy}>Cancel</Button>
            <Button onClick={handleContribute} disabled={actionBusy || !contributeAmount.trim()}>
              {actionBusy ? 'Saving…' : 'Add Contribution'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete confirmation ──────────────────────────────────────────── */}
      <Dialog
        open={dialogMode.kind === 'delete'}
        onOpenChange={open => { if (!open) closeDialog() }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this savings goal?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {dialogMode.kind === 'delete' && (
              <>
                <strong>{dialogMode.plan.name}</strong> and its saved-amount progress
                will be removed. This can&apos;t be undone.
              </>
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={actionBusy}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={actionBusy}>
              {actionBusy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Per-card component ──────────────────────────────────────────────────────

/**
 * Single savings-plan card. Pulled out so the dashboard's top-3 widget can
 * re-use the same visual treatment without duplicating the layout math.
 */
function PlanCard({
  plan,
  currency,
  onContribute,
  onEdit,
  onDelete,
}: {
  plan: SavingsPlan
  currency: string
  onContribute: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const percentage = Math.min((plan.saved_amount / plan.target_amount) * 100, 100)
  const remaining = Math.max(plan.target_amount - plan.saved_amount, 0)
  const isComplete = plan.saved_amount >= plan.target_amount

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-start justify-between gap-2 text-base">
          <span className="flex items-center gap-1.5 min-w-0">
            {isComplete ? (
              <PartyPopper className="h-4 w-4 text-green-600 flex-shrink-0" />
            ) : (
              <Target className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <span className="truncate">{plan.name}</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3">
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="tabular-nums">
              {formatCurrency(plan.saved_amount, currency)}
              <span className="text-muted-foreground"> of {formatCurrency(plan.target_amount, currency)}</span>
            </span>
            <span className="tabular-nums font-semibold">{percentage.toFixed(0)}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all ${isComplete ? 'bg-green-600' : 'bg-primary'}`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>

        <div className="text-xs text-muted-foreground space-y-0.5 min-h-[1.2em]">
          {isComplete ? (
            <span className="text-green-700 dark:text-green-500 flex items-center gap-1 font-medium">
              <CheckCircle2 className="h-3 w-3" />
              Goal reached!
            </span>
          ) : (
            <span>{formatCurrency(remaining, currency)} to go</span>
          )}
          {plan.target_date && (
            <div>By {format(parseLocalDate(plan.target_date), 'MMM d, yyyy')}</div>
          )}
        </div>

        {plan.notes && (
          <p className="text-xs text-muted-foreground line-clamp-2">{plan.notes}</p>
        )}

        <div className="flex gap-2 mt-auto pt-2">
          <Button size="sm" onClick={onContribute} className="flex-1" disabled={isComplete}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
