'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, CreditCard, AlertTriangle, Save, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'

/**
 * A row from the `payment_sources` table. After the Phase 1 migration the
 * table has both shared rows (user_id IS NULL, visible to everyone via the
 * RLS SELECT policy) and per-user rows (user_id = owner). Existing rows from
 * before the migration are all shared; rows created via this UI or via the
 * MacroDroid auto-create path are per-user.
 *
 * The user can only mutate rows they own. Shared rows are shown for context
 * (so they understand why "Chase Sapphire" is in their list) but display
 * read-only with a "shared" badge.
 */
interface PaymentSource {
  id: string
  name: string
  card_last_four: string | null
  user_id: string | null
  created_at: string
}

const CARD_LAST_FOUR_RE = /^[0-9]{4}$/

export default function PaymentSources() {
  const [sources, setSources] = useState<PaymentSource[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add-dialog state
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [addName, setAddName] = useState('')
  const [addCardLastFour, setAddCardLastFour] = useState('')
  const [adding, setAdding] = useState(false)

  // Edit state — inline editing within the list, not a separate dialog
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editCardLastFour, setEditCardLastFour] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchSources = useCallback(async () => {
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      setCurrentUserId(user?.id ?? null)

      const { data, error: fetchError } = await supabase
        .from('payment_sources')
        .select('*')
        .order('name')

      if (fetchError) {
        setError('Failed to load payment sources.')
      } else if (data) {
        setSources(data as PaymentSource[])
      }
    } catch {
      setError('Failed to load payment sources.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  // Split into "yours" and "shared" so the UI can present them differently.
  // Shared rows go below "yours" because they're typically what the user
  // cares about less (they can't edit them).
  const { ownSources, sharedSources } = useMemo(() => {
    const own: PaymentSource[] = []
    const shared: PaymentSource[] = []
    for (const s of sources) {
      if (s.user_id === currentUserId) own.push(s)
      else shared.push(s)
    }
    return { ownSources: own, sharedSources: shared }
  }, [sources, currentUserId])

  // ─── Add ───────────────────────────────────────────────────────────────────

  const validateForm = (name: string, last4: string): string | null => {
    if (!name.trim()) return 'Name is required.'
    if (name.trim().length > 100) return 'Name must be 100 characters or fewer.'
    if (last4 && !CARD_LAST_FOUR_RE.test(last4)) {
      return 'Card last 4 digits must be exactly 4 digits, or left blank.'
    }
    return null
  }

  const handleAdd = async () => {
    const trimmedName = addName.trim()
    const trimmedLast4 = addCardLastFour.trim()
    const validationError = validateForm(trimmedName, trimmedLast4)
    if (validationError) {
      setError(validationError)
      return
    }
    if (!currentUserId) {
      setError('Not signed in.')
      return
    }
    setError(null)
    setAdding(true)
    try {
      const { data, error: insertError } = await supabase
        .from('payment_sources')
        .insert([{
          user_id: currentUserId,
          name: trimmedName,
          card_last_four: trimmedLast4 || null,
        }])
        .select()
        .single()

      if (insertError || !data) {
        // Most likely failure mode: the Phase 1 migration's RLS INSERT policy
        // hasn't been applied yet, so the insert is denied. Surface a helpful
        // message rather than a generic error.
        if (insertError?.code === '42501' /* insufficient_privilege */) {
          setError('Database permissions need updating — re-run the Phase 1 migration.')
        } else if (insertError?.code === '23505' /* unique_violation */) {
          setError('A payment source with that card number already exists.')
        } else {
          setError('Failed to add payment source. Please try again.')
        }
        return
      }

      setSources(prev => [...prev, data as PaymentSource].sort((a, b) => a.name.localeCompare(b.name)))
      setShowAddDialog(false)
      setAddName('')
      setAddCardLastFour('')
    } catch {
      setError('Failed to add payment source. Please try again.')
    } finally {
      setAdding(false)
    }
  }

  // ─── Edit (inline) ─────────────────────────────────────────────────────────

  const startEdit = (source: PaymentSource) => {
    setEditingId(source.id)
    setEditName(source.name)
    setEditCardLastFour(source.card_last_four ?? '')
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
    setEditCardLastFour('')
    setError(null)
  }

  const handleSaveEdit = async (id: string) => {
    const trimmedName = editName.trim()
    const trimmedLast4 = editCardLastFour.trim()
    const validationError = validateForm(trimmedName, trimmedLast4)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setSavingId(id)
    try {
      const { data, error: updateError } = await supabase
        .from('payment_sources')
        .update({
          name: trimmedName,
          card_last_four: trimmedLast4 || null,
        })
        .eq('id', id)
        .select()
        .single()

      if (updateError || !data) {
        setError('Failed to update payment source. Please try again.')
        return
      }

      setSources(prev =>
        prev.map(s => (s.id === id ? (data as PaymentSource) : s))
          .sort((a, b) => a.name.localeCompare(b.name))
      )
      cancelEdit()
    } catch {
      setError('Failed to update payment source. Please try again.')
    } finally {
      setSavingId(null)
    }
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    setError(null)
    try {
      const { error: deleteError } = await supabase
        .from('payment_sources')
        .delete()
        .eq('id', id)

      if (deleteError) {
        setError('Failed to delete payment source. It may be in use by existing transactions.')
        return
      }

      setSources(prev => prev.filter(s => s.id !== id))
      setConfirmDeleteId(null)
    } catch {
      setError('Failed to delete payment source.')
    } finally {
      setDeletingId(null)
    }
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  const renderRow = (source: PaymentSource, editable: boolean) => {
    const isEditing = editable && editingId === source.id
    const isSaving = savingId === source.id
    const isDeleting = deletingId === source.id

    if (isEditing) {
      return (
        <div key={source.id} className="border rounded-md p-3 space-y-2 bg-muted/30">
          <div className="space-y-2">
            <Input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Name (e.g. Chase Sapphire)"
              maxLength={100}
              disabled={isSaving}
            />
            <Input
              value={editCardLastFour}
              onChange={e => setEditCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="Last 4 digits (optional, e.g. 1234)"
              inputMode="numeric"
              maxLength={4}
              disabled={isSaving}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
            <Button size="sm" onClick={() => handleSaveEdit(source.id)} disabled={isSaving}>
              <Save className="h-3 w-3 mr-1" /> {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div key={source.id} className="border rounded-md p-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <CreditCard className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-medium truncate">{source.name}</div>
            <div className="text-xs text-muted-foreground">
              {source.card_last_four ? `Card •• ${source.card_last_four}` : 'No card number'}
              {!editable && <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-muted text-[10px] uppercase tracking-wide">shared</span>}
            </div>
          </div>
        </div>
        {editable && (
          <div className="flex gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startEdit(source)}
              title="Edit"
              disabled={isDeleting}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDeleteId(source.id)}
              title="Delete"
              disabled={isDeleting}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage the cards and accounts you pay with. Set <strong>Card last 4</strong> on each so Wallet payments auto-route to the right one.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Your sources */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Your payment sources</h3>
          <Button size="sm" onClick={() => { setShowAddDialog(true); setError(null) }}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>
        {ownSources.length === 0 ? (
          <div className="text-sm text-muted-foreground border rounded-md p-4 text-center">
            You haven&apos;t added any cards yet. Click <strong>Add</strong> to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {ownSources.map(s => renderRow(s, true))}
          </div>
        )}
      </div>

      {/* Shared sources (legacy) */}
      {sharedSources.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Shared (legacy)</h3>
          <p className="text-xs text-muted-foreground">
            These existed before per-user scoping was added. You can use them in transactions but can&apos;t edit or delete them. If you need to rename one, recreate it under <em>Your payment sources</em> with the same card last-4.
          </p>
          <div className="space-y-2">
            {sharedSources.map(s => renderRow(s, false))}
          </div>
        </div>
      )}

      {/* Add dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => {
        setShowAddDialog(open)
        if (!open) { setAddName(''); setAddCardLastFour(''); setError(null) }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Payment Source</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="ps-add-name">Name</Label>
              <Input
                id="ps-add-name"
                value={addName}
                onChange={e => setAddName(e.target.value)}
                placeholder="Chase Sapphire"
                maxLength={100}
                autoFocus
                disabled={adding}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ps-add-last4">
                Card last 4 digits <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="ps-add-last4"
                value={addCardLastFour}
                onChange={e => setAddCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="1234"
                inputMode="numeric"
                maxLength={4}
                disabled={adding}
              />
              <p className="text-xs text-muted-foreground">
                The 4 digits Google Wallet shows in its notification when you pay with this card. Used to auto-route Wallet payments to this source.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)} disabled={adding}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding || !addName.trim()}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Payment Source?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Existing transactions that reference this payment source will keep their reference but it won&apos;t resolve to anything in dropdowns. This can&apos;t be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)} disabled={deletingId !== null}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}
              disabled={deletingId !== null}
            >
              {deletingId !== null ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
