import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { transactionSchema, sanitizeHtml, validateDate } from '@/lib/validation'

// Two-tier model selection — the client picks per-request via `model_tier`:
//   • "flash" (default) — DeepSeek V4 Flash. ~4× cheaper, fast, no reasoning.
//                          Right choice for everyday casual chat in the bubble.
//   • "pro"             — DeepSeek V4 Pro with reasoning enabled. Slower but
//                          deeper — surfaced via a brain-icon toggle in the UI.
//
// Both are env-overridable for per-deployment rollbacks. The legacy
// OPENROUTER_CHAT_MODEL env var is honored as the Pro fallback so users who
// set it before the tiering existed don't have to re-configure.
const CHAT_MODEL_FLASH = process.env.OPENROUTER_CHAT_MODEL_FLASH || 'deepseek/deepseek-v4-flash'
const CHAT_MODEL_PRO =
  process.env.OPENROUTER_CHAT_MODEL_PRO ||
  process.env.OPENROUTER_CHAT_MODEL ||
  'deepseek/deepseek-v4-pro'

// Safety bound for the tool-execution loop. If the model keeps requesting
// tool calls beyond this, we bail rather than rack up unbounded API spend.
// Five rounds is plenty for any realistic conversation turn.
const MAX_TOOL_ROUNDS = 5

// Per-message and total-payload caps. The system prompt + a year of
// transactions can be sizable, so 20 KB per message and ~1 MB total are
// generous but bounded; the rate limit (10 chats/minute/user) backs this up.
const MAX_MESSAGES = 50
const MAX_CONTENT_LENGTH = 20000
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

// ─── Tool definitions ───────────────────────────────────────────────────────
// All tools operate on `savings_plans` for the authenticated user. The model
// can use the user's plan NAME (case-insensitive) or UUID as the identifier —
// we resolve to a UUID server-side before mutating, so a stale conversation
// can't accidentally hit the wrong row.

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_savings_plan',
      description:
        'Create a new savings goal for the user. Use when they explicitly want to start saving for something specific (a trip, an item, an emergency fund). Do not invent generic goals.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Goal name (e.g., "Hawaii Trip", "Emergency Fund"). Max 100 chars.',
          },
          target_amount: {
            type: 'number',
            description: 'Target amount in the user\'s currency. Must be positive.',
          },
          target_date: {
            type: 'string',
            description: 'Optional target date in YYYY-MM-DD format.',
          },
          notes: {
            type: 'string',
            description: 'Optional notes about the goal.',
          },
          initial_saved_amount: {
            type: 'number',
            description: 'Optional starting saved amount. Defaults to 0.',
          },
        },
        required: ['name', 'target_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contribute_to_savings_plan',
      description:
        'Add money to an existing savings goal. Use when user says things like "add $50 to Hawaii", "saved 100 toward emergency fund".',
      parameters: {
        type: 'object',
        properties: {
          plan_identifier: {
            type: 'string',
            description: 'The plan\'s name (case-insensitive match) or UUID.',
          },
          amount: {
            type: 'number',
            description: 'Positive amount to add to saved_amount.',
          },
        },
        required: ['plan_identifier', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_savings_plan',
      description:
        'Modify an existing savings goal — its name, target amount, target date, or notes. Only use when the user explicitly asks to change something.',
      parameters: {
        type: 'object',
        properties: {
          plan_identifier: {
            type: 'string',
            description: 'The plan\'s name (case-insensitive match) or UUID.',
          },
          name: { type: 'string' },
          target_amount: { type: 'number' },
          target_date: {
            type: 'string',
            description: 'YYYY-MM-DD, or empty string to clear the target date.',
          },
          notes: { type: 'string' },
        },
        required: ['plan_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_payment',
      description:
        'Record a new transaction (a payment/expense or income) for the user. Use when they say things like "log a $12 lunch on my Amex" or "add $2000 paycheck as income". Requires an amount, a category, and a payment method. If the category or payment method is unclear or missing, ASK the user — never guess one they did not imply.',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'The transaction amount in the user\'s currency. Must be positive.',
          },
          category: {
            type: 'string',
            description: 'Category NAME (e.g., "Groceries") or its UUID. Must be one of the user\'s existing categories.',
          },
          payment_source: {
            type: 'string',
            description: 'Payment method NAME (e.g., "Amex") or its UUID. Must be one of the user\'s existing payment methods.',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: 'Defaults to "expense" if omitted. Use "income" for money received.',
          },
          date: {
            type: 'string',
            description: 'Transaction date in YYYY-MM-DD. Defaults to today if omitted.',
          },
          notes: {
            type: 'string',
            description: 'Optional note/merchant/description. Max 1000 chars.',
          },
          is_refund: {
            type: 'boolean',
            description: 'Set true if this is a refund. Refunds are recorded as income.',
          },
        },
        required: ['amount', 'category', 'payment_source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_transactions',
      description:
        'Search the user\'s transactions. ALWAYS use this to locate the exact transaction before updating or deleting one — it returns each match\'s id, which update_payment and delete_payment require. Filter by any combination of amount range, date range, category, payment method, type, or a keyword found in the notes.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional keyword to match against the transaction notes (case-insensitive substring).',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
          },
          category: {
            type: 'string',
            description: 'Category NAME or UUID to filter by.',
          },
          payment_source: {
            type: 'string',
            description: 'Payment method NAME or UUID to filter by.',
          },
          start_date: { type: 'string', description: 'Inclusive lower bound on date, YYYY-MM-DD.' },
          end_date: { type: 'string', description: 'Inclusive upper bound on date, YYYY-MM-DD.' },
          min_amount: { type: 'number', description: 'Inclusive lower bound on amount.' },
          max_amount: { type: 'number', description: 'Inclusive upper bound on amount.' },
          limit: { type: 'number', description: 'Max results to return (default 10, max 25).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_payment',
      description:
        'Change an existing transaction, identified by its UUID (get it from find_transactions first). Only include the fields you want to change. Before overwriting, confirm the specific transaction with the user.',
      parameters: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'The UUID of the transaction to update (from find_transactions).',
          },
          amount: { type: 'number', description: 'New amount. Must be positive.' },
          type: { type: 'string', enum: ['expense', 'income'] },
          date: { type: 'string', description: 'New date, YYYY-MM-DD.' },
          category: { type: 'string', description: 'New category NAME or UUID.' },
          payment_source: { type: 'string', description: 'New payment method NAME or UUID.' },
          notes: { type: 'string', description: 'New note. Pass an empty string to clear it. Max 1000 chars.' },
          is_refund: { type: 'boolean', description: 'Set/clear the refund flag.' },
        },
        required: ['transaction_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_payment',
      description:
        'Permanently delete a transaction, identified by its UUID (get it from find_transactions first). This cannot be undone — you MUST confirm the specific transaction with the user before calling this.',
      parameters: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'The UUID of the transaction to delete (from find_transactions).',
          },
        },
        required: ['transaction_id'],
      },
    },
  },
] as const

// UUID v4 — used to detect when the model passes a UUID directly vs a name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ─── Tool execution ─────────────────────────────────────────────────────────
// Each tool returns a short text string that the model will see as the tool
// result. We keep results brief and human-readable so they cost few tokens
// and the model can summarize naturally.

type SupabaseClient = ReturnType<typeof createServerClient>

interface ToolResult {
  ok: boolean
  /** Human-readable result the model sees. Always present. */
  message: string
  /** Optional structured data the CLIENT can use (e.g., to refresh state). */
  data?: unknown
}

/**
 * Resolve a plan identifier (name or UUID) to a row. Returns null if not
 * found. RLS ensures only the caller's own plans are visible.
 */
async function findSavingsPlan(
  supabase: SupabaseClient,
  identifier: string,
): Promise<{ id: string; name: string; saved_amount: number; target_amount: number } | null> {
  if (UUID_RE.test(identifier)) {
    const { data } = await supabase
      .from('savings_plans')
      .select('id, name, saved_amount, target_amount')
      .eq('id', identifier)
      .maybeSingle()
    return data ?? null
  }
  // Name lookup, case-insensitive. ilike with no wildcards = exact match.
  const { data } = await supabase
    .from('savings_plans')
    .select('id, name, saved_amount, target_amount')
    .ilike('name', identifier)
    .limit(1)
    .maybeSingle()
  return data ?? null
}

// ─── Transaction helpers ─────────────────────────────────────────────────────
// The transaction tools operate on `transactions` for the authenticated user.
// The model works with category / payment-method NAMES; we resolve those to the
// UUID-strings the `category` / `payment_source` columns actually store, and we
// only ever accept a value that exists in the user's own visible lists — so a
// hallucinated name or id is rejected rather than written. All reads/writes go
// through the RLS-bound `supabase` client, so ownership is enforced by the DB.

interface UserOptions {
  categories: { id: string; name: string }[]
  paymentSources: { id: string; name: string }[]
}

/** Today's date as YYYY-MM-DD, used as the default transaction date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Fetch the user's categories (global table) and payment sources (RLS-scoped to
 * shared + own). Used to resolve names → UUIDs and to reject unknown values.
 */
async function fetchUserOptions(supabase: SupabaseClient): Promise<UserOptions> {
  const [catResult, srcResult] = await Promise.all([
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('payment_sources').select('id, name').order('name'),
  ])
  return {
    categories: (catResult.data as { id: string; name: string }[]) ?? [],
    paymentSources: (srcResult.data as { id: string; name: string }[]) ?? [],
  }
}

/**
 * Resolve a category/payment-method reference to a UUID. Accepts an exact
 * (case-insensitive) name match, or a UUID that is present in the list.
 * Returns null when nothing matches — the caller turns that into a message
 * asking the user to clarify, rather than writing an unvalidated value.
 */
function resolveOptionId(
  input: string,
  list: { id: string; name: string }[],
): string | null {
  const value = input.trim()
  if (!value) return null
  const byName = list.find(o => o.name.toLowerCase() === value.toLowerCase())
  if (byName) return byName.id
  if (UUID_RE.test(value) && list.some(o => o.id === value)) return value
  return null
}

async function executeToolCall(
  supabase: SupabaseClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (name === 'create_savings_plan') {
      const planName = typeof args.name === 'string' ? args.name.trim().slice(0, 100) : ''
      const targetAmount = typeof args.target_amount === 'number' ? args.target_amount : NaN
      const targetDate =
        typeof args.target_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.target_date)
          ? args.target_date
          : null
      const notes =
        typeof args.notes === 'string' && args.notes.trim().length > 0
          ? args.notes.trim().slice(0, 1000)
          : null
      const initialSaved =
        typeof args.initial_saved_amount === 'number' && args.initial_saved_amount >= 0
          ? Math.min(args.initial_saved_amount, 1_000_000_000)
          : 0

      if (!planName) return { ok: false, message: 'Refused: goal name is required.' }
      if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > 1_000_000_000) {
        return { ok: false, message: 'Refused: target amount must be a positive number up to 1B.' }
      }
      if (initialSaved > targetAmount) {
        return { ok: false, message: 'Refused: initial saved amount can\'t exceed target.' }
      }

      const { data, error } = await supabase
        .from('savings_plans')
        .insert([{
          user_id: userId,
          name: planName,
          target_amount: targetAmount,
          saved_amount: initialSaved,
          target_date: targetDate,
          notes,
        }])
        .select()
        .single()
      if (error || !data) {
        return { ok: false, message: 'Failed to create goal.' }
      }
      return {
        ok: true,
        message: `Created goal "${data.name}" with target ${data.target_amount}. Starting at ${data.saved_amount}.`,
        data: { kind: 'savings_plan_created', plan: data },
      }
    }

    if (name === 'contribute_to_savings_plan') {
      const identifier = typeof args.plan_identifier === 'string' ? args.plan_identifier.trim() : ''
      const amount = typeof args.amount === 'number' ? args.amount : NaN
      if (!identifier) return { ok: false, message: 'Refused: plan_identifier required.' }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        return { ok: false, message: 'Refused: amount must be positive and ≤ 1B.' }
      }
      const plan = await findSavingsPlan(supabase, identifier)
      if (!plan) return { ok: false, message: `No goal found matching "${identifier}".` }

      const newSaved = Math.min(Number(plan.saved_amount) + amount, 1_000_000_000)
      const { data, error } = await supabase
        .from('savings_plans')
        .update({ saved_amount: newSaved })
        .eq('id', plan.id)
        .select()
        .single()
      if (error || !data) return { ok: false, message: 'Failed to record contribution.' }

      const remaining = Math.max(Number(data.target_amount) - Number(data.saved_amount), 0)
      return {
        ok: true,
        message:
          `Added ${amount} to "${data.name}". Now at ${data.saved_amount} of ${data.target_amount}` +
          (remaining > 0 ? ` (${remaining} to go).` : ' — goal reached!'),
        data: { kind: 'savings_plan_contribution', plan: data },
      }
    }

    if (name === 'update_savings_plan') {
      const identifier = typeof args.plan_identifier === 'string' ? args.plan_identifier.trim() : ''
      if (!identifier) return { ok: false, message: 'Refused: plan_identifier required.' }
      const plan = await findSavingsPlan(supabase, identifier)
      if (!plan) return { ok: false, message: `No goal found matching "${identifier}".` }

      const update: Record<string, unknown> = {}
      if (typeof args.name === 'string' && args.name.trim().length > 0) {
        update.name = args.name.trim().slice(0, 100)
      }
      if (typeof args.target_amount === 'number' && args.target_amount > 0 && args.target_amount <= 1_000_000_000) {
        update.target_amount = args.target_amount
      }
      if (typeof args.target_date === 'string') {
        if (args.target_date === '') {
          update.target_date = null
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(args.target_date)) {
          update.target_date = args.target_date
        }
      }
      if (typeof args.notes === 'string') {
        update.notes = args.notes.trim().slice(0, 1000) || null
      }

      if (Object.keys(update).length === 0) {
        return { ok: false, message: 'Nothing to update — no valid fields provided.' }
      }
      const { data, error } = await supabase
        .from('savings_plans')
        .update(update)
        .eq('id', plan.id)
        .select()
        .single()
      if (error || !data) return { ok: false, message: 'Failed to update goal.' }
      return {
        ok: true,
        message: `Updated "${data.name}".`,
        data: { kind: 'savings_plan_updated', plan: data },
      }
    }

    if (name === 'log_payment') {
      const options = await fetchUserOptions(supabase)
      if (options.categories.length === 0 || options.paymentSources.length === 0) {
        return { ok: false, message: 'You don\'t have any categories or payment methods set up yet — add one in the app first.' }
      }

      const amount = typeof args.amount === 'number' ? args.amount : NaN
      const type = args.type === 'income' ? 'income' : 'expense'
      const date =
        typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : todayIso()
      const categoryInput = typeof args.category === 'string' ? args.category : ''
      const sourceInput = typeof args.payment_source === 'string' ? args.payment_source : ''
      const isRefund = args.is_refund === true

      if (!categoryInput) {
        return { ok: false, message: `Which category? Your options: ${options.categories.map(c => c.name).join(', ')}.` }
      }
      const categoryId = resolveOptionId(categoryInput, options.categories)
      if (!categoryId) {
        return { ok: false, message: `I couldn't match the category "${categoryInput}". Your options: ${options.categories.map(c => c.name).join(', ')}.` }
      }
      if (!sourceInput) {
        return { ok: false, message: `Which payment method? Your options: ${options.paymentSources.map(s => s.name).join(', ')}.` }
      }
      const sourceId = resolveOptionId(sourceInput, options.paymentSources)
      if (!sourceId) {
        return { ok: false, message: `I couldn't match the payment method "${sourceInput}". Your options: ${options.paymentSources.map(s => s.name).join(', ')}.` }
      }

      // Refund post-processing mirrors quick-add / PATCH: a refund is recorded
      // as income with a "Refund:" note prefix.
      let finalType: 'income' | 'expense' = type
      let notes = typeof args.notes === 'string' ? sanitizeHtml(args.notes.slice(0, 1000)) : null
      if (isRefund) {
        finalType = 'income'
        notes = !notes ? 'Refund' : notes.startsWith('Refund:') ? notes : `Refund: ${notes}`.slice(0, 1000)
      }

      // Validate the assembled payload with the same schema the manual add path
      // uses, so amount/date/notes rules stay identical across entry points.
      const parsed = transactionSchema.safeParse({
        amount,
        type: finalType,
        date,
        category: categoryId,
        payment_source: sourceId,
        notes,
        user_id: userId,
      })
      if (!parsed.success) {
        const first = parsed.error.errors[0]
        return { ok: false, message: `Refused: ${first?.message ?? 'invalid transaction data'}.` }
      }
      const v = parsed.data

      const row: Record<string, unknown> = {
        amount: v.amount,
        type: v.type,
        date: v.date,
        category: v.category,
        payment_source: v.payment_source,
        notes: v.notes ?? null,
        user_id: userId,
      }
      if (isRefund) row.is_refund = true

      const { data, error } = await supabase.from('transactions').insert([row]).select().single()
      if (error || !data) return { ok: false, message: 'Failed to log the payment.' }

      const catName = options.categories.find(c => c.id === v.category)?.name ?? 'Uncategorized'
      const srcName = options.paymentSources.find(s => s.id === v.payment_source)?.name ?? ''
      return {
        ok: true,
        message:
          `Logged ${v.type} of ${v.amount} on ${v.date} — ${catName}` +
          (srcName ? ` via ${srcName}` : '') + '.',
        data: { kind: 'transaction_logged', transaction: data },
      }
    }

    if (name === 'find_transactions') {
      const options = await fetchUserOptions(supabase)

      const limit =
        typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 25) : 10

      let query = supabase
        .from('transactions')
        .select('id, amount, type, date, category, payment_source, notes, is_refund')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit)

      if (args.type === 'income' || args.type === 'expense') query = query.eq('type', args.type)
      if (typeof args.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.start_date)) {
        query = query.gte('date', args.start_date)
      }
      if (typeof args.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.end_date)) {
        query = query.lte('date', args.end_date)
      }
      if (typeof args.min_amount === 'number') query = query.gte('amount', args.min_amount)
      if (typeof args.max_amount === 'number') query = query.lte('amount', args.max_amount)
      if (typeof args.category === 'string' && args.category.trim()) {
        const id = resolveOptionId(args.category, options.categories)
        if (!id) {
          return { ok: false, message: `No category matches "${args.category}". Your options: ${options.categories.map(c => c.name).join(', ')}.` }
        }
        query = query.eq('category', id)
      }
      if (typeof args.payment_source === 'string' && args.payment_source.trim()) {
        const id = resolveOptionId(args.payment_source, options.paymentSources)
        if (!id) {
          return { ok: false, message: `No payment method matches "${args.payment_source}". Your options: ${options.paymentSources.map(s => s.name).join(', ')}.` }
        }
        query = query.eq('payment_source', id)
      }
      if (typeof args.query === 'string' && args.query.trim()) {
        // Neutralize PostgREST ilike wildcards / delimiters so the keyword is
        // matched literally as a substring.
        const keyword = args.query.trim().replace(/[%,_]/g, ' ')
        query = query.ilike('notes', `%${keyword}%`)
      }

      const { data, error } = await query
      if (error) return { ok: false, message: 'Failed to search transactions.' }

      const rows = (data as Array<Record<string, unknown>>) ?? []
      if (rows.length === 0) {
        return { ok: true, message: 'No matching transactions found.', data: { kind: 'transactions_found', transactions: [] } }
      }

      const catMap = new Map(options.categories.map(c => [c.id, c.name]))
      const srcMap = new Map(options.paymentSources.map(s => [s.id, s.name]))
      const lines = rows
        .map((t, i) => {
          const sign = t.type === 'income' ? '+' : '-'
          const cat = catMap.get(t.category as string) ?? 'Uncategorized'
          const src = srcMap.get(t.payment_source as string) ?? 'unknown'
          return `${i + 1}. id=${t.id} | ${t.date} | ${sign}${t.amount} ${t.type} | ${cat} | ${src}` +
            (t.notes ? ` | ${t.notes}` : '')
        })
        .join('\n')

      return {
        ok: true,
        message:
          `Found ${rows.length} transaction(s):\n${lines}\n\n` +
          'Use the id with update_payment / delete_payment. Confirm the specific transaction with the user before deleting or overwriting.',
        data: { kind: 'transactions_found', transactions: rows },
      }
    }

    if (name === 'update_payment') {
      const transactionId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : ''
      if (!UUID_RE.test(transactionId)) {
        return { ok: false, message: 'Refused: a valid transaction_id is required — use find_transactions to get it.' }
      }

      // Confirm the row is visible to this user (RLS) before patching, and read
      // its current type/notes for refund post-processing.
      const { data: existing } = await supabase
        .from('transactions')
        .select('id, type, notes')
        .eq('id', transactionId)
        .maybeSingle()
      if (!existing) {
        return { ok: false, message: 'That transaction doesn\'t exist or isn\'t yours.' }
      }

      const options = await fetchUserOptions(supabase)
      const patch: Record<string, unknown> = {}
      const rejected: string[] = []

      if (args.amount !== undefined) {
        if (typeof args.amount === 'number' && args.amount > 0 && args.amount <= 1_000_000_000) {
          patch.amount = args.amount
        } else {
          rejected.push('amount (must be a number > 0 and ≤ 1B)')
        }
      }
      if (args.type === 'income' || args.type === 'expense') patch.type = args.type
      if (args.date !== undefined) {
        if (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) && validateDate(args.date)) {
          patch.date = args.date
        } else {
          rejected.push('date (must be YYYY-MM-DD within range)')
        }
      }
      if (typeof args.category === 'string' && args.category.trim()) {
        const id = resolveOptionId(args.category, options.categories)
        if (id) patch.category = id
        else rejected.push(`category "${args.category}"`)
      }
      if (typeof args.payment_source === 'string' && args.payment_source.trim()) {
        const id = resolveOptionId(args.payment_source, options.paymentSources)
        if (id) patch.payment_source = id
        else rejected.push(`payment method "${args.payment_source}"`)
      }
      if (args.notes !== undefined) {
        if (args.notes === null) patch.notes = null
        else if (typeof args.notes === 'string') patch.notes = sanitizeHtml(args.notes.slice(0, 1000))
      }
      if (args.is_refund === true || args.is_refund === false) patch.is_refund = args.is_refund

      // Refund post-processing: flipping is_refund true forces income and a
      // "Refund:" note prefix, matching the log path and the PATCH route.
      if (patch.is_refund === true && (patch.type ?? existing.type) !== 'income') {
        patch.type = 'income'
        if (patch.notes === undefined) {
          const current = (existing.notes as string) ?? ''
          patch.notes = (current.startsWith('Refund:') ? current : `Refund: ${current}`.trim()).slice(0, 1000)
        }
      }

      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          message: rejected.length
            ? `Couldn't apply: ${rejected.join(', ')}.`
            : 'Nothing to update — no valid fields were provided.',
        }
      }

      // Ownership enforced by RLS on the cookie-bound client (same as the app's
      // own inline-edit path, which filters by id only).
      const { data, error } = await supabase
        .from('transactions')
        .update(patch)
        .eq('id', transactionId)
        .select()
        .single()
      if (error || !data) return { ok: false, message: 'Failed to update the payment.' }

      const ignored = rejected.length ? ` (ignored: ${rejected.join(', ')})` : ''
      return {
        ok: true,
        message: `Updated the transaction${ignored}.`,
        data: { kind: 'transaction_updated', transaction: data },
      }
    }

    if (name === 'delete_payment') {
      const transactionId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : ''
      if (!UUID_RE.test(transactionId)) {
        return { ok: false, message: 'Refused: a valid transaction_id is required — use find_transactions to get it.' }
      }

      // Read the row first (RLS-scoped) so we can 404 cleanly and describe what
      // was removed in the confirmation message.
      const { data: existing } = await supabase
        .from('transactions')
        .select('id, amount, type, date')
        .eq('id', transactionId)
        .maybeSingle()
      if (!existing) {
        return { ok: false, message: 'That transaction doesn\'t exist or isn\'t yours.' }
      }

      const { error } = await supabase.from('transactions').delete().eq('id', transactionId)
      if (error) return { ok: false, message: 'Failed to delete the payment.' }

      return {
        ok: true,
        message: `Deleted the ${existing.type} of ${existing.amount} on ${existing.date}.`,
        data: { kind: 'transaction_deleted', transaction_id: transactionId },
      }
    }

    return { ok: false, message: `Unknown tool: ${name}` }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Tool execution error:', err instanceof Error ? err.message : 'Unknown error')
    }
    return { ok: false, message: 'Tool execution threw an error.' }
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * POST /api/ai-chat
 *
 * Chat endpoint with savings-plan tool calling. The client sends:
 *   - messages: prior chat history (user/assistant turns)
 *   - system_context: optional string with the user's current finances
 *     (built client-side from data the client already has loaded)
 *
 * The server appends its own system prompt + the client context, sends to
 * OpenRouter with tools enabled, and runs a bounded execution loop: while
 * the model returns tool_calls, execute them and feed the results back.
 * Returns final assistant text once the model stops requesting tools.
 *
 * Auth: Bearer token or session cookie. Tools execute under the user's auth
 * context via the cookie-bound Supabase client → RLS applies on every op.
 */
export async function POST(request: NextRequest) {
  try {
    // ─── Auth (Bearer or cookie) ──────────────────────────────────────────
    const authHeader = request.headers.get('Authorization')
    let user: { id: string } | null = null

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '')
      try {
        const verifyResponse = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          }
        )
        if (verifyResponse.ok) user = await verifyResponse.json()
      } catch (err) {
        console.error('Token verification error:', err instanceof Error ? err.message : 'Unknown error')
      }
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
          remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
        },
      }
    )

    if (!user) {
      const { data: { user: cookieUser } } = await supabase.auth.getUser()
      if (cookieUser) user = cookieUser
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in to use the AI assistant.' },
        { status: 401 }
      )
    }

    // ─── Rate limit ───────────────────────────────────────────────────────
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.AI_CHAT)
    if (!rateLimitResult.success) {
      const resetIn = rateLimitResult.resetTime
        ? Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        : 60
      return NextResponse.json(
        { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
        { status: 429 }
      )
    }

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      console.error('OpenRouter API key is not configured')
      return NextResponse.json(
        { error: 'AI service is not configured. Please contact support.' },
        { status: 500 }
      )
    }

    // ─── Body + validation ────────────────────────────────────────────────
    const body = await request.json()
    const incomingMessages: unknown = body?.messages
    const systemContext: unknown = body?.system_context
    // Tier picker — anything other than literal "pro" treats as Flash. We
    // never trust client input to silently bump us to the more expensive
    // tier, but defaulting *down* (to Flash) is fine — that's the cheaper,
    // faster path.
    const useProTier = body?.model_tier === 'pro'
    const modelToUse = useProTier ? CHAT_MODEL_PRO : CHAT_MODEL_FLASH

    if (!Array.isArray(incomingMessages)) {
      return NextResponse.json({ error: 'messages array required.' }, { status: 400 })
    }
    if (incomingMessages.length > MAX_MESSAGES) {
      return NextResponse.json({ error: 'Too many messages in conversation history.' }, { status: 400 })
    }

    for (let i = 0; i < incomingMessages.length; i++) {
      const msg = incomingMessages[i] as { role?: unknown; content?: unknown }
      if (typeof msg !== 'object' || msg === null) {
        return NextResponse.json({ error: 'Invalid message format.' }, { status: 400 })
      }
      if (!ALLOWED_ROLES.has(msg.role as string)) {
        return NextResponse.json({ error: 'Invalid message role.' }, { status: 400 })
      }
      if (typeof msg.content !== 'string') {
        return NextResponse.json({ error: 'Invalid message content.' }, { status: 400 })
      }
      if (msg.content.length > MAX_CONTENT_LENGTH) {
        return NextResponse.json(
          {
            error: `Message content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
            details: `Message ${i} (role: ${msg.role}) was ${msg.content.length} characters.`,
          },
          { status: 400 }
        )
      }
    }

    // ─── Build the message stack we'll send to OpenRouter ─────────────────
    // System prompt + optional client-provided context + chat history.
    const contextBlock =
      typeof systemContext === 'string' && systemContext.length > 0 && systemContext.length <= MAX_CONTENT_LENGTH
        ? `\n\n${systemContext}`
        : ''

    const systemPrompt = `You are Finn, the user's friendly personal-finance buddy living inside their Finance Tracker app. You see their transactions, savings goals, and current finances. Keep replies SHORT (1-3 sentences) unless they ask for detail. Be warm and casual — like texting a friend.

You have tools to take actions on the user's behalf.

Savings goals:
  • create_savings_plan — when they want a new goal
  • contribute_to_savings_plan — when they say "add X to Y" or "I just saved Z toward Y"
  • update_savings_plan — when they want to change a goal's name/target/date/notes

Transactions (payments):
  • log_payment — record a new payment/expense or income (e.g., "log a $12 lunch on my Amex"). Needs an amount, a category, and a payment method. If any of those is missing or unclear, ASK — never invent a category or payment method the user didn't imply. Date defaults to today; type defaults to expense.
  • find_transactions — search the user's transactions. ALWAYS use this to locate the exact transaction before you edit or delete one; it returns each match's id.
  • update_payment — change an existing transaction by its id (amount, date, type, category, payment method, notes, or refund flag).
  • delete_payment — permanently remove a transaction by its id.

SAFETY — deleting or overwriting a transaction is destructive:
  • First find it, then state the exact transaction back to the user (amount, date, category) and ask them to confirm. Only call delete_payment / update_payment AFTER they clearly say yes.
  • When the user confirms, call find_transactions again to re-fetch the current id, then act on that id.
  • If find_transactions returns more than one match, ask the user which one — never guess.

When a user asks for an action, USE THE TOOL. Don't just describe what they should do. After a tool succeeds, briefly confirm what you did.${contextBlock}`

    const messagesForApi: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...incomingMessages.map((m: any) => ({ role: m.role, content: m.content })),
    ]

    // ─── Tool execution loop ──────────────────────────────────────────────
    // Run up to MAX_TOOL_ROUNDS turns. Each turn: call OpenRouter; if the
    // assistant message has tool_calls, execute each, append results, loop.
    // Otherwise return the assistant content as the final answer.

    let lastAssistantContent: string | null = null
    const appliedToolResults: unknown[] = []

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          'X-Title': 'Finance Tracker',
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: messagesForApi,
          tools: TOOLS,
          tool_choice: 'auto',
          // Pro tier enables reasoning (chain-of-thought) — that's the
          // whole point of the brain toggle. Flash skips it for speed/cost.
          // max_tokens scales accordingly: reasoning eats budget before the
          // visible answer, so Pro needs more headroom.
          reasoning: { enabled: useProTier },
          max_tokens: useProTier ? 2000 : 800,
        }),
      })

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after')
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000
        return NextResponse.json(
          { error: `Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds before trying again.` },
          { status: 429 }
        )
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('OpenRouter API error:', response.status, errorData?.error?.message)
        if (response.status === 401 || response.status === 403) {
          return NextResponse.json(
            { error: 'AI service authentication failed. Please try again later.' },
            { status: 500 }
          )
        }
        return NextResponse.json(
          { error: 'AI service error. Please try again later.' },
          { status: 500 }
        )
      }

      const data = await response.json()
      const message = data.choices?.[0]?.message
      if (!message) {
        console.error('AI chat: missing message in response')
        return NextResponse.json({ error: 'No response from AI model.' }, { status: 500 })
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

      if (toolCalls.length === 0) {
        // Terminal — model returned a final text answer.
        lastAssistantContent = typeof message.content === 'string' ? message.content : ''
        break
      }

      // Append the assistant's tool_calls turn to history, then execute each
      // call and append a 'tool' message for each result.
      messagesForApi.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: toolCalls,
      })

      for (const call of toolCalls) {
        const fnName = call?.function?.name
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          // Malformed args from the model — return an error result so the
          // model can recover or apologize, but don't crash the loop.
          parsedArgs = {}
        }
        const result = await executeToolCall(supabase, user.id, fnName, parsedArgs)
        if (result.data !== undefined) appliedToolResults.push(result.data)
        messagesForApi.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.message,
        })
      }
      // Loop continues; next iteration calls the model again with the new history.
    }

    if (lastAssistantContent === null) {
      // Loop bailed without terminal text — shouldn't happen unless we hit
      // MAX_TOOL_ROUNDS. Return whatever we have so the UI doesn't hang.
      lastAssistantContent =
        'I tried to take a few steps but couldn\'t wrap it up cleanly. Want to try again?'
    }

    return NextResponse.json({
      success: true,
      content: lastAssistantContent,
      // Lets the client know which side effects happened so it can refresh
      // the relevant slice of UI (e.g., re-fetch savings_plans).
      tool_results: appliedToolResults,
    })
  } catch (error) {
    console.error('AI chat API error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to process AI chat request. Please try again.' },
      { status: 500 }
    )
  }
}
