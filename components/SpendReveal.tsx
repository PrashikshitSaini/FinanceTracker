'use client'

import { useEffect, useState } from 'react'

/**
 * The "cool animation" payoff: when the app is opened from a push notification
 * (the service worker navigates to /?from=push&spent=NNN), this shows a brief,
 * dismissible count-up of the month-to-date total, then cleans the URL so a
 * refresh doesn't replay it. Tap anywhere or wait ~5s to dismiss.
 *
 * Amount is formatted as USD to match the server-generated push (see
 * send-daily route note on multi-currency). Respects prefers-reduced-motion.
 */

const DISMISS_MS = 5000
const ANIM_MS = 1200

function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

export default function SpendReveal() {
  const [target, setTarget] = useState<number | null>(null)
  const [display, setDisplay] = useState(0)
  const [visible, setVisible] = useState(false)

  // Detect the push-open params once on mount, then strip them from the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('from') !== 'push') return
    const raw = params.get('spent')
    const amount = raw != null ? Number(raw) : NaN

    // Strip our params but preserve any others, without adding a history entry.
    params.delete('from')
    params.delete('spent')
    const qs = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))

    if (!Number.isFinite(amount) || amount < 0) return
    setTarget(amount)
    setVisible(true)
  }, [])

  // Count-up animation (skipped for reduced-motion users, who see the total).
  useEffect(() => {
    if (target === null) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setDisplay(target); return }

    let raf = 0
    let start: number | null = null
    const tick = (ts: number) => {
      if (start === null) start = ts
      const t = Math.min((ts - start) / ANIM_MS, 1)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
      setDisplay(target * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])

  // Auto-dismiss.
  useEffect(() => {
    if (!visible) return
    const id = window.setTimeout(() => setVisible(false), DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [visible])

  if (!visible || target === null) return null

  return (
    <div
      onClick={() => setVisible(false)}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 backdrop-blur-sm animate-in fade-in duration-300"
      role="dialog"
      aria-label="Spending summary"
    >
      <div className="flex flex-col items-center gap-1 px-8 text-center animate-in zoom-in-95 duration-300">
        <div className="text-sm uppercase tracking-wide text-muted-foreground">Spent this month</div>
        <div className="text-5xl font-bold tabular-nums bg-gradient-to-br from-purple-500 to-pink-500 bg-clip-text text-transparent">
          {formatUsd(display)}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">Tap to dismiss</div>
      </div>
    </div>
  )
}
