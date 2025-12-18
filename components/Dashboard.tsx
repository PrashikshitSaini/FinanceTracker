'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { Transaction } from '@/types'
import { format, startOfMonth, endOfMonth, subMonths, addMonths } from 'date-fns'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, Edit, Trash2 } from 'lucide-react'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'

interface DashboardProps {
  showTableOnly?: boolean
}

export default function Dashboard({ showTableOnly = false }: DashboardProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [loading, setLoading] = useState(true)
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [paymentSourceMap, setPaymentSourceMap] = useState<Record<string, string>>({})
  const { currency } = useCurrency()

  useEffect(() => {
    loadCategoriesAndSources()
    loadTransactions()
  }, [currentMonth])

  const loadCategoriesAndSources = async () => {
    const [categoriesResult, sourcesResult] = await Promise.all([
      supabase.from('categories').select('id, name'),
      supabase.from('payment_sources').select('id, name')
    ])

    if (categoriesResult.data) {
      const map: Record<string, string> = {}
      categoriesResult.data.forEach(cat => {
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
      console.error('Error loading transactions:', error)
    } else {
      setTransactions(data || [])
    }
    setLoading(false)
  }

  const deleteTransaction = async (id: string) => {
    if (!confirm('Are you sure you want to delete this transaction?')) return

    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting transaction:', error)
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
                <th className="text-left p-2">Amount</th>
                <th className="text-left p-2">Notes</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted-foreground">
                    Loading...
                  </td>
                </tr>
              ) : transactions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted-foreground">
                    No transactions found
                  </td>
                </tr>
              ) : (
                transactions.map((transaction) => (
                  <tr key={transaction.id} className="border-b hover:bg-muted/50">
                    <td className="p-2">{format(new Date(transaction.date), 'MMM dd, yyyy')}</td>
                    <td className="p-2">
                      <span className={`px-2 py-1 rounded text-xs ${
                        transaction.type === 'income' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {transaction.type}
                      </span>
                    </td>
                    <td className="p-2">{categoryMap[transaction.category] || transaction.category}</td>
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
                          onClick={() => {
                            // TODO: Open edit form
                          }}
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
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">
          {format(currentMonth, 'MMMM yyyy')}
        </h2>
        <div className="flex gap-2">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Expenses by Category</CardTitle>
          </CardHeader>
          <CardContent>
            {categoryData.length === 0 ? (
              <p className="text-muted-foreground">No expenses this month</p>
            ) : (
              <div className="space-y-4">
                {categoryData.map((item) => {
                  const percentage = (item.amount / totalExpenses) * 100
                  return (
                    <div key={item.category} className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span>{item.category}</span>
                        <span className="font-semibold">{formatCurrency(item.amount, currency)}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className="bg-primary h-2 rounded-full transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
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
              <div className="space-y-2">
                {transactions.slice(0, 5).map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex justify-between items-center p-2 border rounded hover:bg-muted/50"
                  >
                    <div className="flex-1">
                      <div className="font-medium">{categoryMap[transaction.category] || transaction.category}</div>
                      <div className="text-sm text-muted-foreground">
                        {format(new Date(transaction.date), 'MMM dd')}
                      </div>
                    </div>
                    <div className={`font-semibold ${
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
    </div>
  )
}

