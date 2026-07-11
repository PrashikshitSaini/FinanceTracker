'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { Transaction } from '@/types'
import { format, startOfMonth, endOfMonth, subMonths, addMonths } from 'date-fns'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, Edit, Trash2, Repeat, ArrowRight, Camera } from 'lucide-react'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'
import { parseLocalDate } from '@/lib/utils'
import ReceiptScanner from '@/components/ReceiptScanner'
import CategoryPieChart from '@/components/CategoryPieChart'
import TransactionForm from '@/components/TransactionForm'
import TopSavingsCard from '@/components/TopSavingsCard'

interface DashboardProps {
  showTableOnly?: boolean
  /**
   * Optional handler for the "View all" link on the Top Savings card.
   * Passed through from the page so clicking jumps to the Savings tab.
   */
  onNavigateToSavings?: () => void
  /** Optional handler for the subscriptions shortcut card. */
  onNavigateToSubscriptions?: () => void
}

export default function Dashboard({
  showTableOnly = false,
  onNavigateToSavings,
  onNavigateToSubscriptions,
}: DashboardProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [loading, setLoading] = useState(true)
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [paymentSourceMap, setPaymentSourceMap] = useState<Record<string, string>>({})
  const [showReceiptScanner, setShowReceiptScanner] = useState(false)
  // Per-row "saving" indicator for the category dropdown — disables the select
  // for the row currently being updated to prevent double-fires.
  const [updatingCategoryId, setUpdatingCategoryId] = useState<string | null>(null)
  // Transaction currently being edited via the Edit pencil button. The
  // existing TransactionForm component accepts an optional `transaction` prop
  // and re-uses the same form for both add and edit flows, so we just hand
  // it a transaction and open it.
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null)
  const { currency } = useCurrency()

  useEffect(() => {
    loadCategoriesAndSources()
    loadTransactions()
  }, [currentMonth])

  // Finn (the AI bubble) dispatches `finn:transactions-changed` after it logs,
  // updates, or deletes a transaction via tool calling. Refresh the current
  // month so the change shows without a manual reload.
  useEffect(() => {
    const handler = () => loadTransactions()
    window.addEventListener('finn:transactions-changed', handler)
    return () => window.removeEventListener('finn:transactions-changed', handler)
  }, [currentMonth])

  const loadCategoriesAndSources = async () => {
    const [categoriesResult, sourcesResult] = await Promise.all([
      supabase.from('categories').select('id, name'),
      supabase.from('payment_sources').select('id, name')
    ])

    if (categoriesResult.data) {
      // Sort alphabetically so the inline dropdown order is predictable.
      const sorted = [...categoriesResult.data].sort((a, b) => a.name.localeCompare(b.name))
      setCategories(sorted)
      const map: Record<string, string> = {}
      sorted.forEach(cat => {
        map[cat.id] = cat.name
      })
      setCategoryMap(map)
    }

    if (sourcesResult.data) {
      const map: Record<string, string> = {}
      sourcesResult.data.forEach(source => {
        map[source.id] = source.name
      })
      setPaymentSourceMap(map)
    }
  }

  const loadTransactions = async () => {
    setLoading(true)
    const start = startOfMonth(currentMonth)
    const end = endOfMonth(currentMonth)

    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .gte('date', format(start, 'yyyy-MM-dd'))
      .lte('date', format(end, 'yyyy-MM-dd'))
      .order('date', { ascending: false })

    if (error) {
      // Log error without exposing transaction data or user information
      if (process.env.NODE_ENV === 'development') {
        console.error('Error loading transactions:', error.message || 'Unknown error')
      }
    } else {
      setTransactions(data || [])
    }
    setLoading(false)
  }

  /**
   * Inline-edit a transaction's category. The change cascades through the
   * shared `transactions` state, so the pie chart, recent-transactions card,
   * totals, and any opened statement page all reflect the new category
   * without an extra refetch. RLS in the DB enforces that the user can only
   * update their own rows; we don't need an extra ownership check here.
   *
   * Optimistic: state flips immediately. On API error we revert and show an
   * alert (matching the existing deleteTransaction UX).
   */
  const updateTransactionCategory = async (transactionId: string, newCategoryId: string) => {
    const previous = transactions.find(t => t.id === transactionId)?.category
    if (!previous || previous === newCategoryId) return

    setUpdatingCategoryId(transactionId)
    setTransactions(prev =>
      prev.map(t => (t.id === transactionId ? { ...t, category: newCategoryId } : t))
    )

    const { error } = await supabase
      .from('transactions')
      .update({ category: newCategoryId })
      .eq('id', transactionId)

    setUpdatingCategoryId(null)

    if (error) {
      // Revert the optimistic change so the UI matches DB state.
      setTransactions(prev =>
        prev.map(t => (t.id === transactionId ? { ...t, category: previous } : t))
      )
      if (process.env.NODE_ENV === 'development') {
        console.error('Update category error:', error.message || 'Unknown error')
      }
      alert('Failed to update category. Please try again.')
    }
  }

  const deleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return

    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id)

    if (error) {
      // Log error without exposing transaction details
      if (process.env.NODE_ENV === 'development') {
        console.error('Error deleting transaction:', error.message || 'Unknown error')
      }
      alert('Error deleting transaction')
    } else {
      loadTransactions()
    }
  }

  const totalIncome = transactions
    .filter(t => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0)

  const totalExpenses = transactions
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0)

  const netAmount = totalIncome - totalExpenses

  const categoryExpenses = transactions
    .filter(t => t.type === 'expense')
    .reduce((acc, t) => {
      const categoryName = categoryMap[t.category] || t.category
      acc[categoryName] = (acc[categoryName] || 0) + t.amount
      return acc
    }, {} as Record<string, number>)

  const categoryData = Object.entries(categoryExpenses).map(([category, amount]) => ({
    category,
    amount,
  })).sort((a, b) => b.amount - a.amount)

  // Same expenses, grouped by the payment source (card) instead of category.
  // Both breakdowns sum to totalExpenses since every expense has exactly one
  // category and one payment source. Falls back to the raw id if a source
  // name isn't loaded (e.g. a legacy row), mirroring the category fallback.
  const paymentSourceExpenses = transactions
    .filter(t => t.type === 'expense')
    .reduce((acc, t) => {
      const sourceName = paymentSourceMap[t.payment_source] || t.payment_source
      acc[sourceName] = (acc[sourceName] || 0) + t.amount
      return acc
    }, {} as Record<string, number>)

  const paymentSourceData = Object.entries(paymentSourceExpenses).map(([category, amount]) => ({
    category,
    amount,
  })).sort((a, b) => b.amount - a.amount)

  if (showTableOnly) {
    return (
      <div className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b">
                <th className="text-left p-2">Date</th>
                <th className="text-left p-2">Type</th>
                <th className="text-left p-2">Category</th>
                <th className="text-left p-2">Payment Source</th>
                <th className="text-left p-2">Amount</th>
                <th className="text-left p-2">Notes</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">
                    Loading...
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">
                    No transactions found
                  </td>
                </tr>
              ) : (
                transactions.map((transaction) => (
                  <tr key={transaction.id} className="border-b hover:bg-muted/50">
                    <td className="p-2 whitespace-nowrap">
                      <div>{format(parseLocalDate(transaction.date), 'MMM dd, yyyy')}</div>
                      {transaction.created_at && (
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(transaction.created_at), 'h:mm a')}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      <span className={`px-2 py-1 rounded text-xs ${
                        transaction.type === 'income'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {transaction.type}
                      </span>
                    </td>
                    <td className="p-2">
                      <select
                        value={transaction.category}
                        onChange={e => updateTransactionCategory(transaction.id, e.target.value)}
                        disabled={updatingCategoryId === transaction.id}
                        aria-label="Change category"
                        className="bg-background border border-input rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring max-w-[180px] disabled:opacity-50"
                      >
                        {/* Fallback: if the current category isn't in the list
                            (e.g., row's category was deleted globally), show
                            it as a non-recoverable option so we don't display
                            a blank select. */}
                        {!categories.some(c => c.id === transaction.category) && (
                          <option value={transaction.category}>
                            {categoryMap[transaction.category] || transaction.category}
                          </option>
                        )}
                        {categories.map(c => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-sm">
                      {paymentSourceMap[transaction.payment_source] || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 font-semibold">
                      {formatCurrency(transaction.amount, currency)}
                    </td>
                    <td className="p-2 text-sm text-muted-foreground max-w-xs truncate">
                      {transaction.notes || '-'}
                    </td>
                    <td className="p-2">
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingTransaction(transaction)}
                          title="Edit transaction"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteTransaction(transaction.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* Edit dialog — opens when the pencil icon is clicked on a row.
            TransactionForm is the same component used for Add, just primed
            with the existing transaction's values. We refresh on close so
            edits propagate to the pie chart, totals, etc. */}
        <TransactionForm
          open={editingTransaction !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              setEditingTransaction(null)
              loadTransactions()
            }
          }}
          transaction={editingTransaction ?? undefined}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h2 className="text-2xl font-bold">
          {format(currentMonth, 'MMMM yyyy')}
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="default"
            onClick={() => setShowReceiptScanner(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Camera className="h-4 w-4 mr-2" />
            Scan Receipt
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={() => setCurrentMonth(new Date())}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentMonth(subMonths(currentMonth, -1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Income
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(totalIncome, currency)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {formatCurrency(totalExpenses, currency)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net Amount
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${
              netAmount >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {formatCurrency(netAmount, currency)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top 3 most-recently-active savings goals. Hides itself if none. */}
      <TopSavingsCard onViewAll={onNavigateToSavings} />

      <Card className="bg-gradient-to-r from-purple-50 to-indigo-50 dark:from-purple-950/20 dark:to-indigo-950/20 border-purple-200 dark:border-purple-800">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-start sm:items-center gap-3 sm:gap-4 flex-1 min-w-0">
              <div className="flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center">
                <Repeat className="h-5 w-5 sm:h-6 sm:w-6 text-purple-600 dark:text-purple-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base sm:text-lg font-semibold mb-1">Track Your Subscriptions</h3>
                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                  Keep active recurring expenses in one place. Due charges are added to your regular transaction history automatically.
                </p>
              </div>
            </div>
            <Button
              onClick={onNavigateToSubscriptions}
              className="w-full sm:w-auto bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center gap-2 text-sm sm:text-base px-4 py-2 sm:px-4 sm:py-2"
            >
              <span className="hidden sm:inline">Manage Subscriptions</span>
              <span className="sm:hidden">Subscriptions</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Expenses by Category</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <CategoryPieChart data={categoryData} total={totalExpenses} label="category" />
            {paymentSourceData.length > 0 && (
              <div className="border-t pt-6 space-y-4">
                <CardTitle className="text-base">Expenses by Payment Source</CardTitle>
                <CategoryPieChart data={paymentSourceData} total={totalExpenses} label="payment source" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-muted-foreground">Loading...</p>
            ) : transactions.length === 0 ? (
              <p className="text-muted-foreground">No transactions this month</p>
            ) : (
              // Up to 15 most-recent transactions, scrollable inside the card
              // so the card height stays predictable next to the pie chart
              // alongside it. max-h sized to fit ~5 rows comfortably before
              // scroll kicks in; the rest scrolls inside the container.
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {transactions.slice(0, 15).map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex justify-between items-center p-2 border rounded hover:bg-muted/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{categoryMap[transaction.category] || transaction.category}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {format(parseLocalDate(transaction.date), 'MMM dd')}
                        {transaction.created_at && (
                          <> &middot; {format(new Date(transaction.created_at), 'h:mm a')}</>
                        )}
                        {paymentSourceMap[transaction.payment_source] && (
                          <> &middot; {paymentSourceMap[transaction.payment_source]}</>
                        )}
                      </div>
                    </div>
                    <div className={`font-semibold flex-shrink-0 ml-2 ${
                      transaction.type === 'income' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {transaction.type === 'income' ? '+' : '-'}{formatCurrency(transaction.amount, currency)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ReceiptScanner
        open={showReceiptScanner}
        onOpenChange={setShowReceiptScanner}
        onTransactionAdded={() => {
          loadTransactions()
          loadCategoriesAndSources()
        }}
      />
      {/* Edit dialog for the full-dashboard view — also used by inline pencil
          icon if the user ever lands here. Refreshes data on close. */}
      <TransactionForm
        open={editingTransaction !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setEditingTransaction(null)
            loadTransactions()
          }
        }}
        transaction={editingTransaction ?? undefined}
      />
    </div>
  )
}
