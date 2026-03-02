import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createHash, randomBytes } from 'crypto'

const MAX_KEYS_PER_USER = 10

// RFC 4122 UUID v4 pattern — used to validate every ID before it enters a URL or query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value)
}

async function getAuthenticatedUser() {
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
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  // Guard: Supabase should always return a UUID, but verify before trusting it in URLs.
  if (!isValidUuid(user.id)) return null
  return user
}

/**
 * GET /api/api-keys
 * Returns all API keys for the authenticated user (never the hash).
 */
export async function GET() {
  const user = await getAuthenticatedUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  // user.id is UUID-validated above; encodeURIComponent is a second layer of defense.
  const res = await fetch(
    `${supabaseUrl}/rest/v1/quick_add_api_keys?select=id,name,key_prefix,created_at,last_used_at&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`,
    {
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
    }
  )

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
  }

  const keys = await res.json()
  return NextResponse.json(keys)
}

/**
 * POST /api/api-keys
 * Creates a new API key for the authenticated user.
 * Returns the full key exactly once — it is never stored.
 */
export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const body = await request.json().catch(() => ({}))
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'My Key'

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceHeaders = {
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }

  // Check existing key count
  const countRes = await fetch(
    `${supabaseUrl}/rest/v1/quick_add_api_keys?user_id=eq.${encodeURIComponent(user.id)}&select=id`,
    { headers: serviceHeaders }
  )
  if (countRes.ok) {
    const existing = await countRes.json()
    if (existing.length >= MAX_KEYS_PER_USER) {
      return NextResponse.json(
        { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed. Delete an existing key first.` },
        { status: 400 }
      )
    }
  }

  // Generate key: ftqa_ + 32 random hex chars
  const rawKey = 'ftqa_' + randomBytes(16).toString('hex')
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 16) // "ftqa_" + 11 hex chars

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/quick_add_api_keys`, {
    method: 'POST',
    headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name,
    }),
  })

  if (!insertRes.ok) {
    console.error('API key insert error:', insertRes.status)
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
  }

  const [created] = await insertRes.json()
  return NextResponse.json({
    id: created.id,
    name: created.name,
    key_prefix: created.key_prefix,
    created_at: created.created_at,
    last_used_at: null,
    key: rawKey, // returned exactly once
  }, { status: 201 })
}
