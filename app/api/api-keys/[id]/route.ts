import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// RFC 4122 UUID v4 pattern — validate every ID before it enters a URL or query.
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
 * DELETE /api/api-keys/[id]
 * Deletes an API key that belongs to the authenticated user.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  // Reject non-UUID values before they reach any external service.
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 })
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceHeaders = {
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
  }

  // Verify ownership before deleting — both id and user_id are UUID-validated above.
  const checkRes = await fetch(
    `${supabaseUrl}/rest/v1/quick_add_api_keys?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=id`,
    { headers: serviceHeaders }
  )

  if (!checkRes.ok) {
    return NextResponse.json({ error: 'Failed to verify key ownership' }, { status: 500 })
  }

  const rows = await checkRes.json()
  if (!rows.length) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 })
  }

  const deleteRes = await fetch(
    `${supabaseUrl}/rest/v1/quick_add_api_keys?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}`,
    { method: 'DELETE', headers: serviceHeaders }
  )

  if (!deleteRes.ok) {
    return NextResponse.json({ error: 'Failed to delete key' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
