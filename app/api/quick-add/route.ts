import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createHash } from 'crypto'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizeHtml } from '@/lib/validation'
import { todayInTimezone } from '@/lib/utils'

// Note: The API-key auth path used to sign a short-lived Supabase JWT
// (`signUserJwt`) so PostgREST applied RLS as the user. That depended on
// SUPABASE_JWT_SECRET being correctly set in production, and silently
// produced zero-row reads when it wasn't. The path now uses the
// service-role key and explicit user_id filters / payloads instead —
// equivalent guarantees, one less env-var dependency.

// RFC 4122 UUID v4 — used to validate user IDs returned from auth paths before use in URLs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// API keys are "ftqa_" + 32 hex chars = 37 chars. Allow a small buffer; reject anything absurdly large
// before it reaches the hash function to prevent CPU-bound DoS via huge headers.
const API_KEY_MAX_LENGTH = 256

const AMOUNT_MAX = 1_000_000_000

// OpenRouter model for AI categorization. Env-overridable so we can roll back
// (or upgrade) without a code deploy. Standard (non-reasoning) mode is intended —
// reasoning emits `reasoning_details` that would break our strict JSON parse and
// roughly double latency for a task that doesn't need chain-of-thought.
const QUICK_ADD_MODEL = process.env.OPENROUTER_QUICK_ADD_MODEL || 'deepseek/deepseek-v4-pro'

// Exactly 4 ASCII digits — matches what the DB CHECK constraint enforces on
// payment_sources.card_last_four. Anything else is rejected before lookup.
const CARD_LAST_FOUR_RE = /^[0-9]{4}$/

// Idempotency token from the client (MacroDroid). Capped so a malformed payload
// can't blow up the unique-index lookup or persist arbitrary garbage.
const CLIENT_REF_MAX_LENGTH = 128

// Postgres unique-violation SQLSTATE — used to detect that an idempotent insert
// raced with a parallel request and the row already exists.
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Best-effort: create a per-user payment_source for a card we've never
 * seen before. Called when a Wallet notif arrives with a card_last_four
 * that doesn't match any payment_source the caller can currently see.
 *
 * `payment_sources` has both a shared pool (rows with user_id IS NULL —
 * created in the past via Supabase Dashboard, visible to everyone) and
 * per-user rows (user_id = owner). RLS enforces this: any authenticated
 * user can read shared ∪ own, but can only INSERT rows with their own
 * user_id. New auto-created rows are therefore scoped to the inserting
 * user and don't pollute anyone else's payment_source list.
 *
 * If the INSERT is denied (e.g., the migration's RLS policies haven't
 * been applied yet), we swallow the error and return null — the
 * transaction itself still logs against whichever default the caller's
 * mode branch picks. Capture beats correctness.
 *
 * Naming: "Card •• 1234" — the user can rename it later.
 */
async function tryCreatePaymentSource(params: {
  userId: string
  cardLastFour: string
  accessToken: string | null
  apiKeyAuth: boolean
}): Promise<{ id: string; name: string; card_last_four: string } | null> {
  const { userId, cardLastFour, accessToken, apiKeyAuth } = params
  if (!CARD_LAST_FOUR_RE.test(cardLastFour)) return null

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return null

  const name = `Card •• ${cardLastFour}`
  // user_id is required by the RLS INSERT policy (payment_sources_insert_own)
  // and ensures the new row is scoped to this user only — other users won't
  // see it. The signed-JWT path below makes auth.uid() resolve to userId so
  // the WITH CHECK passes.
  const payload = { user_id: userId, name, card_last_four: cardLastFour }

  try {
    if (apiKeyAuth) {
      // Use service-role for inserts on the API-key path. RLS is bypassed,
      // but the payload already pins user_id = userId so the new row is
      // properly scoped. Independent of SUPABASE_JWT_SECRET.
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) return null
      const res = await fetch(`${supabaseUrl}/rest/v1/payment_sources`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : rows ?? null
    }

    if (accessToken) {
      const res = await fetch(`${supabaseUrl}/rest/v1/payment_sources`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : rows ?? null
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
      .from('payment_sources')
      .insert([payload])
      .select()
      .single()
    return data ?? null
  } catch (err) {
    console.error('auto-create payment_source failed:', err instanceof Error ? err.message : 'Unknown error')
    return null
  }
}

/**
 * Look up an existing transaction by (user_id, client_ref). Used for
 * idempotency: when the phone retries a POST, we return the prior result
 * instead of inserting a second row. Uses whatever auth context the caller is
 * already using so RLS sees the lookup the same way it would see the write.
 *
 * Returns the existing transaction row, or null if none / on any error.
 * Errors are intentionally swallowed: failing closed (proceeding to insert)
 * is preferable to surfacing an idempotency-lookup error to the user, because
 * the DB unique index is the real backstop.
 */
async function findExistingByClientRef(params: {
  userId: string
  clientRef: string
  accessToken: string | null
  apiKeyAuth: boolean
}): Promise<unknown | null> {
  const { userId, clientRef, accessToken, apiKeyAuth } = params
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return null

  // Build the PostgREST URL once — same query for both token-bearing paths.
  const url =
    `${supabaseUrl}/rest/v1/transactions` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&client_ref=eq.${encodeURIComponent(clientRef)}` +
    `&select=*&limit=1`

  try {
    if (apiKeyAuth) {
      // Use service-role for the idempotency lookup on the API-key path. The
      // URL above already filters by `user_id=eq.<userId>`, so even with RLS
      // bypassed we can only see this user's rows. Independent of
      // SUPABASE_JWT_SECRET.
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) return null
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'apikey': serviceRoleKey },
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    if (accessToken) {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': supabaseKey },
      })
      if (!res.ok) return null
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    }

    // Cookie / browser-session path.
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
      .eq('user_id', userId)
      .eq('client_ref', clientRef)
      .maybeSingle()
    return data ?? null
  } catch (err) {
    console.error('client_ref lookup error:', err instanceof Error ? err.message : 'Unknown error')
    return null
  }
}

/**
 * POST /api/quick-add
 * Two modes for adding transactions:
 *
 * **Simple mode** (no AI, instant) — send structured data:
 *   { "amount": 20.84, "description": "Chipotle" }
 *   Optional fields: "type" ("expense"|"income", default "expense"),
 *   "category" (name or UUID), "payment_source" (name or UUID), "date" (YYYY-MM-DD).
 *
 * **AI mode** (natural language) — send free-form text:
 *   { "text": "Spent 20.84 on Chipotle" }
 *
 * Optional fields shared by both modes (added for Android payment automation):
 *   - "source_app" (string ≤ 100 chars) — name of the originating app
 *     (e.g., "Cash App", "Venmo", "Google Wallet"). When supplied, the server
 *     tries to match it case-insensitively against the user's payment_source
 *     names first. This handles non-card sources like Cash App that don't
 *     have a card_last_four. Falls through to card_last_four matching if no
 *     name match is found.
 *   - "card_last_four" (string of 4 digits) — routes the transaction to the
 *     matching payment_source by card_last_four. Auto-creates a placeholder
 *     payment_source (named "Card •• 1234") if none matches and RLS allows it.
 *     Used as a fallback after source_app matching.
 *   - "is_refund" (boolean) — when true, the transaction is forced to
 *     type=income, its notes are prefixed with "Refund:", and the is_refund
 *     column is set so reports can separate refund income from real income.
 *   - "client_ref" (string ≤ 128 chars) — idempotency token. If a transaction
 *     with the same (user_id, client_ref) already exists, the existing row is
 *     returned with mode="idempotent" instead of inserting a duplicate.
 *
 * Auth: Bearer token, session cookie, or X-API-Key header.
 */
export async function POST(request: NextRequest) {
  try {
    // --- Auth ---
    const authHeader = request.headers.get('Authorization')
    let user = null
    let accessToken: string | null = null
    let apiKeyAuth = false

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
          const candidate = await verifyResponse.json()
          // Verify the returned user ID is a valid UUID before accepting this identity.
          if (isValidUuid(candidate?.id)) {
            user = candidate
            accessToken = token
          }
        }
      } catch (err) {
        console.error('Token verification error:', err instanceof Error ? err.message : 'Unknown error')
      }
    }

    if (!user) {
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
      const { data: { user: cookieUser }, error } = await supabase.auth.getUser()
      if (!error && cookieUser && isValidUuid(cookieUser.id)) user = cookieUser
    }

    // --- X-API-Key auth ---
    if (!user) {
      const apiKeyHeader = request.headers.get('X-API-Key')
      // Cap length before hashing to prevent a CPU-bound DoS via a crafted oversized header.
      if (apiKeyHeader && apiKeyHeader.length <= API_KEY_MAX_LENGTH) {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (serviceRoleKey) {
          const keyHash = createHash('sha256').update(apiKeyHeader).digest('hex')
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
          try {
            const keyRes = await fetch(
              `${supabaseUrl}/rest/v1/quick_add_api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&select=user_id,id`,
              {
                headers: {
                  'apikey': serviceRoleKey,
                  'Authorization': `Bearer ${serviceRoleKey}`,
                },
              }
            )
            if (keyRes.ok) {
              const rows = await keyRes.json()
              if (rows.length > 0) {
                const { user_id, id: keyId } = rows[0]
                // Verify the stored user_id is a valid UUID before using it in further requests.
                if (isValidUuid(user_id) && isValidUuid(keyId)) {
                  const userRes = await fetch(
                    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user_id)}`,
                    {
                      headers: {
                        'apikey': serviceRoleKey,
                        'Authorization': `Bearer ${serviceRoleKey}`,
                      },
                    }
                  )
                  if (userRes.ok) {
                    const candidate = await userRes.json()
                    if (isValidUuid(candidate?.id)) {
                      user = candidate
                      apiKeyAuth = true
                      // Fire-and-forget: update last_used_at
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

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Please log in.' }, { status: 401 })
    }

    // --- Rate limit — checked immediately after identity is established, before any further I/O ---
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.QUICK_ADD)
    if (!rateLimitResult.success) {
      const resetIn = rateLimitResult.resetTime
        ? Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        : 60
      return NextResponse.json(
        { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
        { status: 429 }
      )
    }

    // --- Parse request body ---
    // Accept both JSON and form-urlencoded bodies. Phone-side automation tools
    // like MacroDroid use OkHttp under the hood, which rejects non-ASCII bytes
    // in custom string bodies (Wallet notifications routinely contain "®",
    // "••", curly quotes, etc.). Form-urlencoded bodies are URL-encoded by the
    // client, so non-ASCII characters travel cleanly and we re-assemble them
    // server-side without anyone having to remember UTF-8 encoding.
    //
    // Wrapped in try/catch so malformed / empty bodies produce a clear 400
    // with a hint, rather than the catch-all 500 at the bottom of the route.
    const contentType = (request.headers.get('content-type') || '').toLowerCase()
    let body: Record<string, unknown> = {}
    try {
      if (
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')
      ) {
        const formData = await request.formData()
        formData.forEach((value, key) => {
          const str = value.toString()
          // Coerce the few known-numeric / known-boolean fields so the rest of
          // the route sees the same shape as JSON callers do. Everything else
          // stays as a string — the downstream code already handles strings
          // for text, description, category, payment_source, etc.
          if (key === 'amount') {
            const n = parseFloat(str)
            body[key] = Number.isFinite(n) ? n : str
          } else if (key === 'is_refund') {
            body[key] = str === 'true' || str === '1'
          } else {
            body[key] = str
          }
        })
      } else {
        // Default path: JSON. If the body is empty or not valid JSON,
        // request.json() throws — we catch it below and return a 400 with
        // an actionable hint instead of an opaque 500.
        body = await request.json()
      }
    } catch (parseErr) {
      console.error(
        'Body parse error:',
        parseErr instanceof Error ? parseErr.message : 'Unknown error'
      )
      return NextResponse.json(
        {
          error:
            'Could not parse request body. Send JSON ({"text":"..."}) with ' +
            'Content-Type: application/json, OR form-encoded (text=...) with ' +
            'Content-Type: application/x-www-form-urlencoded. The body field ' +
            'must not be empty.',
        },
        { status: 400 }
      )
    }
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object or form-encoded data.' },
        { status: 400 }
      )
    }

    // ---- New optional fields (Phase 1 Android payment automation) ----
    // Extracted up front so they apply identically to simple and AI modes.

    // is_refund: strict boolean coercion. Anything other than literal `true`
    // is treated as false. Refunds are out of scope for the simple "dumb
    // forwarder forwards Wallet notifications" path — we deliberately do NOT
    // auto-detect refunds from text because the keyword overlap with normal
    // payments ("credited to your Visa," etc.) was too noisy. Callers who
    // genuinely need to mark a row as a refund pass `is_refund: true`
    // explicitly and the rest of the pipeline does the right thing.
    const isRefund: boolean = body?.is_refund === true

    // The notification text we'll feed to AI in AI mode, and use right now
    // for server-side card-last-4 extraction. Trimmed and length-capped.
    const bodyText: string =
      typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : ''

    // card_last_four: explicit field wins; otherwise regex-detect from text so
    // the forwarder doesn't have to parse anything itself. Patterns covered:
    //   "Visa •• 1234"   "•• 1234"   "••1234"   "ending in 1234"
    // Anything else stays null and the transaction lands on whichever
    // payment_source the body or AI picks. We only infer when the field is
    // entirely absent from the body; an explicit null/empty string stays null.
    let cardLastFour: string | null =
      typeof body?.card_last_four === 'string' && CARD_LAST_FOUR_RE.test(body.card_last_four)
        ? body.card_last_four
        : null
    if (cardLastFour === null && body?.card_last_four === undefined && bodyText) {
      const m = bodyText.match(/(?:••\s?|ending\s+in\s+)(\d{4})\b/i)
      if (m) cardLastFour = m[1]
    }

    // source_app: name of the originating app from the phone (e.g., "Cash
    // App", "Google Wallet"). MacroDroid's `[app_name]` magic text returns
    // the human-readable app name, which we match case-insensitively against
    // the user's payment_source names. Length-capped to keep the matching
    // loop bounded; trimmed of whitespace.
    const sourceApp: string | null =
      typeof body?.source_app === 'string' && body.source_app.trim().length > 0
        ? body.source_app.trim().slice(0, 100)
        : null

    // client_ref: optional opaque idempotency token from the client. Trimmed
    // and length-capped before any DB I/O. Lookup happens here; the DB unique
    // index is the backstop against race conditions.
    const clientRef: string | null =
      typeof body?.client_ref === 'string' &&
      body.client_ref.trim().length > 0 &&
      body.client_ref.length <= CLIENT_REF_MAX_LENGTH
        ? body.client_ref.trim()
        : null

    if (clientRef) {
      const existing = await findExistingByClientRef({
        userId: user.id,
        clientRef,
        accessToken,
        apiKeyAuth,
      })
      if (existing) {
        return NextResponse.json(
          { success: true, mode: 'idempotent', data: existing },
          { status: 200 }
        )
      }
    }

    // Detect mode: simple (structured) when "amount" is a number, AI when "text" is provided
    const isSimpleMode = typeof body?.amount === 'number'

    if (!isSimpleMode) {
      // `body.text` is `unknown` because the body parser is typed permissively;
      // the runtime checks below narrow it to a non-empty string before use.
      const rawText: unknown = body?.text
      if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        return NextResponse.json(
          { error: 'Request body must include either "amount" (simple mode) or "text" (AI mode).' },
          { status: 400 }
        )
      }
    }

    const text = isSimpleMode ? '' : (body.text as string).trim().slice(0, 2000)

    // --- Fetch user's categories and payment sources ---
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    let categories: { id: string; name: string }[] = []
    let paymentSources: { id: string; name: string; card_last_four?: string | null }[] = []

    const fetchHeaders = accessToken
      ? { 'Authorization': `Bearer ${accessToken}`, 'apikey': supabaseKey, 'Content-Type': 'application/json' }
      : null

    if (apiKeyAuth) {
      // API-key auth path uses the service-role key for all DB ops. Service
      // role bypasses RLS, so we apply user-scope filtering ourselves: for
      // payment_sources we filter to (user_id IS NULL OR user_id = caller's
      // user_id). categories is a global table — no filter needed. This makes
      // the path independent of SUPABASE_JWT_SECRET, which previously caused
      // silent zero-row reads when the env var was missing/wrong.
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) {
        console.error('Quick-add: SUPABASE_SERVICE_ROLE_KEY missing')
        return NextResponse.json(
          { error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is required for API-key auth.' },
          { status: 500 }
        )
      }
      const serviceHeaders = {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      }
      const safeUserId = encodeURIComponent(user.id)
      // PostgREST `or=` filter syntax: `or=(user_id.is.null,user_id.eq.<uuid>)`.
      const [catRes, srcRes] = await Promise.all([
        fetch(
          `${supabaseUrl}/rest/v1/categories?select=id,name&order=name`,
          { headers: serviceHeaders }
        ),
        fetch(
          `${supabaseUrl}/rest/v1/payment_sources` +
            `?or=(user_id.is.null,user_id.eq.${safeUserId})` +
            `&select=id,name,card_last_four&order=name`,
          { headers: serviceHeaders }
        ),
      ])
      if (catRes.ok) categories = await catRes.json()
      if (srcRes.ok) paymentSources = await srcRes.json()
      if (!catRes.ok || !srcRes.ok) {
        console.error(
          `Quick-add (API-key): categories=${catRes.status} payment_sources=${srcRes.status}`
        )
      }
    } else if (fetchHeaders) {
      const [catRes, srcRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, { headers: fetchHeaders }),
        fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name,card_last_four&order=name`, { headers: fetchHeaders }),
      ])
      if (catRes.ok) categories = await catRes.json()
      if (srcRes.ok) paymentSources = await srcRes.json()
    } else {
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
      if (catResult.data) categories = catResult.data
      if (srcResult.data) paymentSources = srcResult.data
    }

    if (categories.length === 0 || paymentSources.length === 0) {
      return NextResponse.json(
        { error: 'Please set up at least one category and payment source before using quick-add.' },
        { status: 400 }
      )
    }

    // ---- Resolve payment_source ----
    // Resolution priority:
    //   1. source_app name match (e.g., "Cash App" → payment_source named
    //      "Cash App"). Handles non-card sources cleanly.
    //   2. card_last_four match against payment_sources.card_last_four
    //      (Google Wallet's "Visa •• 1234" routes to the matching card).
    //   3. card_last_four with no existing match → auto-create a placeholder
    //      payment_source named "Card •• 1234" (best effort; tolerates RLS
    //      failure).
    //   4. None of the above → leave override unset; the simple/AI mode branch
    //      below falls back to the user's first payment source.
    let paymentSourceOverrideId: string | null = null

    // Priority 1: source_app name match.
    if (sourceApp) {
      const sourceAppLower = sourceApp.toLowerCase()
      const appMatch = paymentSources.find(
        s => s.name.toLowerCase() === sourceAppLower
      )
      if (appMatch) paymentSourceOverrideId = appMatch.id
    }

    // Priority 2 & 3: card_last_four (only if source_app didn't already win).
    if (!paymentSourceOverrideId && cardLastFour) {
      const match = paymentSources.find(s => s.card_last_four === cardLastFour)
      if (match) {
        paymentSourceOverrideId = match.id
      } else {
        const created = await tryCreatePaymentSource({
          userId: user.id,
          cardLastFour,
          accessToken,
          apiKeyAuth,
        })
        if (created) {
          paymentSourceOverrideId = created.id
          paymentSources.push(created)
        }
      }
    }

    // Compute "today" in the user's local timezone (stored in user_metadata
    // by the web client's TimezoneSync on every login). Falls back to UTC if
    // the user has never logged into the web app — keeps backward compat for
    // hypothetical API-key-only callers, but the web-app sync covers the
    // common MacroDroid case.
    const userTimezone =
      (user as { user_metadata?: { timezone?: string } } | null)?.user_metadata?.timezone
    const today = todayInTimezone(userTimezone)

    // Both modes produce a transactionPayload; only insertion logic follows.
    let transactionPayload: {
      amount: number
      type: 'income' | 'expense'
      date: string
      category: string
      payment_source: string
      notes: string | null
      image_url: null
      user_id: string
    }
    let mode: 'simple' | 'ai'

    if (isSimpleMode) {
      // ── Simple/fast mode: structured data, no AI call ──
      mode = 'simple'
      const rawAmount = body.amount as number

      // Zero means "I didn't pay anything" — skip silently so the caller doesn't need to handle it.
      if (rawAmount === 0) {
        return NextResponse.json({ success: true, mode: 'simple', skipped: true, data: null }, { status: 200 })
      }

      if (rawAmount < 0 || rawAmount > AMOUNT_MAX || !Number.isFinite(rawAmount)) {
        return NextResponse.json(
          { error: 'Amount must be a positive number up to 1,000,000,000.' },
          { status: 422 }
        )
      }

      const type: 'income' | 'expense' = body.type === 'income' ? 'income' : 'expense'
      const dateStr =
        typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
          ? body.date
          : today

      // Match category by name (case-insensitive) or UUID; default to first
      let categoryId = categories[0].id
      if (typeof body.category === 'string' && body.category.trim()) {
        const input = body.category.trim()
        const nameMatch = categories.find(c => c.name.toLowerCase() === input.toLowerCase())
        if (nameMatch) categoryId = nameMatch.id
        else if (isValidUuid(input)) {
          const idMatch = categories.find(c => c.id === input)
          if (idMatch) categoryId = idMatch.id
        }
      }

      // Match payment source: card_last_four override (Wallet notif) wins,
      // then body.payment_source by name or UUID, then default to first.
      let paymentSourceId = paymentSourceOverrideId ?? paymentSources[0].id
      if (!paymentSourceOverrideId && typeof body.payment_source === 'string' && body.payment_source.trim()) {
        const input = body.payment_source.trim()
        const nameMatch = paymentSources.find(s => s.name.toLowerCase() === input.toLowerCase())
        if (nameMatch) paymentSourceId = nameMatch.id
        else if (isValidUuid(input)) {
          const idMatch = paymentSources.find(s => s.id === input)
          if (idMatch) paymentSourceId = idMatch.id
        }
      }

      const notes = sanitizeHtml(
        typeof body.description === 'string' ? body.description.trim().slice(0, 200) : null
      )

      transactionPayload = {
        amount: rawAmount, type, date: dateStr,
        category: categoryId, payment_source: paymentSourceId,
        notes, image_url: null, user_id: user.id,
      }
    } else {
      // ── AI mode: natural language parsing ──
      mode = 'ai'
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) {
        return NextResponse.json({ error: 'AI service is not configured.' }, { status: 500 })
      }

      const categoriesList = categories.map(c => `- ${c.name} (ID: ${c.id})`).join('\n')
      const sourcesList = paymentSources.map(s => `- ${s.name} (ID: ${s.id})`).join('\n')

      const prompt = `You are a personal finance assistant. Parse the following text and extract a transaction.

Text: "${text}"

Today's date: ${today}

Available categories:
${categoriesList}

Available payment sources:
${sourcesList}

Rules:
- "type" must be "expense" when the user spent/paid/bought something, or "income" when they received/earned/got paid money.
- "amount" must be a positive number (no currency symbols).
- "date" must be YYYY-MM-DD. Use today if no date is mentioned.
- "category": pick the most relevant category ID from the list above.
- "payment_source": if a card/bank/cash is mentioned, pick the matching ID; otherwise use the first payment source ID.
- "notes": a short description (merchant name, purpose, or key detail). Max 200 characters.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "type": "expense" | "income",
  "amount": <number>,
  "date": "YYYY-MM-DD",
  "category": "<category_id>",
  "payment_source": "<payment_source_id>",
  "notes": "<string>"
}`

      const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          'X-Title': 'Finance Tracker',
        },
        body: JSON.stringify({
          model: QUICK_ADD_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          // Force JSON. Reasoning models can still wrap output in prose otherwise;
          // strict mode keeps the response a single valid JSON object.
          response_format: { type: 'json_object' },
          // Disable reasoning. DeepSeek V4 Pro (and other reasoning models on
          // OpenRouter) reason by default, which consumes the max_tokens budget
          // BEFORE producing any answer — leaving choices[0].message.content
          // empty. We don't need chain-of-thought to parse a payment notif.
          reasoning: { enabled: false },
        }),
      })

      if (!aiResponse.ok) {
        const errData = await aiResponse.json().catch(() => ({}))
        console.error('OpenRouter error:', aiResponse.status, errData.error?.message)
        if (aiResponse.status === 429) {
          return NextResponse.json({ error: 'AI rate limit exceeded. Please try again shortly.' }, { status: 429 })
        }
        return NextResponse.json({ error: 'AI service error. Please try again.' }, { status: 500 })
      }

      const aiData = await aiResponse.json()
      const content: string = aiData.choices?.[0]?.message?.content

      if (!content) {
        // Log the full response shape so future "no content" failures are
        // diagnosable from Vercel runtime logs (e.g., model returned an error
        // object, finish_reason='length', or content under a non-standard key).
        console.error(
          'Quick-add AI: empty content. aiData=',
          JSON.stringify(aiData).slice(0, 1000)
        )
        return NextResponse.json({ error: 'No response from AI model.' }, { status: 500 })
      }

      // Strip markdown code fences if present
      let jsonStr = content.trim()
      if (jsonStr.includes('```json')) {
        jsonStr = jsonStr.split('```json')[1].split('```')[0].trim()
      } else if (jsonStr.includes('```')) {
        jsonStr = jsonStr.split('```')[1].split('```')[0].trim()
      }

      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(jsonStr) as Record<string, unknown>
      } catch {
        // Fallback: some models (especially reasoning-mode) wrap JSON in prose
        // even when response_format=json_object is requested. Extract the
        // longest plausible JSON object — first '{' through last '}' — and try
        // again. If that also fails, give up cleanly.
        const firstBrace = jsonStr.indexOf('{')
        const lastBrace = jsonStr.lastIndexOf('}')
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          try {
            parsed = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>
          } catch {
            parsed = null
          }
        }
      }

      if (!parsed) {
        console.error('Failed to parse AI response as JSON')
        return NextResponse.json({ error: 'Failed to parse AI response. Please try again.' }, { status: 500 })
      }

      // Validate parsed fields
      const type = parsed.type === 'income' ? 'income' : 'expense'
      const rawAmount = parsed.amount
      const amount =
        typeof rawAmount === 'number' &&
        rawAmount > 0 &&
        rawAmount <= AMOUNT_MAX &&
        Number.isFinite(rawAmount)
          ? rawAmount
          : null
      if (!amount) {
        return NextResponse.json(
          { error: 'Could not determine amount from the provided text. Please include a number (e.g. "Spent 20.84 on Chipotle").' },
          { status: 422 }
        )
      }

      const dateStr: string =
        typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
          ? parsed.date
          : today

      // Validate category and payment_source against the fetched list — reject any AI-hallucinated IDs.
      const categoryId = categories.find(c => c.id === parsed.category)?.id ?? categories[0].id
      // Payment source: card_last_four override is authoritative (Wallet told us
      // exactly which card). Otherwise use the AI's pick, then fall back to first.
      const paymentSourceId =
        paymentSourceOverrideId
        ?? paymentSources.find(s => s.id === parsed.payment_source)?.id
        ?? paymentSources[0].id
      const notes = sanitizeHtml(typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : null)

      transactionPayload = {
        amount, type, date: dateStr,
        category: categoryId, payment_source: paymentSourceId,
        notes, image_url: null, user_id: user.id,
      }
    }

    // ---- Apply refund handling (post-processing for both modes) ----
    // Refunds are stored as type='income' so the running totals balance — the
    // user got money back. The is_refund flag lets reports separate "real
    // income" from "refund income". Notes are prefixed so the row is also
    // legible at a glance in the existing UI, which doesn't yet render the
    // is_refund flag.
    if (isRefund) {
      transactionPayload.type = 'income'
      const refundNote = transactionPayload.notes
        ? `Refund: ${transactionPayload.notes}`
        : 'Refund'
      transactionPayload.notes = refundNote.slice(0, 200)
    }

    // Build the final insert payload — same as transactionPayload plus the new
    // optional columns. Kept as a separate object so the existing payload
    // construction in each mode branch stays untouched.
    const insertPayload = {
      ...transactionPayload,
      is_refund: isRefund,
      // null when no client_ref was provided — Postgres skips the partial
      // unique index for NULL values, so legacy callers are unaffected.
      client_ref: clientRef,
    }

    // --- Insert transaction ---

    let transaction = null

    if (apiKeyAuth) {
      // Use service-role for the transaction insert on the API-key path.
      // The insertPayload already includes `user_id: user.id`, so even
      // though RLS is bypassed the row is correctly owned. Independent of
      // SUPABASE_JWT_SECRET.
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!serviceRoleKey) {
        console.error('Quick-add: SUPABASE_SERVICE_ROLE_KEY missing on transaction insert')
        return NextResponse.json(
          { error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is required for API-key auth.' },
          { status: 500 }
        )
      }
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(insertPayload),
      })
      if (!insertRes.ok) {
        // 409 with code 23505 means a concurrent retry already inserted this
        // (user_id, client_ref). Resolve idempotently: fetch the prior row.
        if (insertRes.status === 409 && clientRef) {
          const existing = await findExistingByClientRef({
            userId: user.id, clientRef, accessToken, apiKeyAuth,
          })
          if (existing) {
            return NextResponse.json(
              { success: true, mode: 'idempotent', data: existing },
              { status: 200 }
            )
          }
        }
        console.error('Supabase insert error (API key auth):', insertRes.status)
        return NextResponse.json({ error: 'Failed to save transaction. Please try again.' }, { status: 500 })
      }
      const result = await insertRes.json()
      transaction = Array.isArray(result) ? result[0] : result
    } else if (accessToken) {
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(insertPayload),
      })

      if (!insertRes.ok) {
        if (insertRes.status === 409 && clientRef) {
          const existing = await findExistingByClientRef({
            userId: user.id, clientRef, accessToken, apiKeyAuth,
          })
          if (existing) {
            return NextResponse.json(
              { success: true, mode: 'idempotent', data: existing },
              { status: 200 }
            )
          }
        }
        console.error('Supabase insert error:', insertRes.status)
        return NextResponse.json({ error: 'Failed to save transaction. Please try again.' }, { status: 500 })
      }

      const result = await insertRes.json()
      transaction = Array.isArray(result) ? result[0] : result
    } else {
      const cookieStore = await cookies()
      const supabase = createServerClient(supabaseUrl, supabaseKey, {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
          remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
        },
      })

      const { data, error: insertError } = await supabase
        .from('transactions')
        .insert([insertPayload])
        .select()
        .single()

      if (insertError || !data) {
        // PostgREST surfaces Postgres unique-violation as code '23505'.
        // Treat it as an idempotent retry and return the existing row.
        if (insertError?.code === PG_UNIQUE_VIOLATION && clientRef) {
          const existing = await findExistingByClientRef({
            userId: user.id, clientRef, accessToken, apiKeyAuth,
          })
          if (existing) {
            return NextResponse.json(
              { success: true, mode: 'idempotent', data: existing },
              { status: 200 }
            )
          }
        }
        console.error('Supabase insert error:', insertError?.message)
        return NextResponse.json({ error: 'Failed to save transaction. Please try again.' }, { status: 500 })
      }

      transaction = data
    }

    return NextResponse.json({ success: true, mode, data: transaction }, { status: 201 })
  } catch (error) {
    console.error('Quick-add error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to process request. Please try again.' }, { status: 500 })
  }
}
