import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sendPush, isPushConfigured, type StoredSubscription } from '@/lib/push'

export const runtime = 'nodejs'

/**
 * POST /api/push/test — send a test push to every device the caller has
 * subscribed. Used from the notification-settings UI so the user can confirm
 * delivery on their phone right after enabling. Cookie-authenticated; reads
 * the caller's own subscriptions via RLS.
 */
export async function POST() {
  try {
    if (!isPushConfigured()) {
      return NextResponse.json({ error: 'Push is not configured on the server.' }, { status: 503 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Server misconfigured.' }, { status: 500 })
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
        remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
      },
    })

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
    const subscriptions = (subs as StoredSubscription[]) ?? []
    if (subscriptions.length === 0) {
      return NextResponse.json({ error: 'No subscriptions found for this account.' }, { status: 404 })
    }

    const payload = {
      title: 'Finance Tracker',
      body: "🎉 Alerts are on! You'll see your spending here.",
      tag: 'finance-test',
      badgeCount: 1,
      data: { url: '/?from=push' },
    }

    let sent = 0
    for (const sub of subscriptions) {
      const result = await sendPush(sub, payload)
      if (result.ok) sent++
      // Prune a dead endpoint so it doesn't linger (RLS-scoped delete).
      if (result.gone) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
      }
    }

    return NextResponse.json({ success: true, sent }, { status: 200 })
  } catch (err) {
    console.error('POST /api/push/test error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to send test notification.' }, { status: 500 })
  }
}
