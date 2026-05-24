'use client'

import { Suspense, useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Transaction } from '@/types'
import { format, startOfMonth, endOfMonth, parse } from 'date-fns'
import { formatCurrency } from '@/lib/currency'
import { useCurrency } from '@/contexts/CurrencyContext'
import { parseLocalDate } from '@/lib/utils'

/**
 * Monthly statement page — print-styled HTML.
 *
 * Opens in its own tab from the Dashboard's "Export Statement" button. The
 * user picks a month (default: current), and the page renders:
 *   - Header (app + user + month range)
 *   - Summary card (income / expenses / net)
 *   - Category breakdown table
 *   - Transactions table (all rows, sorted oldest → newest for statement-style
 *     reading)
 *
 * To save as PDF: just hit Cmd/Ctrl-P. The print stylesheet (`globals.css`
 * @media print rules below — inlined here so this page is self-contained)
 * hides the on-screen controls so only the statement body prints.
 *
 * Designed to be readable by both humans AND AI agents — tables have
 * consistent column ordering and no purely-decorative content.
 */

/**
 * Outer page = thin Suspense wrapper. Required because StatementContent uses
 * `useSearchParams()`, which Next.js 14 forces under a Suspense boundary in
 * order to support static prerendering — without it `next build` fails with
 * "useSearchParams() should be wrapped in a suspense boundary". The wrapper
 * pattern lets the page prerender a fallback shell while the client hydrates
 * the URL-dependent content.
 */
export default function StatementPage() {
  return (
    <Suspense fallback={<StatementLoading />}>
      <StatementContent />
    </Suspense>
  )
}

function StatementLoading() {
  return (
    <div className="bg-white text-black min-h-screen flex items-center justify-center">
      <p className="text-gray-500 text-sm">Loading statement…</p>
    </div>
  )
}

function StatementContent() {
  const searchParams = useSearchParams()
  const { currency } = useCurrency()

  // Default to current month; URL ?month=YYYY-MM overrides.
  const initialMonth = (() => {
    const param = searchParams.get('month')
    if (param && /^\d{4}-\d{2}$/.test(param)) return param
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })()

  const [month, setMonth] = useState(initialMonth)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const [paymentSourceMap, setPaymentSourceMap] = useState<Record<string, string>>({})
  const [userEmail, setUserEmail] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // Parse the selected month into a JS Date in local time (avoid UTC drift).
  const monthDate = useMemo(() => {
    return parse(month, 'yyyy-MM', new Date())
  }, [month])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const [
        { data: userData },
        { data: txData },
        { data: catData },
        { data: srcData },
      ] = await Promise.all([
        supabase.auth.getUser(),
        supabase
          .from('transactions')
          .select('*')
          .gte('date', format(startOfMonth(monthDate), 'yyyy-MM-dd'))
          .lte('date', format(endOfMonth(monthDate), 'yyyy-MM-dd'))
          .order('date', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase.from('categories').select('id, name'),
        supabase.from('payment_sources').select('id, name'),
      ])

      if (cancelled) return

      setUserEmail(userData?.user?.email ?? '')
      setTransactions((txData as Transaction[]) ?? [])
      setCategoryMap(Object.fromEntries((catData ?? []).map(c => [c.id, c.name])))
      setPaymentSourceMap(Object.fromEntries((srcData ?? []).map(s => [s.id, s.name])))
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [monthDate])

  // ── Aggregates ─────────────────────────────────────────────────────────

  const totals = useMemo(() => {
    const income = transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + Number(t.amount), 0)
    const expenses = transactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + Number(t.amount), 0)
    return { income, expenses, net: income - expenses }
  }, [transactions])

  const categoryBreakdown = useMemo(() => {
    const breakdown: Record<string, { income: number; expense: number }> = {}
    for (const t of transactions) {
      const name = categoryMap[t.category] || t.category
      if (!breakdown[name]) breakdown[name] = { income: 0, expense: 0 }
      breakdown[name][t.type] += Number(t.amount)
    }
    return Object.entries(breakdown)
      .map(([category, v]) => ({ category, ...v, net: v.income - v.expense }))
      .sort((a, b) => b.expense - a.expense)
  }, [transactions, categoryMap])

  // ── Render ─────────────────────────────────────────────────────────────

  const monthLabel = format(monthDate, 'MMMM yyyy')
  const periodRange = `${format(startOfMonth(monthDate), 'MMM d, yyyy')} – ${format(endOfMonth(monthDate), 'MMM d, yyyy')}`

  return (
    <div className="bg-white text-black min-h-screen">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
        }
        @page { size: letter; margin: 0.5in; }
      `}</style>

      {/* Controls (hidden on print) */}
      <div className="no-print sticky top-0 bg-gray-100 border-b border-gray-300 px-6 py-3 flex flex-wrap items-center gap-3 z-10">
        <label className="text-sm text-gray-700">
          Month:&nbsp;
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </label>
        <button
          onClick={() => window.print()}
          className="bg-black text-white text-sm px-4 py-1.5 rounded hover:bg-gray-800"
        >
          Save as PDF / Print
        </button>
        <span className="text-xs text-gray-500 ml-auto">
          Tip: Cmd/Ctrl + P → choose &quot;Save as PDF&quot; in the destination dropdown.
        </span>
      </div>

      {/* Statement body */}
      <div className="max-w-4xl mx-auto px-6 py-8 print:px-0 print:py-0">
        {/* Header */}
        <header className="border-b border-gray-300 pb-4 mb-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Finance Tracker Statement</h1>
              <p className="text-sm text-gray-600 mt-1">{userEmail}</p>
            </div>
            <div className="text-right">
              <div className="text-xl font-semibold">{monthLabel}</div>
              <div className="text-sm text-gray-600">{periodRange}</div>
            </div>
          </div>
        </header>

        {loading ? (
          <p className="text-gray-500">Loading…</p>
        ) : (
          <>
            {/* Summary */}
            <section className="mb-6">
              <h2 className="text-lg font-semibold mb-2">Summary</h2>
              <table className="w-full border border-gray-300 text-sm">
                <tbody>
                  <tr className="border-b border-gray-300">
                    <td className="px-3 py-2">Total Income</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCurrency(totals.income, currency)}
                    </td>
                  </tr>
                  <tr className="border-b border-gray-300">
                    <td className="px-3 py-2">Total Expenses</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCurrency(totals.expenses, currency)}
                    </td>
                  </tr>
                  <tr className="bg-gray-50">
                    <td className="px-3 py-2 font-semibold">Net</td>
                    <td className={`px-3 py-2 text-right font-bold tabular-nums ${totals.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {totals.net >= 0 ? '+' : ''}{formatCurrency(totals.net, currency)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-gray-600">Transaction Count</td>
                    <td className="px-3 py-2 text-right tabular-nums">{transactions.length}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            {/* Category breakdown */}
            {categoryBreakdown.length > 0 && (
              <section className="mb-6">
                <h2 className="text-lg font-semibold mb-2">Category Breakdown</h2>
                <table className="w-full border border-gray-300 text-sm">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-300">
                      <th className="px-3 py-2 text-left">Category</th>
                      <th className="px-3 py-2 text-right">Income</th>
                      <th className="px-3 py-2 text-right">Expense</th>
                      <th className="px-3 py-2 text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryBreakdown.map(row => (
                      <tr key={row.category} className="border-b border-gray-200 last:border-0">
                        <td className="px-3 py-2">{row.category}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.income > 0 ? formatCurrency(row.income, currency) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.expense > 0 ? formatCurrency(row.expense, currency) : '—'}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${row.net >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          {row.net >= 0 ? '+' : ''}{formatCurrency(row.net, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* Transactions table */}
            <section className="mb-6">
              <h2 className="text-lg font-semibold mb-2">Transactions</h2>
              {transactions.length === 0 ? (
                <p className="text-gray-500 text-sm">No transactions this month.</p>
              ) : (
                <table className="w-full border border-gray-300 text-xs">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-300">
                      <th className="px-2 py-2 text-left">Date</th>
                      <th className="px-2 py-2 text-left">Type</th>
                      <th className="px-2 py-2 text-left">Category</th>
                      <th className="px-2 py-2 text-left">Payment Source</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="px-2 py-2 text-left">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map(t => (
                      <tr key={t.id} className="border-b border-gray-200 last:border-0 align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {format(parseLocalDate(t.date), 'MMM d, yyyy')}
                        </td>
                        <td className="px-2 py-1.5 capitalize">{t.type}</td>
                        <td className="px-2 py-1.5">{categoryMap[t.category] || t.category}</td>
                        <td className="px-2 py-1.5">
                          {paymentSourceMap[t.payment_source] || '—'}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${t.type === 'income' ? 'text-green-700' : 'text-red-700'}`}>
                          {t.type === 'income' ? '+' : '-'}{formatCurrency(Number(t.amount), currency)}
                        </td>
                        <td className="px-2 py-1.5 text-gray-700">{t.notes || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* Footer */}
            <footer className="text-xs text-gray-500 border-t border-gray-200 pt-3 mt-8">
              Generated on {format(new Date(), 'MMM d, yyyy h:mm a')}
              {' · '}Statement for {monthLabel}
              {' · '}{transactions.length} transaction{transactions.length === 1 ? '' : 's'}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
