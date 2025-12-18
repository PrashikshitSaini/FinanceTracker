'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { supabase } from '@/lib/supabase'
import { Camera, Image as ImageIcon, X } from 'lucide-react'
import ImageUpload from './ImageUpload'
import { Transaction } from '@/types'

interface TransactionFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction?: Transaction
}

export default function TransactionForm({ open, onOpenChange, transaction }: TransactionFormProps) {
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [paymentSource, setPaymentSource] = useState('')
  const [notes, setNotes] = useState('')
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [paymentSources, setPaymentSources] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      loadCategories()
      loadPaymentSources()
      if (transaction) {
        setAmount(transaction.amount.toString())
        setCategory(transaction.category)
        setPaymentSource(transaction.payment_source)
        setNotes(transaction.notes || '')
        setType(transaction.type)
        setDate(transaction.date)
        setImageUrl(transaction.image_url || null)
      } else {
        resetForm()
      }
    }
  }, [open, transaction])

  const loadCategories = async () => {
    const { data } = await supabase.from('categories').select('*').order('name')
    if (data) setCategories(data)
  }

  const loadPaymentSources = async () => {
    const { data } = await supabase.from('payment_sources').select('*').order('name')
    if (data) setPaymentSources(data)
  }

  const resetForm = () => {
    setAmount('')
    setCategory('')
    setPaymentSource('')
    setNotes('')
    setType('expense')
    setDate(new Date().toISOString().split('T')[0])
    setImageUrl(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        alert('You must be logged in to add transactions')
        return
      }

      const transactionData = {
        amount: parseFloat(amount),
        category,
        payment_source: paymentSource,
        notes: notes || null,
        image_url: imageUrl,
        date,
        type,
        user_id: user.id,
      }

      if (transaction) {
        await supabase
          .from('transactions')
          .update(transactionData)
          .eq('id', transaction.id)
      } else {
        await supabase.from('transactions').insert([transactionData])
      }

      resetForm()
      onOpenChange(false)
      window.location.reload()
    } catch (error) {
      console.error('Error saving transaction:', error)
      alert('Error saving transaction. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{transaction ? 'Edit Transaction' : 'Add Transaction'}</DialogTitle>
          <DialogClose onClose={() => onOpenChange(false)} />
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="type">Type</Label>
              <Select
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value as 'income' | 'expense')}
                required
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </Select>
            </div>

            <div>
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="category">Category</Label>
              <Select
                id="category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                required
              >
                <option value="">Select category</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="paymentSource">Payment Source</Label>
              <Select
                id="paymentSource"
                value={paymentSource}
                onChange={(e) => setPaymentSource(e.target.value)}
                required
              >
                <option value="">Select source</option>
                {paymentSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="date">Date</Label>
            <Input
              id="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any notes about this transaction..."
              rows={3}
            />
          </div>

          <div>
            <Label>Receipt/Image</Label>
            <ImageUpload
              currentImageUrl={imageUrl}
              onImageUploaded={setImageUrl}
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : transaction ? 'Update' : 'Add Transaction'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

