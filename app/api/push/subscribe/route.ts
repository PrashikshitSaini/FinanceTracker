import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'

/**
 * POST   /api/push/subscribe   — save (upsert) the caller's Web Push subscription.
 * DELETE /api/push/subscribe   — remove one of the caller's subscriptions by endpoint.
 *
 * Auth is the cookie session (the app's browser client stores it in cookies),
 * and all writes go through the RLS-bound Supabase client so a user can only
 * ever touch their own rows. The daily cron send path uses the service role.
 */

async function getUserClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) return null
  const cookieStore = await cookies()
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value },
      set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
      remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
    },
  })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  return { supabase, userId: user.id }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getUserClient()
    if (!auth) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const subscription = body?.subscription
    const endpoint = subscription?.endpoint
    const p256dh = subscription?.keys?.p256dh
    const authKey = subscription?.keys?.auth

    if (!isHttpsUrl(endpoint) || typeof p256dh !== 'string' || typeof authKey !== 'string') {
      return NextResponse.json({ error: 'Invalid subscription.' }, { status: 400 })
    }

    // Upsert on the unique endpoint so re-subscribing the same device refreshes
    // its keys (and re-claims ownership) instead of erroring or duplicating.
    const { error } = await auth.supabase
      .from('push_subscriptions')
      .upsert(
        { user_id: auth.userId, endpoint, p256dh, auth: authKey, last_used_at: new Date().toISOString() },
        { onConflict: 'endpoint' },
      )

    if (error) {
      if (process.env.NODE_ENV === 'development') console.error('subscribe upsert error:', error.message)
      return NextResponse.json({ error: 'Failed to save subscription.' }, { status: 500 })
    }
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error('POST /api/push/subscribe error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to process request.' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await getUserClient()
    if (!auth) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const endpoint = body?.endpoint
    if (!isHttpsUrl(endpoint)) {
      return NextResponse.json({ error: 'Invalid endpoint.' }, { status: 400 })
    }

    // RLS restricts the delete to the caller's own rows even without the
    // user_id filter, but we scope explicitly as defense in depth.
    const { error } = await auth.supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', auth.userId)

    if (error) {
      if (process.env.NODE_ENV === 'development') console.error('unsubscribe delete error:', error.message)
      return NextResponse.json({ error: 'Failed to remove subscription.' }, { status: 500 })
    }
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('DELETE /api/push/subscribe error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to process request.' }, { status: 500 })
  }
}
