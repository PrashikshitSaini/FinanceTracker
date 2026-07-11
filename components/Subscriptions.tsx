'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format, isBefore, isValid, startOfDay } from 'date-fns'
import { AlertTriangle, CalendarDays, Pencil, Play, Plus, Repeat, Trash2, Pause } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/currency'
import { getLocalTodayISO, parseLocalDate } from '@/lib/utils'
import { useCurrency } from '@/contexts/CurrencyContext'
import type { Subscription, SubscriptionBillingCycle } from '@/types'

type SubscriptionDialog =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; subscription: Subscription }
  | { kind: 'delete'; subscription: Subscription }

const billingCycleLabels: Record<SubscriptionBillingCycle, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
}

function monthlyCost(subscription: Subscription): number {
  const amount = Number(subscription.amount)
  if (subscription.billing_cycle === 'weekly') return amount * 52 / 12
  if (subscription.billing_cycle === 'yearly') return amount / 12
  return amount
}

/**
 * Native recurring-expense tracker. A protected daily server job creates each
 * due active subscription charge as a regular linked transaction, so planned
 * charges do not inflate totals before their scheduled date.
 */
export default function Subscriptions() {
  const { currency } = useCurrency()
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [paymentSources, setPaymentSources] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<SubscriptionDialog>({ kind: 'closed' })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [paymentSource, setPaymentSource] = useState('')
  const [billingCycle, setBillingCycle] = useState<SubscriptionBillingCycle>('monthly')
  const [nextDate, setNextDate] = useState(getLocalTodayISO())
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setError(null)
    const [subscriptionsResult, categoriesResult, sourcesResult] = await Promise.all([
      supabase
        .from('subscriptions')
        .select('*')
        .order('is_active', { ascending: false })
        .order('next_billing_date', { ascending: true }),
      supabase.from('categories').select('id, name').order('name'),
      supabase.from('payment_sources').select('id, name').order('name'),
    ])

    if (subscriptionsResult.error) {
      setError('Failed to load subscriptions. Make sure the subscriptions SQL migration has been run.')
    } else {
      setSubscriptions(
        ((subscriptionsResult.data as Subscription[] | null) ?? []).map(subscription => ({
          ...subscription,
          amount: Number(subscription.amount),
        }))
      )
    }
    if (categoriesResult.data) setCategories(categoriesResult.data)
    if (sourcesResult.data) setPaymentSources(sourcesResult.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Finn dispatches this after it creates or edits a subscription through a
  // tool call, so the tab updates without requiring a page refresh.
  useEffect(() => {
    const handler = () => fetchData()
    window.addEventListener('finn:subscriptions-changed', handler)
    return () => window.removeEventListener('finn:subscriptions-changed', handler)
  }, [fetchData])

  const activeSubscriptions = useMemo(
    () => subscriptions.filter(subscription => subscription.is_active),
    [subscriptions]
  )
  const estimatedMonthlyTotal = useMemo(
    () => activeSubscriptions.reduce((total, subscription) => total + monthlyCost(subscription), 0),
    [activeSubscriptions]
  )

  const resetForm = () => {
    setName('')
    setAmount('')
    setCategory('')
    setPaymentSource('')
    setBillingCycle('monthly')
    setNextDate(getLocalTodayISO())
    setNotes('')
    setFormError(null)
  }

  const openCreate = () => {
    resetForm()
    setDialog({ kind: 'create' })
  }

  const openEdit = (subscription: Subscription) => {
    setName(subscription.name)
    setAmount(Number(subscription.amount).toString())
    setCategory(subscription.category)
    setPaymentSource(subscription.payment_source)
    setBillingCycle(subscription.billing_cycle)
    setNextDate(subscription.next_billing_date)
    setNotes(subscription.notes ?? '')
    setFormError(null)
    setDialog({ kind: 'edit', subscription })
  }

  const closeDialog = () => {
    if (saving || deleting) return
    setDialog({ kind: 'closed' })
    setFormError(null)
  }

  const validateForm = (): string | null => {
    if (!name.trim()) return 'A subscription name is required.'
    if (name.trim().length > 100) return 'The name must be 100 characters or fewer.'
    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return 'Amount must be greater than 0.'
    if (parsedAmount > 1_000_000_000) return 'Amount exceeds the maximum (1 billion).'
    if (!category) return 'Choose a category.'
    if (!paymentSource) return 'Choose a payment source.'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || !isValid(parseLocalDate(nextDate))) {
      return 'Next billing date must be a valid date.'
    }
    if (notes.length > 1000) return 'Notes must be 1000 characters or fewer.'
    return null
  }

  const saveSubscription = async () => {
    const validationError = validateForm()
    if (validationError) {
      setFormError(validationError)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setFormError('You need to be signed in to save a subscription.')
      return
    }

    setSaving(true)
    const payload = {
      name: name.trim(),
      amount: Number(amount),
      category,
      payment_source: paymentSource,
      billing_cycle: billingCycle,
      next_billing_date: nextDate,
      notes: notes.trim() || null,
    }

    const result = dialog.kind === 'edit'
      ? await supabase.from('subscriptions').update(payload).eq('id', dialog.subscription.id)
      : await supabase.from('subscriptions').insert([{ ...payload, user_id: user.id }])

    setSaving(false)
    if (result.error) {
      setFormError('Failed to save the subscription. Please try again.')
      return
    }

    setDialog({ kind: 'closed' })
    fetchData()
  }

  const toggleActive = async (subscription: Subscription) => {
    setError(null)
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({ is_active: !subscription.is_active })
      .eq('id', subscription.id)
    if (updateError) {
      setError('Failed to update the subscription status.')
      return
    }
    fetchData()
  }

  const deleteSubscription = async () => {
    if (dialog.kind !== 'delete') return
    setDeleting(true)
    const { error: deleteError } = await supabase
      .from('subscriptions')
      .delete()
      .eq('id', dialog.subscription.id)
    setDeleting(false)
    if (deleteError) {
      setFormError('Failed to delete the subscription.')
      return
    }
    setDialog({ kind: 'closed' })
    fetchData()
  }

  const categoriesById = useMemo(
    () => Object.fromEntries(categories.map(item => [item.id, item.name])),
    [categories]
  )
  const sourcesById = useMemo(
    () => Object.fromEntries(paymentSources.map(item => [item.id, item.name])),
    [paymentSources]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Repeat className="h-6 w-6" />
            Subscriptions
          </h2>
          <p className="text-sm text-muted-foreground">
            Active subscriptions are added to Transactions automatically on each due date.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New Subscription
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Active subscriptions</p>
            <p className="text-2xl font-bold">{activeSubscriptions.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Estimated monthly cost</p>
            <p className="text-2xl font-bold">{formatCurrency(estimatedMonthlyTotal, currency)}</p>
          </CardContent>
        </Card>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading subscriptions…</p>
      ) : subscriptions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Repeat className="h-10 w-10 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">No subscriptions yet. Add the recurring services you pay for.</p>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Add Subscription
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subscriptions.map(subscription => {
            const dueDate = parseLocalDate(subscription.next_billing_date)
            const overdue = subscription.is_active && isBefore(dueDate, startOfDay(new Date()))
            return (
              <Card key={subscription.id} className={!subscription.is_active ? 'opacity-65' : undefined}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{subscription.name}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {billingCycleLabels[subscription.billing_cycle]}
                      </p>
                    </div>
                    <span className={`text-xs rounded-full px-2 py-1 whitespace-nowrap ${
                      subscription.is_active
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {subscription.is_active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-2xl font-bold">{formatCurrency(Number(subscription.amount), currency)}</p>
                  <div className="text-sm space-y-1 text-muted-foreground">
                    <p className={`flex items-center gap-1.5 ${overdue ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}`}>
                      <CalendarDays className="h-4 w-4" />
                      Next: {format(dueDate, 'MMM d, yyyy')}{overdue ? ' (due)' : ''}
                    </p>
                    <p>{categoriesById[subscription.category] || 'Uncategorized'} · {sourcesById[subscription.payment_source] || 'No source'}</p>
                  </div>
                  {subscription.notes && <p className="text-sm text-muted-foreground line-clamp-2">{subscription.notes}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => toggleActive(subscription)}>
                      {subscription.is_active
                        ? <><Pause className="h-4 w-4 mr-1" /> Pause</>
                        : <><Play className="h-4 w-4 mr-1" /> Resume</>}
                    </Button>
                    <Button size="icon" variant="ghost" title="Edit subscription" onClick={() => openEdit(subscription)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" title="Delete subscription" onClick={() => { setFormError(null); setDialog({ kind: 'delete', subscription }) }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={dialog.kind === 'create' || dialog.kind === 'edit'} onOpenChange={open => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialog.kind === 'edit' ? 'Edit Subscription' : 'New Subscription'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="subscription-name">Name</Label>
              <Input id="subscription-name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Netflix" maxLength={100} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="subscription-amount">Amount</Label>
                <Input id="subscription-amount" type="number" min="0.01" max="1000000000" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subscription-cycle">Billing cycle</Label>
                <Select id="subscription-cycle" value={billingCycle} onChange={event => setBillingCycle(event.target.value as SubscriptionBillingCycle)}>
                  {Object.entries(billingCycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="subscription-category">Category</Label>
                <Select id="subscription-category" value={category} onChange={event => setCategory(event.target.value)}>
                  <option value="">Select category</option>
                  {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="subscription-source">Payment source</Label>
                <Select id="subscription-source" value={paymentSource} onChange={event => setPaymentSource(event.target.value)}>
                  <option value="">Select source</option>
                  {paymentSources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="subscription-next-date">Next billing date</Label>
              <Input id="subscription-next-date" type="date" value={nextDate} onChange={event => setNextDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="subscription-notes">Notes</Label>
              <Textarea id="subscription-notes" value={notes} onChange={event => setNotes(event.target.value.slice(0, 1000))} rows={3} maxLength={1000} placeholder="Optional details" />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button onClick={saveSubscription} disabled={saving}>{saving ? 'Saving…' : 'Save Subscription'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog.kind === 'delete'} onOpenChange={open => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Delete subscription?</DialogTitle></DialogHeader>
          {dialog.kind === 'delete' && (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Delete <strong className="text-foreground">{dialog.subscription.name}</strong> from your subscriptions list?</p>
              <p>Existing transactions stay in your history, but will no longer be linked to this subscription.</p>
              {formError && <p className="text-destructive">{formError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button variant="destructive" onClick={deleteSubscription} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
