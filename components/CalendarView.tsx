'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase'
import { Transaction } from '@/types'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth, startOfWeek, endOfWeek, addMonths, subMonths, startOfYear, endOfYear, eachMonthOfInterval, eachWeekOfInterval, getYear } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CalendarView as CalendarViewType } from '@/types'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'

export default function CalendarView() {
  const [view, setView] = useState<CalendarViewType>('month')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [paymentSourceMap, setPaymentSourceMap] = useState<Record<string, string>>({})
  const { currency } = useCurrency()

  useEffect(() => {
    loadCategoriesAndSources()
    loadTransactions()
  }, [currentDate, view])

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
    let start: Date
    let end: Date

    if (view === 'month') {
      start = startOfMonth(currentDate)
      end = endOfMonth(currentDate)
    } else if (view === 'day') {
      start = currentDate
      end = currentDate
    } else {
      start = startOfYear(currentDate)
      end = endOfYear(currentDate)
    }

    const { data } = await supabase
      .from('transactions')
      .select('*')
      .gte('date', format(start, 'yyyy-MM-dd'))
      .lte('date', format(end, 'yyyy-MM-dd'))
      .order('date', { ascending: false })

    setTransactions(data || [])
  }

  const getTransactionsForDate = (date: Date) => {
    return transactions.filter(t => isSameDay(new Date(t.date), date))
  }

  const getTotalForDate = (date: Date) => {
    const dayTransactions = getTransactionsForDate(date)
    const income = dayTransactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0)
    const expenses = dayTransactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0)
    return { income, expenses, net: income - expenses }
  }

  const renderMonthView = () => {
    const monthStart = startOfMonth(currentDate)
    const monthEnd = endOfMonth(currentDate)
    const calendarStart = startOfWeek(monthStart)
    const calendarEnd = endOfWeek(monthEnd)
    const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd })

    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-7 gap-1">
          {weekDays.map((day) => (
            <div key={day} className="p-2 text-center text-sm font-medium text-muted-foreground">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((day) => {
            const isCurrentMonth = isSameMonth(day, currentDate)
            const totals = getTotalForDate(day)
            const isSelected = selectedDate && isSameDay(day, selectedDate)

            return (
              <div
                key={day.toISOString()}
                className={`min-h-[80px] p-1 border rounded cursor-pointer hover:bg-muted transition-colors ${
                  !isCurrentMonth ? 'opacity-40' : ''
                } ${isSelected ? 'ring-2 ring-primary' : ''}`}
                onClick={() => setSelectedDate(day)}
              >
                <div className="text-sm font-medium mb-1">
                  {format(day, 'd')}
                </div>
                {totals.net !== 0 && (
                  <div className={`text-xs ${
                    totals.net > 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {formatCurrency(Math.abs(totals.net), currency)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const renderDayView = () => {
    const dayTransactions = getTransactionsForDate(currentDate)

    return (
      <div className="space-y-4">
        <div className="text-center">
          <h3 className="text-2xl font-bold">{format(currentDate, 'EEEE, MMMM d, yyyy')}</h3>
        </div>
        <div className="space-y-2">
          {dayTransactions.length === 0 ? (
            <p className="text-center text-muted-foreground">No transactions for this day</p>
          ) : (
            dayTransactions.map((transaction) => (
              <Card key={transaction.id}>
                <CardContent className="p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold">{categoryMap[transaction.category] || transaction.category}</div>
                      <div className="text-sm text-muted-foreground">
                        {paymentSourceMap[transaction.payment_source] || transaction.payment_source}
                      </div>
                      {transaction.notes && (
                        <div className="text-sm mt-1">{transaction.notes}</div>
                      )}
                    </div>
                    <div className={`font-bold ${
                      transaction.type === 'income' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {transaction.type === 'income' ? '+' : '-'}{formatCurrency(transaction.amount, currency)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    )
  }

  const renderYearView = () => {
    const yearStart = startOfYear(currentDate)
    const yearEnd = endOfYear(currentDate)
    const months = eachMonthOfInterval({ start: yearStart, end: yearEnd })

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {months.map((month) => {
          const monthTransactions = transactions.filter(t => {
            const tDate = new Date(t.date)
            return isSameMonth(tDate, month)
          })
          const monthIncome = monthTransactions
            .filter(t => t.type === 'income')
            .reduce((sum, t) => sum + t.amount, 0)
          const monthExpenses = monthTransactions
            .filter(t => t.type === 'expense')
            .reduce((sum, t) => sum + t.amount, 0)

          return (
            <Card
              key={month.toISOString()}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => {
                setCurrentDate(month)
                setView('month')
              }}
            >
              <CardHeader>
                <CardTitle>{format(month, 'MMMM')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Income</span>
                    <span className="text-sm font-semibold text-green-600">
                      {formatCurrency(monthIncome, currency)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-muted-foreground">Expenses</span>
                    <span className="text-sm font-semibold text-red-600">
                      {formatCurrency(monthExpenses, currency)}
                    </span>
                  </div>
                  <div className="flex justify-between border-t pt-2">
                    <span className="text-sm font-medium">Net</span>
                    <span className={`text-sm font-bold ${
                      monthIncome - monthExpenses >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatCurrency(monthIncome - monthExpenses, currency)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant={view === 'month' ? 'default' : 'outline'}
            onClick={() => setView('month')}
          >
            Month
          </Button>
          <Button
            variant={view === 'day' ? 'default' : 'outline'}
            onClick={() => setView('day')}
          >
            Day
          </Button>
          <Button
            variant={view === 'year' ? 'default' : 'outline'}
            onClick={() => setView('year')}
          >
            Year
          </Button>
        </div>

        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              if (view === 'month') setCurrentDate(subMonths(currentDate, 1))
              else if (view === 'day') setCurrentDate(subMonths(currentDate, 1))
              else setCurrentDate(subMonths(currentDate, 12))
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-lg font-semibold min-w-[200px] text-center">
            {view === 'month' && format(currentDate, 'MMMM yyyy')}
            {view === 'day' && format(currentDate, 'MMMM d, yyyy')}
            {view === 'year' && format(currentDate, 'yyyy')}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              if (view === 'month') setCurrentDate(addMonths(currentDate, 1))
              else if (view === 'day') setCurrentDate(addMonths(currentDate, 1))
              else setCurrentDate(addMonths(currentDate, 12))
            }}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={() => setCurrentDate(new Date())}
          >
            Today
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          {view === 'month' && renderMonthView()}
          {view === 'day' && renderDayView()}
          {view === 'year' && renderYearView()}
        </CardContent>
      </Card>

      {selectedDate && view === 'month' && (
        <Card>
          <CardHeader>
            <CardTitle>Transactions for {format(selectedDate, 'MMMM d, yyyy')}</CardTitle>
          </CardHeader>
          <CardContent>
            {getTransactionsForDate(selectedDate).length === 0 ? (
              <p className="text-muted-foreground">No transactions for this day</p>
            ) : (
              <div className="space-y-2">
                {getTransactionsForDate(selectedDate).map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex justify-between items-center p-3 border rounded"
                  >
                    <div>
                      <div className="font-semibold">{categoryMap[transaction.category] || transaction.category}</div>
                      {transaction.notes && (
                        <div className="text-sm text-muted-foreground">{transaction.notes}</div>
                      )}
                    </div>
                    <div className={`font-bold ${
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
      )}
    </div>
  )
}

