import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createHash } from 'crypto'
import { transactionSchema, transactionUpdateSchema } from '@/lib/validation'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// =============================================================================
// Route helpers (added 2026-05-30 for GET; auth reused by POST 2026-06-05).
//
// __getAuthenticate lets external systems (other apps, scripts, dashboards)
// curl this endpoint with the user's X-API-Key; Bearer and cookie auth are
// supported too so in-app fetches behave identically. GET and POST both use
// it. The remaining __get* helpers are list-endpoint-specific. The PUT
// handler below still uses its own inline Bearer/cookie auth and does NOT
// accept X-API-Key.
// =============================================================================

// RFC 4122 UUID v4 — used to validate user IDs and any UUIDs from the query
// string before they're concatenated into PostgREST URLs.
const __GET_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function __getIsValidUuid(value: unknown): value is string {
  return typeof value === 'string' && __GET_UUID_RE.test(value)
}

// Cap the X-API-Key header before hashing to prevent CPU-bound DoS via a
// crafted oversized header (matches the cap used in /api/quick-add).
const __GET_API_KEY_MAX_LENGTH = 256

// Caps on the list endpoint. 500 keeps responses bounded against a runaway
// caller; offset cap prevents abusive deep pagination. Sufficient for any
// realistic personal-finance dataset.
const __GET_DEFAULT_LIMIT = 100
const __GET_MAX_LIMIT = 500
const __GET_MAX_OFFSET = 100_000

type __GetAuthResult = {
  user: { id: string } | null
  accessToken: string | null
  apiKeyAuth: boolean
}

/**
 * Resolve the request's authenticated user via Bearer → cookie → X-API-Key
 * (in that order). Mirrors the pattern in /api/quick-add and /api/transactions/[id]
 * so callers can use any of the three auth modes interchangeably.
 *
 * On success: returns { user, accessToken (Bearer-only), apiKeyAuth (X-API-Key-only) }.
 * On failure: returns { user: null, ... } — caller responds with 401.
 */
async function __getAuthenticate(request: NextRequest): Promise<__GetAuthResult> {
  const result: __GetAuthResult = { user: null, accessToken: null, apiKeyAuth: false }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return result

  // 1) Bearer token (in-app callers).
  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '')
    try {
      const verifyResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': supabaseKey },
      })
      if (verifyResponse.ok) {
        const candidate = await verifyResponse.json()
        if (__getIsValidUuid(candidate?.id)) {
          result.user = candidate
          result.accessToken = token
        }
      }
    } catch (err) {
      console.error('GET auth (Bearer) error:', err instanceof Error ? err.message : 'Unknown error')
    }
  }

  // 2) Cookie session (browser).
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
    if (!error && cookieUser && __getIsValidUuid(cookieUser.id)) result.user = cookieUser
  }

  // 3) X-API-Key (external systems via curl). Service-role lookup against
  //    quick_add_api_keys, then admin-fetch the owning user record. Same
  //    contract as /api/quick-add — re-using the same keys.
  if (!result.user) {
    const apiKeyHeader = request.headers.get('X-API-Key')
    if (apiKeyHeader && apiKeyHeader.length <= __GET_API_KEY_MAX_LENGTH) {
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
              if (__getIsValidUuid(user_id) && __getIsValidUuid(keyId)) {
                const userRes = await fetch(
                  `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user_id)}`,
                  { headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` } }
                )
                if (userRes.ok) {
                  const candidate = await userRes.json()
                  if (__getIsValidUuid(candidate?.id)) {
                    result.user = candidate
                    result.apiKeyAuth = true
                    // Fire-and-forget last_used_at touch. `void` prefix
                    // makes the floating-promise intentional and silences
                    // any unhandled-rejection warnings.
                    void fetch(
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
          console.error('GET auth (X-API-Key) error:', err instanceof Error ? err.message : 'Unknown error')
        }
      }
    }
  }

  return result
}

/**
 * Build the PostgREST query string for the list endpoint based on parsed
 * filters. Each filter is optional and validated before being appended to
 * the URL — invalid values are silently dropped rather than rejected, so a
 * caller passing `?type=banana` just gets unfiltered-by-type results.
 */
/**
 * Parse the total row count out of a PostgREST `Content-Range` response
 * header. Format is `<start>-<end>/<total>`, or (asterisk)/<total> when the
 * page was empty (the literal asterisk is spelled out here because the
 * combined "asterisk + slash" sequence would close this JSDoc block).
 * Returns null if the header is missing or malformed — caller should
 * report `total: null` so downstream pagination logic doesn't trust a
 * bogus number.
 */
function __getParseTotalFromContentRange(contentRange: string | null): number | null {
  if (!contentRange) return null
  const slashIdx = contentRange.lastIndexOf('/')
  if (slashIdx < 0) return null
  const totalStr = contentRange.slice(slashIdx + 1)
  const n = parseInt(totalStr, 10)
  return Number.isFinite(n) ? n : null
}

function __getBuildFilterQuery(filters: {
  startDate: string | null
  endDate: string | null
  type: string | null
  category: string | null
  paymentSource: string | null
  isRefund: 'true' | 'false' | null
}): string {
  const parts: string[] = []
  if (filters.startDate && /^\d{4}-\d{2}-\d{2}$/.test(filters.startDate)) {
    parts.push(`date=gte.${filters.startDate}`)
  }
  if (filters.endDate && /^\d{4}-\d{2}-\d{2}$/.test(filters.endDate)) {
    parts.push(`date=lte.${filters.endDate}`)
  }
  if (filters.type === 'income' || filters.type === 'expense') {
    parts.push(`type=eq.${filters.type}`)
  }
  if (filters.category && __getIsValidUuid(filters.category)) {
    parts.push(`category=eq.${filters.category}`)
  }
  if (filters.paymentSource && __getIsValidUuid(filters.paymentSource)) {
    parts.push(`payment_source=eq.${filters.paymentSource}`)
  }
  if (filters.isRefund === 'true') parts.push('is_refund=eq.true')
  if (filters.isRefund === 'false') parts.push('is_refund=eq.false')
  return parts.join('&')
}

// =============================================================================
// GET handler
// =============================================================================

/**
 * GET /api/transactions
 *
 * List the authenticated user's transactions with optional filters and
 * pagination. Designed for external systems to consume via the user's
 * X-API-Key, but also works with Bearer / cookie auth for in-app use.
 *
 * Query parameters (all optional):
 *   start_date       YYYY-MM-DD, inclusive lower bound on `date`
 *   end_date         YYYY-MM-DD, inclusive upper bound on `date`
 *   type             "income" | "expense"
 *   category         UUID of a category
 *   payment_source   UUID of a payment_source
 *   is_refund        "true" | "false"
 *   limit            1..500 (default 100)
 *   offset           >= 0  (default 0, max 100000)
 *   expand           "true" to attach category_name and payment_source_name
 *                    on each transaction (one extra round-trip to fetch the
 *                    user's lookup tables; off by default to keep the
 *                    response shape stable)
 *
 * Response shape:
 *   {
 *     "data": [ { ...transaction, category_name?, payment_source_name? }, ... ],
 *     "pagination": { "limit", "offset", "total", "has_more" }
 *   }
 *
 * Auth: Bearer / cookie / X-API-Key. RLS via the user's signed query path
 * (or service-role with explicit user_id filter on the X-API-Key path).
 *
 * Rate-limited via RATE_LIMITS.QUICK_ADD (shared per-user budget — 30/min).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await __getAuthenticate(request)
    if (!auth.user) {
      return NextResponse.json(
        { error: 'Unauthorized. Provide a valid X-API-Key, Bearer token, or session cookie.' },
        { status: 401 }
      )
    }

    const rl = checkRateLimit(auth.user.id, RATE_LIMITS.QUICK_ADD)
    if (!rl.success) {
      const resetIn = rl.resetTime ? Math.ceil((rl.resetTime - Date.now()) / 1000) : 60
      return NextResponse.json(
        { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
        { status: 429 }
      )
    }

    // ── Parse query params ─────────────────────────────────────────────────
    const url = new URL(request.url)
    const startDate = url.searchParams.get('start_date')
    const endDate = url.searchParams.get('end_date')
    const type = url.searchParams.get('type')
    const category = url.searchParams.get('category')
    const paymentSource = url.searchParams.get('payment_source')
    const isRefund = url.searchParams.get('is_refund') as 'true' | 'false' | null

    const limitParam = parseInt(url.searchParams.get('limit') || '', 10)
    const offsetParam = parseInt(url.searchParams.get('offset') || '', 10)
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, __GET_MAX_LIMIT)
        : __GET_DEFAULT_LIMIT
    const offset =
      Number.isFinite(offsetParam) && offsetParam >= 0
        ? Math.min(offsetParam, __GET_MAX_OFFSET)
        : 0

    const expand = url.searchParams.get('expand') === 'true'

    const filterQuery = __getBuildFilterQuery({
      startDate, endDate, type, category, paymentSource, isRefund,
    })

    // ── Fetch ──────────────────────────────────────────────────────────────
    // Three auth paths → three transport strategies:
    //   • X-API-Key  → raw fetch with service-role + explicit user_id filter
    //                  (RLS bypassed but ownership enforced in the query)
    //   • Bearer     → raw fetch with the user's JWT (RLS applies)
    //   • Cookie     → Supabase client (createServerClient forwards the
    //                  session through; raw fetch wouldn't carry it and RLS
    //                  would see an anon request returning no rows)
    //
    // Note on rate limiting: this endpoint shares the QUICK_ADD bucket
    // (30/min/user) because the in-memory limiter keys by user_id only.
    // Read-heavy external integrations should batch / cache rather than
    // poll tightly — a request-per-second loop would starve quick-add.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    const queryBase =
      `${supabaseUrl}/rest/v1/transactions` +
      `?select=*` +
      `&order=date.desc,created_at.desc` +
      `&limit=${limit}&offset=${offset}` +
      (filterQuery ? `&${filterQuery}` : '')

    let transactions: Array<Record<string, unknown>> = []
    let total: number | null = null

    if (auth.apiKeyAuth) {
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) {
        console.error('GET /api/transactions: SUPABASE_SERVICE_ROLE_KEY missing')
        return NextResponse.json(
          { error: 'Server misconfigured: service-role key required for X-API-Key reads.' },
          { status: 500 }
        )
      }
      const listRes = await fetch(
        `${queryBase}&user_id=eq.${encodeURIComponent(auth.user.id)}`,
        {
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
            'Prefer': 'count=exact',
          },
        }
      )
      if (!listRes.ok) {
        console.error('GET /api/transactions: list fetch (api-key) failed', listRes.status)
        return NextResponse.json({ error: 'Failed to load transactions.' }, { status: 500 })
      }
      const rows = await listRes.json()
      transactions = Array.isArray(rows) ? rows : []
      total = __getParseTotalFromContentRange(listRes.headers.get('content-range'))
    } else if (auth.accessToken) {
      const listRes = await fetch(queryBase, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${auth.accessToken}`,
          'Prefer': 'count=exact',
        },
      })
      if (!listRes.ok) {
        console.error('GET /api/transactions: list fetch (bearer) failed', listRes.status)
        return NextResponse.json({ error: 'Failed to load transactions.' }, { status: 500 })
      }
      const rows = await listRes.json()
      transactions = Array.isArray(rows) ? rows : []
      total = __getParseTotalFromContentRange(listRes.headers.get('content-range'))
    } else {
      // Cookie path — the supabase client carries the session through, which
      // raw fetch() cannot. Filter assembly mirrors the PostgREST query
      // string above so all paths return the same rows for the same params.
      const cookieStore = await cookies()
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
          remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
        },
      })
      let query = supabase
        .from('transactions')
        .select('*', { count: 'exact' })
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
      if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) query = query.gte('date', startDate)
      if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) query = query.lte('date', endDate)
      if (type === 'income' || type === 'expense') query = query.eq('type', type)
      if (category && __getIsValidUuid(category)) query = query.eq('category', category)
      if (paymentSource && __getIsValidUuid(paymentSource)) query = query.eq('payment_source', paymentSource)
      if (isRefund === 'true') query = query.eq('is_refund', true)
      if (isRefund === 'false') query = query.eq('is_refund', false)

      const { data, count, error } = await query
      if (error) {
        console.error('GET /api/transactions: list fetch (cookie) failed', error.message)
        return NextResponse.json({ error: 'Failed to load transactions.' }, { status: 500 })
      }
      transactions = (data as Array<Record<string, unknown>>) ?? []
      total = typeof count === 'number' ? count : null
    }

    // ── Optional: attach category_name / payment_source_name ───────────────
    // Fetched in a single batch each so the cost is at most two extra GETs
    // regardless of how many transactions came back.
    //
    // Note: the cookie auth path uses anon-key-only here (no session token
    // forwarded). categories is a global table (RLS allows all authenticated
    // SELECTs against it), and payment_sources's SELECT policy permits
    // shared rows (user_id IS NULL) plus the user's own — but the anon role
    // only sees shared rows. For typical cookie callers this still resolves
    // the most common names, which is good enough for expand. If a cookie
    // caller relies on expand for their own user_id-scoped payment_source
    // names, they should switch to Bearer auth.
    if (expand && transactions.length > 0) {
      // Build headers conditionally instead of via an IIFE union — the
      // union type ({with Authorization} | {without}) doesn't narrow to
      // Record<string, string> cleanly.
      const lookupHeaders: Record<string, string> = { apikey: supabaseKey }
      if (auth.apiKeyAuth) {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
        lookupHeaders.apikey = serviceRoleKey
        lookupHeaders.Authorization = `Bearer ${serviceRoleKey}`
      } else if (auth.accessToken) {
        lookupHeaders.Authorization = `Bearer ${auth.accessToken}`
      }
      // Cookie path: just anon apikey is set, no Authorization header (see
      // trade-off note above).

      const [catRes, srcRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/categories?select=id,name`, { headers: lookupHeaders }),
        fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name`, { headers: lookupHeaders }),
      ])
      const cats = catRes.ok ? await catRes.json() : []
      const srcs = srcRes.ok ? await srcRes.json() : []
      const catMap = new Map<string, string>((cats as { id: string; name: string }[]).map(c => [c.id, c.name]))
      const srcMap = new Map<string, string>((srcs as { id: string; name: string }[]).map(s => [s.id, s.name]))
      transactions = (transactions as Array<Record<string, unknown>>).map(t => ({
        ...t,
        category_name: typeof t.category === 'string' ? catMap.get(t.category) ?? null : null,
        payment_source_name: typeof t.payment_source === 'string' ? srcMap.get(t.payment_source) ?? null : null,
      }))
    }

    return NextResponse.json(
      {
        data: transactions,
        pagination: {
          limit,
          offset,
          total,
          has_more: total !== null ? offset + transactions.length < total : transactions.length === limit,
        },
      },
      { status: 200 }
    )
  } catch (err) {
    console.error('GET /api/transactions error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to process request. Please try again.' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/transactions
 * Create a new transaction with server-side validation.
 *
 * Auth: Bearer / session cookie / X-API-Key (same contract as GET). On the
 * X-API-Key path the insert uses the service-role key with user_id pinned to
 * the key's owner, and the request shares the QUICK_ADD rate-limit bucket.
 * Browser (cookie) and Bearer flows are unchanged and not rate-limited here.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await __getAuthenticate(request)
    if (!auth.user) {
      return NextResponse.json(
        { error: 'Unauthorized. Provide a valid X-API-Key, Bearer token, or session cookie.' },
        { status: 401 }
      )
    }
    const user = auth.user
    const accessToken = auth.accessToken

    // Rate-limit only the external (X-API-Key) path — same per-user budget as
    // quick-add and the GET list endpoint. Pre-existing browser/Bearer flows
    // keep their original unlimited behavior.
    if (auth.apiKeyAuth) {
      const rl = checkRateLimit(user.id, RATE_LIMITS.QUICK_ADD)
      if (!rl.success) {
        const resetIn = rl.resetTime ? Math.ceil((rl.resetTime - Date.now()) / 1000) : 60
        return NextResponse.json(
          { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
          { status: 429 }
        )
      }
    }

    const body = await request.json()

    const validationResult = transactionSchema.safeParse({
      ...body,
      user_id: user.id,
    })

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid transaction data',
          details: validationResult.error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      )
    }

    const validatedData = validationResult.data

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (auth.apiKeyAuth) {
      // X-API-Key path: service-role transport with user_id pinned explicitly
      // (same pattern as the GET handler above and /api/quick-add). RLS is
      // bypassed by the service role, so the payment_source check re-creates
      // the RLS rule manually: shared rows (user_id IS NULL) or rows owned by
      // this user. Categories are a global table — existence check suffices.
      // All interpolated values are UUID-validated (zod .uuid() on the body
      // fields, __getIsValidUuid on user.id inside __getAuthenticate).
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) {
        console.error('POST /api/transactions: SUPABASE_SERVICE_ROLE_KEY missing')
        return NextResponse.json(
          { error: 'Server misconfigured: service-role key required for X-API-Key writes.' },
          { status: 500 }
        )
      }
      const serviceHeaders = {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      }

      const [categoryResponse, paymentSourceResponse] = await Promise.all([
        fetch(
          `${supabaseUrl}/rest/v1/categories?id=eq.${validatedData.category}&select=id`,
          { headers: serviceHeaders }
        ),
        fetch(
          `${supabaseUrl}/rest/v1/payment_sources?id=eq.${validatedData.payment_source}&or=(user_id.is.null,user_id.eq.${user.id})&select=id`,
          { headers: serviceHeaders }
        ),
      ])

      if (!categoryResponse.ok || (await categoryResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (!paymentSourceResponse.ok || (await paymentSourceResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const insertResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions`,
        {
          method: 'POST',
          headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            amount: validatedData.amount,
            type: validatedData.type,
            date: validatedData.date,
            category: validatedData.category,
            payment_source: validatedData.payment_source,
            notes: validatedData.notes,
            image_url: validatedData.image_url,
            user_id: user.id,
          }),
        }
      )

      if (!insertResponse.ok) {
        console.error('POST /api/transactions: insert (api-key) failed', insertResponse.status)
        return NextResponse.json(
          { error: 'Failed to create transaction. Please try again.' },
          { status: 500 }
        )
      }

      const transaction = await insertResponse.json()
      return NextResponse.json(
        { success: true, data: Array.isArray(transaction) ? transaction[0] : transaction },
        { status: 201 }
      )
    } else if (accessToken) {
      const categoryResponse = await fetch(
        `${supabaseUrl}/rest/v1/categories?id=eq.${validatedData.category}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      const paymentSourceResponse = await fetch(
        `${supabaseUrl}/rest/v1/payment_sources?id=eq.${validatedData.payment_source}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!categoryResponse.ok || (await categoryResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (!paymentSourceResponse.ok || (await paymentSourceResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const insertResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            amount: validatedData.amount,
            type: validatedData.type,
            date: validatedData.date,
            category: validatedData.category,
            payment_source: validatedData.payment_source,
            notes: validatedData.notes,
            image_url: validatedData.image_url,
            user_id: user.id,
          }),
        }
      )

      if (!insertResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to create transaction. Please try again.' },
          { status: 500 }
        )
      }

      const transaction = await insertResponse.json()
      return NextResponse.json({ success: true, data: Array.isArray(transaction) ? transaction[0] : transaction }, { status: 201 })
    } else {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        supabaseUrl,
        supabaseKey,
        {
          cookies: {
            get(name: string) {
              return cookieStore.get(name)?.value
            },
            set(name: string, value: string, options: any) {
              cookieStore.set({ name, value, ...options })
            },
            remove(name: string, options: any) {
              cookieStore.set({ name, value: '', ...options })
            },
          },
        }
      )

      const [categoryCheck, paymentSourceCheck] = await Promise.all([
        supabase
          .from('categories')
          .select('id')
          .eq('id', validatedData.category)
          .single(),
        supabase
          .from('payment_sources')
          .select('id')
          .eq('id', validatedData.payment_source)
          .single(),
      ])

      if (categoryCheck.error || !categoryCheck.data) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (paymentSourceCheck.error || !paymentSourceCheck.data) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const { data: transaction, error: insertError } = await supabase
        .from('transactions')
        .insert([{
          amount: validatedData.amount,
          type: validatedData.type,
          date: validatedData.date,
          category: validatedData.category,
          payment_source: validatedData.payment_source,
          notes: validatedData.notes,
          image_url: validatedData.image_url,
          user_id: user.id,
        }])
        .select()
        .single()

      if (insertError) {
        return NextResponse.json(
          { error: 'Failed to create transaction. Please try again.' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, data: transaction }, { status: 201 })
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to create transaction. Please try again.' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/transactions
 * Update an existing transaction with server-side validation
 */
export async function PUT(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization')
    let user = null
    let accessToken = null

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
        
        if (verifyResponse.ok) {
          const userData = await verifyResponse.json()
          user = userData
          accessToken = token
        }
      } catch (err) {
      }
    }

    if (!user) {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            get(name: string) {
              return cookieStore.get(name)?.value
            },
            set(name: string, value: string, options: any) {
              cookieStore.set({ name, value, ...options })
            },
            remove(name: string, options: any) {
              cookieStore.set({ name, value: '', ...options })
            },
          },
        }
      )

      const { data: { user: cookieUser }, error: authError } = await supabase.auth.getUser()
      if (!authError && cookieUser) {
        user = cookieUser
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { id, ...transactionData } = body

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Transaction ID is required for updates' },
        { status: 400 }
      )
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (accessToken) {
      const existingResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions?id=eq.${id}&select=id,user_id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!existingResponse.ok) {
        return NextResponse.json(
          { error: 'Transaction not found' },
          { status: 404 }
        )
      }

      const existing = await existingResponse.json()
      if (!existing || existing.length === 0 || existing[0].user_id !== user.id) {
        return NextResponse.json(
          { error: 'Transaction not found' },
          { status: 404 }
        )
      }

      const validationResult = transactionSchema.safeParse({
        ...transactionData,
        user_id: user.id,
      })

      if (!validationResult.success) {
        return NextResponse.json(
          {
            error: 'Invalid transaction data',
            details: validationResult.error.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          { status: 400 }
        )
      }

      const validatedData = validationResult.data

      const categoryResponse = await fetch(
        `${supabaseUrl}/rest/v1/categories?id=eq.${validatedData.category}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      const paymentSourceResponse = await fetch(
        `${supabaseUrl}/rest/v1/payment_sources?id=eq.${validatedData.payment_source}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!categoryResponse.ok || (await categoryResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (!paymentSourceResponse.ok || (await paymentSourceResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const updateResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            amount: validatedData.amount,
            type: validatedData.type,
            date: validatedData.date,
            category: validatedData.category,
            payment_source: validatedData.payment_source,
            notes: validatedData.notes,
            image_url: validatedData.image_url,
          }),
        }
      )

      if (!updateResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to update transaction. Please try again.' },
          { status: 500 }
        )
      }

      const transaction = await updateResponse.json()
      return NextResponse.json({ success: true, data: Array.isArray(transaction) ? transaction[0] : transaction })
    } else {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        supabaseUrl,
        supabaseKey,
        {
          cookies: {
            get(name: string) {
              return cookieStore.get(name)?.value
            },
            set(name: string, value: string, options: any) {
              cookieStore.set({ name, value, ...options })
            },
            remove(name: string, options: any) {
              cookieStore.set({ name, value: '', ...options })
            },
          },
        }
      )

      const { data: existingTransaction, error: fetchError } = await supabase
        .from('transactions')
        .select('id, user_id')
        .eq('id', id)
        .single()

      if (fetchError || !existingTransaction) {
        return NextResponse.json(
          { error: 'Transaction not found' },
          { status: 404 }
        )
      }

      if (existingTransaction.user_id !== user.id) {
        return NextResponse.json(
          { error: 'Unauthorized. You can only update your own transactions.' },
          { status: 403 }
        )
      }

      const validationResult = transactionSchema.safeParse({
        ...transactionData,
        user_id: user.id,
      })

      if (!validationResult.success) {
        return NextResponse.json(
          {
            error: 'Invalid transaction data',
            details: validationResult.error.errors.map(e => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          { status: 400 }
        )
      }

      const validatedData = validationResult.data

      const [categoryCheck, paymentSourceCheck] = await Promise.all([
        supabase
          .from('categories')
          .select('id')
          .eq('id', validatedData.category)
          .single(),
        supabase
          .from('payment_sources')
          .select('id')
          .eq('id', validatedData.payment_source)
          .single(),
      ])

      if (categoryCheck.error || !categoryCheck.data) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (paymentSourceCheck.error || !paymentSourceCheck.data) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const { data: transaction, error: updateError } = await supabase
        .from('transactions')
        .update({
          amount: validatedData.amount,
          type: validatedData.type,
          date: validatedData.date,
          category: validatedData.category,
          payment_source: validatedData.payment_source,
          notes: validatedData.notes,
          image_url: validatedData.image_url,
        })
        .eq('id', id)
        .eq('user_id', user.id)
        .select()
        .single()

      if (updateError) {
        return NextResponse.json(
          { error: 'Failed to update transaction. Please try again.' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, data: transaction })
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to update transaction. Please try again.' },
      { status: 500 }
    )
  }
}
