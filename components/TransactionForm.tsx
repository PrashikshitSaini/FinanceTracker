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
  const [errors, setErrors] = useState<Record<string, string>>({})

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
    setErrors({})
  }

  // Client-side validation
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {}

    // Validate amount
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      newErrors.amount = 'Amount must be greater than 0'
    } else if (amountNum > 1000000000) {
      newErrors.amount = 'Amount exceeds maximum limit (1 billion)'
    }

    // Validate category
    if (!category) {
      newErrors.category = 'Please select a category'
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(category)) {
      newErrors.category = 'Invalid category selected'
    }

    // Validate payment source
    if (!paymentSource) {
      newErrors.paymentSource = 'Please select a payment source'
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentSource)) {
      newErrors.paymentSource = 'Invalid payment source selected'
    }

    // Validate date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(date)) {
      newErrors.date = 'Date must be in YYYY-MM-DD format'
    } else {
      const transactionDate = new Date(date)
      const minDate = new Date('1900-01-01')
      const maxDate = new Date()
      maxDate.setFullYear(maxDate.getFullYear() + 1) // Allow up to 1 year in the future

      if (transactionDate < minDate || transactionDate > maxDate || isNaN(transactionDate.getTime())) {
        newErrors.date = 'Date must be between 1900-01-01 and 1 year from today'
      }
    }

    // Validate notes length
    if (notes && notes.length > 1000) {
      newErrors.notes = 'Notes cannot exceed 1000 characters'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    // Client-side validation
    if (!validateForm()) {
      return
    }

    setLoading(true)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) {
        alert('You must be logged in to add transactions')
        setLoading(false)
        return
      }

      const transactionData = {
        amount: parseFloat(amount),
        category,
        payment_source: paymentSource,
        notes: notes.trim() || null,
        image_url: imageUrl || null,
        date,
        type,
      }

      // Use API route for server-side validation
      const url = transaction 
        ? '/api/transactions'
        : '/api/transactions'
      
      const method = transaction ? 'PUT' : 'POST'
      const body = transaction 
        ? { id: transaction.id, ...transactionData }
        : transactionData

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        credentials: 'include',
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        let result
        try {
          result = await response.json()
        } catch (e) {
          throw new Error(`Failed to save transaction: ${response.status} ${response.statusText}`)
        }
        
        // Handle validation errors from server
        if (response.status === 400 && result.details) {
          const serverErrors: Record<string, string> = {}
          result.details.forEach((detail: { path: string; message: string }) => {
            serverErrors[detail.path] = detail.message
          })
          setErrors(serverErrors)
          alert(result.error || 'Please fix the errors and try again.')
          return
        }
        throw new Error(result.error || 'Failed to save transaction')
      }

      const result = await response.json()

      resetForm()
      onOpenChange(false)
      window.location.reload()
    } catch (error) {
      // Log error without exposing transaction data
      if (process.env.NODE_ENV === 'development') {
        console.error('Error saving transaction:', error instanceof Error ? error.message : 'Unknown error')
      }
      alert(error instanceof Error ? error.message : 'Error saving transaction. Please try again.')
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
                min="0.01"
                max="1000000000"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  if (errors.amount) setErrors({ ...errors, amount: '' })
                }}
                required
              />
              {errors.amount && (
                <p className="text-sm text-red-600 mt-1">{errors.amount}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="category">Category</Label>
              <Select
                id="category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value)
                  if (errors.category) setErrors({ ...errors, category: '' })
                }}
                required
              >
                <option value="">Select category</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </Select>
              {errors.category && (
                <p className="text-sm text-red-600 mt-1">{errors.category}</p>
              )}
            </div>

            <div>
              <Label htmlFor="paymentSource">Payment Source</Label>
              <Select
                id="paymentSource"
                value={paymentSource}
                onChange={(e) => {
                  setPaymentSource(e.target.value)
                  if (errors.paymentSource) setErrors({ ...errors, paymentSource: '' })
                }}
                required
              >
                <option value="">Select source</option>
                {paymentSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
              {errors.paymentSource && (
                <p className="text-sm text-red-600 mt-1">{errors.paymentSource}</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="date">Date</Label>
            <Input
              id="date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value)
                if (errors.date) setErrors({ ...errors, date: '' })
              }}
              min="1900-01-01"
              max={new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0]}
              required
            />
            {errors.date && (
              <p className="text-sm text-red-600 mt-1">{errors.date}</p>
            )}
          </div>

          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => {
                const value = e.target.value
                // Limit to 1000 characters
                if (value.length <= 1000) {
                  setNotes(value)
                  if (errors.notes) setErrors({ ...errors, notes: '' })
                }
              }}
              placeholder="Add any notes about this transaction..."
              rows={3}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {notes.length}/1000 characters
            </p>
            {errors.notes && (
              <p className="text-sm text-red-600 mt-1">{errors.notes}</p>
            )}
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

