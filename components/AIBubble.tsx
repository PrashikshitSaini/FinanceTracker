'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Transaction, SavingsPlan } from '@/types'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'
import { startOfMonth, endOfMonth, format } from 'date-fns'
import { Sparkles, Brain, Send, X, MessageCircle, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

/**
 * Finn — the floating AI assistant.
 *
 * Lives in the bottom-right corner of every authenticated page. Two modes:
 *
 *   • **Bubble (closed)** — a small gradient circle with a sparkles icon.
 *     When a proactive insight is available (one fetched per session), a
 *     teaser line floats above the bubble showing the headline; tap either
 *     to expand.
 *
 *   • **Panel (open)** — a chat dialog with message history, a free-text
 *     input, and a brain icon next to the send button. Tapping the brain
 *     switches to "reasoning mode" (DeepSeek V4 Pro with chain-of-thought
 *     enabled, slower but smarter); leaving it off uses V4 Flash (cheaper
 *     and faster, default for casual chat).
 *
 * The chat endpoint (/api/ai-chat) can also TAKE ACTIONS via tool calling:
 * creating a savings goal, contributing to one, or updating its target. We
 * read the `tool_results` field of the response and fire a custom event so
 * other parts of the app (Savings tab, dashboard widget) can refresh.
 */

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const INSIGHT_CACHE_KEY = 'aibubble-insight-v1'
// Short TTL so the user sees a fresh angle within minutes if they reload —
// the model gets a new randomly-picked angle each time, so variety only
// matters if we actually re-fetch. 30 minutes balances cost vs. surprise.
const INSIGHT_TTL_MINUTES = 30

interface CachedInsight {
  text: string
  generated_at: number
}

/**
 * Catalog of "angles" the proactive insight can take. One is picked at random
 * for each fetch — without this, the model gravitates to the same observation
 * every time because the underlying data is the same. Forcing a different
 * lens each call surfaces different facets of the user's finances.
 *
 * Add more angles to expand the rotation. Each entry is a direct instruction
 * the prompt embeds verbatim.
 */
const INSIGHT_ANGLES = [
  'a surprising spending pattern — something that contrasts or stands out',
  'a savings-goal cheerleader moment — celebrate or encourage progress',
  'a category trend — how spending in one area changed recently',
  'one tiny actionable tip specific to their data — be concrete, not generic',
  'a celebration of something they did well this month',
  'a "did you know" fact about their own numbers',
  'a forward-looking nudge — something to consider for the rest of the month',
  'a playful comparison between two categories (e.g., "X is more than Y")',
  'a question that prompts them to reflect on a specific transaction',
  'a small win they may not have noticed',
] as const

function pickRandomAngle(): string {
  return INSIGHT_ANGLES[Math.floor(Math.random() * INSIGHT_ANGLES.length)]
}

export default function AIBubble() {
  const { currency } = useCurrency()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [proMode, setProMode] = useState(false)
  const [insight, setInsight] = useState<string | null>(null)
  const [insightDismissed, setInsightDismissed] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ─── Context builder ───────────────────────────────────────────────────────
  // Pulls a snapshot of the user's current finances + savings goals to feed
  // the AI as system context. Kept compact so the prompt stays small.

  const buildSystemContext = useCallback(async (): Promise<string> => {
    const now = new Date()
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd')
    const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd')

    const [
      { data: txData },
      { data: catData },
      { data: srcData },
      { data: planData },
    ] = await Promise.all([
      supabase
        .from('transactions')
        .select('*')
        .gte('date', monthStart)
        .lte('date', monthEnd)
        .order('date', { ascending: false })
        .limit(50),
      supabase.from('categories').select('id, name'),
      supabase.from('payment_sources').select('id, name'),
      supabase
        .from('savings_plans')
        .select('id, name, target_amount, saved_amount, target_date, notes')
        .order('updated_at', { ascending: false }),
    ])

    const transactions = (txData ?? []) as Transaction[]
    const categoryMap: Record<string, string> = {}
    ;(catData ?? []).forEach((c: any) => { categoryMap[c.id] = c.name })

    // Explicit name lists so Finn can map the user's phrasing ("groceries",
    // "my amex") onto the exact category / payment-method names the log_payment
    // and find_transactions tools validate against.
    const categoryNames = (catData ?? []).map((c: any) => c.name)
    const paymentSourceNames = (srcData ?? []).map((s: any) => s.name)

    const income = transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + Number(t.amount), 0)
    const expenses = transactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + Number(t.amount), 0)

    const byCategory: Record<string, number> = {}
    for (const t of transactions) {
      if (t.type !== 'expense') continue
      const name = categoryMap[t.category] || 'Uncategorized'
      byCategory[name] = (byCategory[name] || 0) + Number(t.amount)
    }
    const topCategories = Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([cat, amt]) => `  • ${cat}: ${formatCurrency(amt, currency)}`)
      .join('\n')

    const recentLines = transactions.slice(0, 5).map(t => {
      const cat = categoryMap[t.category] || 'Uncategorized'
      const sign = t.type === 'income' ? '+' : '-'
      return `  • ${t.date} ${sign}${formatCurrency(Number(t.amount), currency)} ${cat}${t.notes ? ' — ' + t.notes : ''}`
    }).join('\n')

    const plans = (planData ?? []) as SavingsPlan[]
    const planLines = plans.length === 0
      ? '  (none yet)'
      : plans.map(p => {
          const pct = Math.min((Number(p.saved_amount) / Number(p.target_amount)) * 100, 100)
          const dateNote = p.target_date ? ` · by ${p.target_date}` : ''
          return `  • [${p.id}] ${p.name}: ${formatCurrency(Number(p.saved_amount), currency)} of ${formatCurrency(Number(p.target_amount), currency)} (${pct.toFixed(0)}%)${dateNote}`
        }).join('\n')

    return [
      `Today: ${format(now, 'yyyy-MM-dd')}.`,
      `User's currency: ${currency}.`,
      ``,
      `THIS MONTH so far:`,
      `  Income: ${formatCurrency(income, currency)}`,
      `  Expenses: ${formatCurrency(expenses, currency)}`,
      `  Net: ${formatCurrency(income - expenses, currency)}`,
      ``,
      `Top spending categories this month:`,
      topCategories || '  (no expenses yet)',
      ``,
      `Recent transactions:`,
      recentLines || '  (none)',
      ``,
      `Your categories (use these exact names when logging or finding payments): ${categoryNames.length ? categoryNames.join(', ') : '(none)'}.`,
      `Your payment methods: ${paymentSourceNames.length ? paymentSourceNames.join(', ') : '(none)'}.`,
      ``,
      `Savings goals (use the bracketed UUID as plan_identifier for tool calls when possible — name also works):`,
      planLines,
    ].join('\n')
  }, [currency])

  // ─── Proactive insight ─────────────────────────────────────────────────────
  // Once per session (and at most every INSIGHT_TTL_HOURS hours), ask the AI
  // for ONE short observation about the user's current finances. Shown as a
  // teaser above the bubble until the user expands the chat or dismisses it.

  useEffect(() => {
    if (insightDismissed) return

    let cancelled = false

    async function fetchInsight() {
      // localStorage cache — short TTL, so a reload within ~30 min reuses
      // the prior insight (saves an API call) but later visits get fresh ones.
      try {
        const raw = localStorage.getItem(INSIGHT_CACHE_KEY)
        if (raw) {
          const cached: CachedInsight = JSON.parse(raw)
          if (Date.now() - cached.generated_at < INSIGHT_TTL_MINUTES * 60 * 1000) {
            if (!cancelled) setInsight(cached.text)
            return
          }
        }
      } catch { /* ignore parse errors — treat as no cache */ }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const context = await buildSystemContext()
      const angle = pickRandomAngle()

      const res = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content:
                `Give me ONE short, friendly observation about my finances right now. ` +
                `Take this specific angle: ${angle}. ` +
                `Make it FRESH and specific to my actual numbers — never use generic finance-advice clichés. ` +
                `Maximum 25 words, one line, casual like texting a friend. Don't use tools, just talk.`,
            },
          ],
          system_context: context,
          model_tier: 'flash',
        }),
      })
      if (!res.ok || cancelled) return
      const json = await res.json()
      const text: string | undefined = json?.content
      if (!text) return
      if (!cancelled) setInsight(text.trim())
      try {
        localStorage.setItem(
          INSIGHT_CACHE_KEY,
          JSON.stringify({ text: text.trim(), generated_at: Date.now() } satisfies CachedInsight),
        )
      } catch { /* localStorage quota / disabled — silently OK */ }
    }

    // Defer slightly so initial page paint isn't delayed by the API call.
    const id = window.setTimeout(fetchInsight, 1500)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [buildSystemContext, insightDismissed])

  // ─── Auto-scroll messages on update ────────────────────────────────────────
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open])

  // ─── Open / close handlers ────────────────────────────────────────────────

  const openPanel = (seedWithInsight = false) => {
    setOpen(true)
    if (seedWithInsight && insight && messages.length === 0) {
      // Seed the conversation with the proactive insight as the AI's opener.
      setMessages([{ role: 'assistant', content: insight }])
    }
    // Focus the input shortly after the panel mounts.
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const closePanel = () => setOpen(false)

  const dismissInsight = () => {
    setInsight(null)
    setInsightDismissed(true)
    // Wipe the cache so the next session (or page reload) generates a fresh
    // angle rather than re-showing the one the user just dismissed.
    try { localStorage.removeItem(INSIGHT_CACHE_KEY) } catch { /* ignore */ }
  }

  // ─── Send a message ───────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Please log in to chat.' }])
      return
    }

    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const context = await buildSystemContext()
      const res = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          messages: newMessages,
          system_context: context,
          model_tier: proMode ? 'pro' : 'flash',
        }),
      })
      const json = await res.json()

      if (!res.ok || !json?.success) {
        const errMsg = json?.error || 'Hmm, something went wrong. Try again?'
        setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
        return
      }

      setMessages(prev => [...prev, { role: 'assistant', content: json.content as string }])

      // If the AI took any actions, let the rest of the app know to refresh.
      // We branch on the result `kind` so a savings change refreshes the
      // savings views (Savings.tsx, TopSavingsCard) and a transaction change
      // refreshes the dashboard — read-only kinds (e.g. transactions_found)
      // trigger nothing.
      if (Array.isArray(json.tool_results) && json.tool_results.length > 0) {
        const results = json.tool_results as unknown[]
        const kinds = results
          .map(r => (r && typeof r === 'object' ? (r as { kind?: unknown }).kind : undefined))
          .filter((k): k is string => typeof k === 'string')
        if (kinds.some(k => k.startsWith('savings_plan'))) {
          window.dispatchEvent(new CustomEvent('finn:savings-changed'))
        }
        const txKinds = new Set(['transaction_logged', 'transaction_updated', 'transaction_deleted'])
        if (kinds.some(k => txKinds.has(k))) {
          window.dispatchEvent(new CustomEvent('finn:transactions-changed'))
        }
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Network hiccup. Try once more?' }])
    } finally {
      setLoading(false)
    }
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Insight teaser — only when the panel is closed and we have one */}
      {insight && !open && !insightDismissed && (
        <div className="fixed bottom-24 right-4 z-50 max-w-[280px] sm:max-w-xs animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="relative bg-card border rounded-2xl shadow-lg p-3 pr-7 text-sm">
            <button
              onClick={dismissInsight}
              aria-label="Dismiss insight"
              className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => openPanel(true)}
              className="text-left block w-full"
            >
              <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-purple-600 dark:text-purple-400">
                <Sparkles className="h-3 w-3" />
                Finn
              </div>
              <p className="leading-snug">{insight}</p>
              <p className="text-xs text-muted-foreground mt-1.5">Tap to chat</p>
            </button>
          </div>
        </div>
      )}

      {/* The bubble itself — bottom-right, always visible when not open */}
      {!open && (
        <button
          onClick={() => openPanel(false)}
          aria-label="Open Finn"
          className="fixed bottom-4 right-4 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 text-white shadow-lg hover:scale-105 active:scale-95 transition-transform flex items-center justify-center group"
        >
          <Sparkles className="h-6 w-6 group-hover:rotate-12 transition-transform" />
          {/* Subtle outer pulse to attract attention without being annoying */}
          <span className="absolute inset-0 rounded-full bg-purple-500/30 animate-ping" style={{ animationDuration: '3s' }} />
        </button>
      )}

      {/* The expanded chat panel */}
      {open && (
        <div className="fixed inset-x-0 bottom-0 sm:inset-auto sm:bottom-4 sm:right-4 z-50 sm:w-[400px] sm:max-w-[calc(100vw-2rem)] h-[80vh] sm:h-[600px] sm:max-h-[calc(100vh-2rem)] bg-card border sm:rounded-2xl shadow-2xl flex flex-col animate-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="flex items-center justify-between p-3 border-b">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="leading-tight">
                <div className="font-semibold text-sm">Finn</div>
                <div className="text-xs text-muted-foreground">
                  {proMode ? 'Reasoning mode (V4 Pro)' : 'Quick mode (V4 Flash)'}
                </div>
              </div>
            </div>
            <button
              onClick={closePanel}
              aria-label="Close"
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {messages.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-10 px-4">
                <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>Hey! Ask me about your spending, or tell me to set a savings goal — like &quot;save $3000 for Hawaii by August&quot;.</p>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  <div
                    className={
                      msg.role === 'user'
                        ? 'max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm'
                        : 'max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm'
                    }
                  >
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm prose-invert max-w-none [&>*]:my-1 [&>p]:my-0 [&_ul]:my-1 [&_ol]:my-1">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                </div>
              ))
            )}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-2xl rounded-tl-sm px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {proMode ? 'Thinking carefully…' : 'Typing…'}
                </div>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div className="border-t p-2.5">
            <div className="flex items-end gap-1.5">
              <button
                onClick={() => setProMode(v => !v)}
                aria-label={proMode ? 'Switch to quick mode' : 'Switch to reasoning mode'}
                title={proMode ? 'Reasoning ON — V4 Pro' : 'Reasoning OFF — V4 Flash (faster, cheaper)'}
                className={
                  proMode
                    ? 'flex-shrink-0 h-9 w-9 rounded-full bg-purple-500/15 text-purple-500 border border-purple-500/40 flex items-center justify-center hover:bg-purple-500/25 transition-colors'
                    : 'flex-shrink-0 h-9 w-9 rounded-full bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors'
                }
              >
                <Brain className="h-4 w-4" />
              </button>
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask Finn anything…"
                disabled={loading}
                className="flex-1 bg-muted/50 border border-input rounded-full px-3.5 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                aria-label="Send"
                disabled={!input.trim() || loading}
                className="flex-shrink-0 h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
