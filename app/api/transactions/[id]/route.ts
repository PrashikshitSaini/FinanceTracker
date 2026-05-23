import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createHash, createHmac } from 'crypto'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizeHtml } from '@/lib/validation'

/**
 * PATCH /api/transactions/[id]
 *
 * Partial update of a single transaction owned by the authenticated user.
 * Built for the Android-payment-automation Phase 1 flow: after an auto-log
 * via /api/quick-add, the user gets a 2-minute "is this categorized right?"
 * nudge on their phone. Tapping a button → calls this endpoint with a
 * structured patch. Typing a correction → calls this endpoint with `text`
 * and DeepSeek re-parses the correction in context.
 *
 * **Structured mode** — send any subset of:
 *   { "category": "<uuid or name>",
 *     "payment_source": "<uuid or name>",
 *     "notes": "<string ≤ 200 chars>",
 *     "is_refund": true | false }
 *   Fields omitted are left as-is. Amount, date, and type are not patchable
 *   here — Wallet is ground truth for those. Edit them via /api/transactions
 *   (the existing PUT) if needed.
 *
 * **AI free-text mode** — send `{ "text": "actually that was a refund, put it under restaurants" }`.
 *   DeepSeek returns ONLY the fields it thinks changed; the server validates
 *   each against the user's category/payment_source lists and applies them.
 *   AI cannot return amount, date, or type — those are stripped before write.
 *
 * Auth: Bearer, session cookie, or X-API-Key (same as POST /api/quick-add).
 * Rate-limited via RATE_LIMITS.QUICK_ADD (shared write budget).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

// RFC 4122 UUID v4 — used to validate the transaction id from URL params,
// resolved IDs from auth paths, and any UUIDs from request bodies before they
// reach the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// Same cap as quick-add — protects against CPU-bound DoS via huge header.
const API_KEY_MAX_LENGTH = 256

// Same model as quick-add by default. Env-overridable for rollback / upgrade.
const PATCH_AI_MODEL = process.env.OPENROUTER_QUICK_ADD_MODEL || 'deepseek/deepseek-v4-pro'

// Cap free-text length so the prompt doesn't balloon and we don't pay for
// pathological inputs.
const TEXT_MAX_LENGTH = 2000

// Notes column is 200 chars in the existing data model.
const NOTES_MAX_LENGTH = 200

// ─── Auth helpers (mirroring the quick-add route's pattern) ──────────────────

/**
 * Signs a short-lived Supabase-compatible JWT so PostgREST applies RLS as if
 * the request came from `userId`. Used only for the X-API-Key auth path.
 */
function signUserJwt(userId: string): string | null {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) return null
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    aud: 'authenticated',
    exp: now + 60,
    iat: now,
    iss: 'supabase',
    role: 'authenticated',
    sub: userId,
  })).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

type AuthResult = {
  user: { id: string } | null
  accessToken: string | null
  apiKeyAuth: boolean
}

/**
 * Resolve the request's authenticated user, trying (in order): Bearer header,
 * session cookie, X-API-Key. Mirrors /api/quick-add exactly so behavior stays
 * consistent across the two endpoints MacroDroid will hit.
 */
async function authenticate(request: NextRequest): Promise<AuthResult> {
  const result: AuthResult = { user: null, accessToken: null, apiKeyAuth: false }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return result

  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '')
    try {
      const verifyResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseKey },
      })
      if (verifyResponse.ok) {
        const candidate = await verifyResponse.json()
        if (isValidUuid(candidate?.id)) {
          result.user = candidate
          result.accessToken = token
        }
      }
    } catch (err) {
      console.error('Token verification error:', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  if (!result.user) {
    const cookieStore = await cookies()
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
        remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
      },
    })
    const { data: { user: cookieUser }, error } = await supabase.auth.getUser()
    if (!error && cookieUser && isValidUuid(cookieUser.id)) result.user = cookieUser
  }

  if (!result.user) {
    const apiKeyHeader = request.headers.get('X-API-Key')
    if (apiKeyHeader && apiKeyHeader.length <= API_KEY_MAX_LENGTH) {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (serviceRoleKey) {
        try {
          const keyHash = createHash('sha256').update(apiKeyHeader).digest('hex')
          const keyRes = await fetch(
            `${supabaseUrl}/rest/v1/quick_add_api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&select=user_id,id`,
            { headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` } }
          )
          if (keyRes.ok) {
            const rows = await keyRes.json()
            if (rows.length > 0) {
              const { user_id, id: keyId } = rows[0]
              if (isValidUuid(user_id) && isValidUuid(keyId)) {
                const userRes = await fetch(
                  `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user_id)}`,
                  { headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` } }
                )
                if (userRes.ok) {
                  const candidate = await userRes.json()
                  if (isValidUuid(candidate?.id)) {
                    result.user = candidate
                    result.apiKeyAuth = true
                    // Fire-and-forget last_used_at touch.
                    fetch(
                      `${supabaseUrl}/rest/v1/quick_add_api_keys?id=eq.${encodeURIComponent(keyId)}`,
                      {
                        method: 'PATCH',
                        headers: {
                          'apikey': serviceRoleKey,
                          'Authorization': `Bearer ${serviceRoleKey}`,
                          'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
                      }
                    ).catch(() => {})
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error('API key lookup error:', err instanceof Error ? err.message : 'Unknown error')
        }
      }
    }
  }

  return result
}

// ─── DB helpers (auth-context aware, like quick-add) ─────────────────────────

type Transaction = {
  id: string
  user_id: string
  amount: number
  type: 'income' | 'expense'
  date: string
  category: string
  payment_source: string
  notes: string | null
  image_url: string | null
  is_refund?: boolean
  client_ref?: string | null
}

/**
 * Fetch a single transaction by id, scoped to the authenticated user via RLS.
 * Returns null if not found (or RLS denies). The caller treats null as 404 —
 * we deliberately don't distinguish "doesn't exist" from "exists but not
 * yours" so we don't leak the existence of other users' IDs.
 */
async function fetchTransaction(
  transactionId: string,
  auth: AuthResult
): Promise<Transaction | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey || !auth.user) return null

  const userId = auth.user.id
  const url = `${supabaseUrl}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}&select=*&limit=1`

  try {
    if (auth.apiKeyAuth) {
      const userJwt = signUserJwt(userId)
      if (!userJwt) return null
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${userJwt}`, 'apikey': supabaseKey },
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    if (auth.accessToken) {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'apikey': supabaseKey },
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
        remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
      },
    })
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle()
    return data as Transaction | null
  } catch (err) {
    console.error('transaction fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return null
  }
}

/**
 * Apply the patch to Supabase, returning the updated row. Auth-context aware.
 * Returns null on any failure — the caller maps that to a 500.
 */
async function applyPatch(
  transactionId: string,
  patch: Record<string, unknown>,
  auth: AuthResult
): Promise<Transaction | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey || !auth.user) return null

  const userId = auth.user.id
  const url = `${supabaseUrl}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}`

  try {
    if (auth.apiKeyAuth) {
      const userJwt = signUserJwt(userId)
      if (!userJwt) return null
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${userJwt}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        console.error('PATCH (API-key) failed:', res.status)
        return null
      }
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    if (auth.accessToken) {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${auth.accessToken}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        console.error('PATCH (Bearer) failed:', res.status)
        return null
      }
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
        remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
      },
    })
    const { data, error } = await supabase
      .from('transactions')
      .update(patch)
      .eq('id', transactionId)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) {
      console.error('PATCH (cookie) failed:', error.message)
      return null
    }
    return data as Transaction | null
  } catch (err) {
    console.error('transaction patch error:', err instanceof Error ? err.message : 'Unknown error')
    return null
  }
}

/**
 * Fetch the user's categories and payment_sources so we can resolve names to
 * UUIDs and reject any AI-hallucinated IDs.
 */
async function fetchOptions(auth: AuthResult): Promise<{
  categories: { id: string; name: string }[]
  paymentSources: { id: string; name: string; card_last_four?: string | null }[]
}> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const empty = { categories: [], paymentSources: [] }
  if (!supabaseUrl || !supabaseKey || !auth.user) return empty
  const userId = auth.user.id

  try {
    if (auth.apiKeyAuth) {
      const userJwt = signUserJwt(userId)
      if (!userJwt) return empty
      const headers = { 'Authorization': `Bearer ${userJwt}`, 'apikey': supabaseKey }
      const [catRes, srcRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name,card_last_four&order=name`, { headers }),
      ])
      return {
        categories: catRes.ok ? await catRes.json() : [],
        paymentSources: srcRes.ok ? await srcRes.json() : [],
      }
    }

    if (auth.accessToken) {
      const headers = { 'Authorization': `Bearer ${auth.accessToken}`, 'apikey': supabaseKey }
      const [catRes, srcRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name,card_last_four&order=name`, { headers }),
      ])
      return {
        categories: catRes.ok ? await catRes.json() : [],
        paymentSources: srcRes.ok ? await srcRes.json() : [],
      }
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
        remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
      },
    })
    const [catResult, srcResult] = await Promise.all([
      supabase.from('categories').select('id, name').order('name'),
      supabase.from('payment_sources').select('id, name, card_last_four').order('name'),
    ])
    return {
      categories: catResult.data ?? [],
      paymentSources: srcResult.data ?? [],
    }
  } catch (err) {
    console.error('options fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return empty
  }
}

// ─── Structured-mode and AI-mode patch builders ──────────────────────────────

/**
 * Build a validated patch object from a structured request body.
 * Accepts category and payment_source by name or UUID; coerces is_refund
 * strictly; truncates and sanitizes notes. Returns only the fields the caller
 * provided — omitted fields are left untouched on the row.
 */
function buildStructuredPatch(
  body: Record<string, unknown>,
  existing: Transaction,
  options: { categories: { id: string; name: string }[]; paymentSources: { id: string; name: string }[] }
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  if (typeof body.category === 'string' && body.category.trim()) {
    const input = body.category.trim()
    const nameMatch = options.categories.find(c => c.name.toLowerCase() === input.toLowerCase())
    if (nameMatch) {
      patch.category = nameMatch.id
    } else if (isValidUuid(input) && options.categories.some(c => c.id === input)) {
      patch.category = input
    }
    // Silently ignore unmatched values — capture beats correctness.
  }

  if (typeof body.payment_source === 'string' && body.payment_source.trim()) {
    const input = body.payment_source.trim()
    const nameMatch = options.paymentSources.find(s => s.name.toLowerCase() === input.toLowerCase())
    if (nameMatch) {
      patch.payment_source = nameMatch.id
    } else if (isValidUuid(input) && options.paymentSources.some(s => s.id === input)) {
      patch.payment_source = input
    }
  }

  if (body.notes !== undefined) {
    if (body.notes === null) {
      patch.notes = null
    } else if (typeof body.notes === 'string') {
      patch.notes = sanitizeHtml(body.notes.slice(0, NOTES_MAX_LENGTH))
    }
  }

  if (body.is_refund === true || body.is_refund === false) {
    patch.is_refund = body.is_refund
  }

  // Apply refund post-processing if we're flipping is_refund TRUE and the
  // current type isn't already income. Matches quick-add's behavior.
  if (patch.is_refund === true && existing.type !== 'income') {
    patch.type = 'income'
    if (!patch.notes) {
      const current = existing.notes ?? ''
      patch.notes = (current.startsWith('Refund:') ? current : `Refund: ${current}`.trim()).slice(0, NOTES_MAX_LENGTH)
    }
  }

  return patch
}

/**
 * Call DeepSeek to interpret a free-text correction. Returns a patch in the
 * same shape as buildStructuredPatch — only the fields that should change.
 * Returns null on any failure (caller responds with a parse error).
 */
async function buildAiPatch(
  text: string,
  existing: Transaction,
  options: { categories: { id: string; name: string }[]; paymentSources: { id: string; name: string }[] }
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null

  const currentCategoryName =
    options.categories.find(c => c.id === existing.category)?.name ?? '(unknown)'
  const currentPaymentSourceName =
    options.paymentSources.find(s => s.id === existing.payment_source)?.name ?? '(unknown)'

  const categoriesList = options.categories.map(c => `- ${c.name} (ID: ${c.id})`).join('\n')
  const sourcesList = options.paymentSources.map(s => `- ${s.name} (ID: ${s.id})`).join('\n')

  // Prompt is intentionally tight: only the four mutable fields can come back.
  // We instruct the model to OMIT unchanged fields so we know what to apply.
  const prompt = `You are correcting an existing transaction based on the user's free-text note.

Existing transaction (DO NOT CHANGE amount, date, or type — those are captured from the payment processor and are authoritative):
- amount: ${existing.amount}
- date: ${existing.date}
- type: ${existing.type}
- category: ${currentCategoryName} (ID: ${existing.category})
- payment source: ${currentPaymentSourceName} (ID: ${existing.payment_source})
- notes: ${existing.notes ?? ''}
- is_refund: ${existing.is_refund === true}

User's correction: "${text}"

Available categories:
${categoriesList}

Available payment sources:
${sourcesList}

Rules:
- ONLY return fields the user wants to change. Omit unchanged fields entirely.
- You may return any subset of: "category", "payment_source", "notes", "is_refund".
- "category" and "payment_source" must be UUIDs from the lists above.
- "notes" max ${NOTES_MAX_LENGTH} characters.
- "is_refund" must be a boolean.
- Do NOT return amount, date, or type — they are immutable here.

Return ONLY a valid JSON object containing the fields to update. Example shapes:
{ "category": "<uuid>" }
{ "notes": "lunch with sarah", "category": "<uuid>" }
{ "is_refund": true }`

  try {
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Finance Tracker',
      },
      body: JSON.stringify({
        model: PATCH_AI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    })

    if (!aiResponse.ok) {
      console.error('OpenRouter PATCH error:', aiResponse.status)
      return null
    }

    const aiData = await aiResponse.json()
    const content: string = aiData.choices?.[0]?.message?.content
    if (!content) return null

    // Strip markdown fences and tolerate prose-wrapped JSON — same fallback
    // pattern as quick-add.
    let jsonStr = content.trim()
    if (jsonStr.includes('```json')) {
      jsonStr = jsonStr.split('```json')[1].split('```')[0].trim()
    } else if (jsonStr.includes('```')) {
      jsonStr = jsonStr.split('```')[1].split('```')[0].trim()
    }
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      const a = jsonStr.indexOf('{')
      const b = jsonStr.lastIndexOf('}')
      if (a !== -1 && b > a) {
        try { parsed = JSON.parse(jsonStr.slice(a, b + 1)) } catch { /* give up */ }
      }
    }
    if (!parsed || typeof parsed !== 'object') return null

    // Validate each field against the user's lists. Anything the model returns
    // that isn't a recognized UUID or a permitted shape is dropped. amount,
    // date, and type are ALWAYS stripped — Wallet is the source of truth.
    const patch: Record<string, unknown> = {}

    if (typeof parsed.category === 'string' && options.categories.some(c => c.id === parsed.category)) {
      patch.category = parsed.category
    }
    if (
      typeof parsed.payment_source === 'string' &&
      options.paymentSources.some(s => s.id === parsed.payment_source)
    ) {
      patch.payment_source = parsed.payment_source
    }
    if (parsed.notes === null) {
      patch.notes = null
    } else if (typeof parsed.notes === 'string') {
      patch.notes = sanitizeHtml(parsed.notes.slice(0, NOTES_MAX_LENGTH))
    }
    if (parsed.is_refund === true || parsed.is_refund === false) {
      patch.is_refund = parsed.is_refund
    }

    // Same refund post-processing as the structured path.
    if (patch.is_refund === true && existing.type !== 'income') {
      patch.type = 'income'
      if (patch.notes === undefined) {
        const current = existing.notes ?? ''
        patch.notes = (current.startsWith('Refund:') ? current : `Refund: ${current}`.trim()).slice(0, NOTES_MAX_LENGTH)
      }
    }

    return patch
  } catch (err) {
    console.error('AI patch error:', err instanceof Error ? err.message : 'Unknown error')
    return null
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> } | { params: { id: string } }
) {
  try {
    // Next.js 14/15: params is async on dynamic routes. Resolve it defensively
    // so this works regardless of which it is at runtime.
    const rawParams = (context as { params: any }).params
    const params = typeof rawParams?.then === 'function' ? await rawParams : rawParams
    const transactionId = params?.id

    if (!isValidUuid(transactionId)) {
      return NextResponse.json({ error: 'Invalid transaction id.' }, { status: 400 })
    }

    const auth = await authenticate(request)
    if (!auth.user) {
      return NextResponse.json({ error: 'Unauthorized. Please log in.' }, { status: 401 })
    }

    // Share the write budget with quick-add — both endpoints insert/update
    // user financial data and a single per-user cap is the right shape here.
    const rateLimit = checkRateLimit(auth.user.id, RATE_LIMITS.QUICK_ADD)
    if (!rateLimit.success) {
      const resetIn = rateLimit.resetTime
        ? Math.ceil((rateLimit.resetTime - Date.now()) / 1000)
        : 60
      return NextResponse.json(
        { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
        { status: 429 }
      )
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 })
    }

    // Confirm the transaction exists and belongs to the user. RLS handles the
    // ownership check; we just need to know if the row is there.
    const existing = await fetchTransaction(transactionId, auth)
    if (!existing) {
      return NextResponse.json({ error: 'Transaction not found.' }, { status: 404 })
    }

    const options = await fetchOptions(auth)
    if (options.categories.length === 0 || options.paymentSources.length === 0) {
      return NextResponse.json(
        { error: 'No categories or payment sources available for this user.' },
        { status: 400 }
      )
    }

    // Decide mode: AI free-text if `text` is present and non-empty, else structured.
    const hasText =
      typeof body.text === 'string' && body.text.trim().length > 0
    const hasStructured =
      'category' in body || 'payment_source' in body || 'notes' in body || 'is_refund' in body

    if (!hasText && !hasStructured) {
      return NextResponse.json(
        { error: 'Provide at least one of: category, payment_source, notes, is_refund, or text.' },
        { status: 400 }
      )
    }

    let patch: Record<string, unknown>

    if (hasText) {
      const text = (body.text as string).trim().slice(0, TEXT_MAX_LENGTH)
      const aiPatch = await buildAiPatch(text, existing, options)
      if (!aiPatch) {
        return NextResponse.json(
          { error: 'AI could not interpret the correction. Please try a more specific instruction.' },
          { status: 422 }
        )
      }
      patch = aiPatch
    } else {
      patch = buildStructuredPatch(body, existing, options)
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'No valid fields to update.', existing },
        { status: 422 }
      )
    }

    // Hard belt-and-suspenders: regardless of mode, NEVER let amount/date/
    // client_ref/user_id/id leak into the patch. Mode logic already prevents
    // this, but a future edit might add a path that doesn't — keep this here.
    delete patch.amount
    delete patch.date
    delete patch.client_ref
    delete patch.user_id
    delete patch.id

    const updated = await applyPatch(transactionId, patch, auth)
    if (!updated) {
      return NextResponse.json({ error: 'Failed to update transaction. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      mode: hasText ? 'ai' : 'structured',
      data: updated,
      applied: Object.keys(patch),
    }, { status: 200 })
  } catch (err) {
    console.error('PATCH /api/transactions/[id] error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to process request. Please try again.' }, { status: 500 })
  }
}
