import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createHash, createHmac } from 'crypto'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sanitizeHtml } from '@/lib/validation'

/**
 * Signs a short-lived Supabase-compatible JWT so PostgREST treats the request
 * as coming from `userId` and applies RLS normally — without needing the user's
 * actual session token.
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

// RFC 4122 UUID v4 — used to validate user IDs returned from auth paths before use in URLs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// API keys are "ftqa_" + 32 hex chars = 37 chars. Allow a small buffer; reject anything absurdly large
// before it reaches the hash function to prevent CPU-bound DoS via huge headers.
const API_KEY_MAX_LENGTH = 256

const AMOUNT_MAX = 1_000_000_000

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
    const body = await request.json()

    // Detect mode: simple (structured) when "amount" is a number, AI when "text" is provided
    const isSimpleMode = typeof body?.amount === 'number'

    if (!isSimpleMode) {
      const rawText: string = body?.text
      if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
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
    let paymentSources: { id: string; name: string }[] = []

    const fetchHeaders = accessToken
      ? { 'Authorization': `Bearer ${accessToken}`, 'apikey': supabaseKey, 'Content-Type': 'application/json' }
      : null

    if (apiKeyAuth) {
      const userJwt = signUserJwt(user.id)
      if (userJwt) {
        const userHeaders = {
          'Authorization': `Bearer ${userJwt}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
        }
        const [catRes, srcRes] = await Promise.all([
          fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, { headers: userHeaders }),
          fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name&order=name`, { headers: userHeaders }),
        ])
        if (catRes.ok) categories = await catRes.json()
        if (srcRes.ok) paymentSources = await srcRes.json()
      }
    } else if (fetchHeaders) {
      const [catRes, srcRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, { headers: fetchHeaders }),
        fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name&order=name`, { headers: fetchHeaders }),
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
        supabase.from('payment_sources').select('id, name').order('name'),
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

    const today = new Date().toISOString().split('T')[0]

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

      // Match payment source by name (case-insensitive) or UUID; default to first
      let paymentSourceId = paymentSources[0].id
      if (typeof body.payment_source === 'string' && body.payment_source.trim()) {
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
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
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
        return NextResponse.json({ error: 'No response from AI model.' }, { status: 500 })
      }

      // Strip markdown code fences if present
      let jsonStr = content.trim()
      if (jsonStr.includes('```json')) {
        jsonStr = jsonStr.split('```json')[1].split('```')[0].trim()
      } else if (jsonStr.includes('```')) {
        jsonStr = jsonStr.split('```')[1].split('```')[0].trim()
      }

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
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
      const paymentSourceId = paymentSources.find(s => s.id === parsed.payment_source)?.id ?? paymentSources[0].id
      const notes = sanitizeHtml(typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : null)

      transactionPayload = {
        amount, type, date: dateStr,
        category: categoryId, payment_source: paymentSourceId,
        notes, image_url: null, user_id: user.id,
      }
    }

    // --- Insert transaction ---

    let transaction = null

    if (apiKeyAuth) {
      const userJwt = signUserJwt(user.id)!
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${userJwt}`,
          'apikey': supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(transactionPayload),
      })
      if (!insertRes.ok) {
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
        body: JSON.stringify(transactionPayload),
      })

      if (!insertRes.ok) {
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
        .insert([transactionPayload])
        .select()
        .single()

      if (insertError || !data) {
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
