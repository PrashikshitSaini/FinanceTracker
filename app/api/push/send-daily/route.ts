import { NextRequest, NextResponse } from 'next/server'
import { sendPush, isPushConfigured, type StoredSubscription } from '@/lib/push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/push/send-daily — Vercel Cron entry point (see vercel.json).
 *
 * For every user with a push subscription, computes their month-to-date
 * spending and sends a single "standing" summary notification (stable tag, so
 * each day's send replaces yesterday's in the tray rather than stacking).
 *
 * Auth: Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET`
 * when the CRON_SECRET env var is set — we reject anything else so the endpoint
 * can't be triggered by the public. Uses the Supabase service role to read
 * across users (RLS is bypassed intentionally, scoped by explicit user_id).
 *
 * NOTE: amounts are formatted as USD. This app supports multiple currencies
 * per user (client-side), but the server doesn't currently persist the choice.
 * For a multi-currency rollout, store the currency in user metadata and format
 * per user here. USD matches the current primary user.
 */

function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

export async function GET(request: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
    }
    if (!isPushConfigured()) {
      return NextResponse.json({ error: 'Push is not configured.' }, { status: 503 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: 'Server misconfigured.' }, { status: 500 })
    }
    const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }

    // 1) All subscriptions, grouped by user. `limit` guards against PostgREST's
    //    default 1000-row cap; well above any realistic near-term device count.
    //    (If the user base ever outgrows this, switch to keyset pagination.)
    const subsRes = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth&limit=2000`,
      { headers },
    )
    if (!subsRes.ok) {
      return NextResponse.json({ error: 'Failed to load subscriptions.' }, { status: 500 })
    }
    const rows = (await subsRes.json()) as Array<StoredSubscription & { user_id: string }>
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: true, users: 0, sent: 0 }, { status: 200 })
    }

    const byUser = new Map<string, StoredSubscription[]>()
    for (const r of rows) {
      const list = byUser.get(r.user_id) ?? []
      list.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth })
      byUser.set(r.user_id, list)
    }

    // Month-to-date lower bound (UTC). Good enough for a daily heartbeat.
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10)

    let sent = 0
    const deadEndpoints: string[] = []

    for (const [userId, subs] of byUser) {
      // 2) That user's month-to-date expenses.
      const txRes = await fetch(
        `${supabaseUrl}/rest/v1/transactions?select=amount` +
          `&user_id=eq.${encodeURIComponent(userId)}&type=eq.expense&date=gte.${monthStart}`,
        { headers },
      )
      const txRows = txRes.ok ? ((await txRes.json()) as Array<{ amount: number | string }>) : []
      const total = txRows.reduce((sum, t) => sum + Number(t.amount), 0)
      const count = txRows.length

      const payload = {
        title: 'Your spending this month',
        body: `You've spent ${formatUsd(total)} across ${count} transaction${count === 1 ? '' : 's'}.`,
        tag: 'finance-daily-summary',
        badgeCount: count,
        data: { url: `/?from=push&spent=${total.toFixed(2)}` },
      }

      // 3) Deliver to each of the user's devices; note dead endpoints to prune.
      //    Sequential is fine at current scale (small user base, 300s function
      //    timeout). Batch/queue this if the subscriber count grows large.
      for (const sub of subs) {
        const result = await sendPush(sub, payload)
        if (result.ok) sent++
        if (result.gone) deadEndpoints.push(sub.endpoint)
      }
    }

    // 4) Prune expired/unknown endpoints — one delete each. Building a PostgREST
    //    `in.(...)` list from raw endpoint URLs is error-prone (they contain
    //    delimiters), and dead endpoints are rare, so per-row eq. is correct
    //    and simple.
    for (const endpoint of deadEndpoints) {
      await fetch(
        `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
        { method: 'DELETE', headers },
      ).catch(() => {})
    }

    return NextResponse.json({ success: true, users: byUser.size, sent, pruned: deadEndpoints.length }, { status: 200 })
  } catch (err) {
    console.error('GET /api/push/send-daily error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Failed to send daily summaries.' }, { status: 500 })
  }
}
