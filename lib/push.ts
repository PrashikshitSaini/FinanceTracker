import webpush from 'web-push'

/**
 * Server-side Web Push helper.
 *
 * VAPID keys and subject come from env (never the client):
 *   VAPID_PUBLIC_KEY   — also exposed to the client as NEXT_PUBLIC_VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY  — secret, server only
 *   VAPID_SUBJECT      — a mailto: or https: contact URL (push services require it)
 *
 * `ensureConfigured` is lazy + idempotent so we never call setVapidDetails at
 * module scope (which would throw at import time if the env vars are missing).
 */

let configured = false

export function ensureConfigured(): boolean {
  if (configured) return true
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:notifications@financetracker.app'
  if (!publicKey || !privateKey) return false
  webpush.setVapidDetails(subject, publicKey, privateKey)
  configured = true
  return true
}

export function isPushConfigured(): boolean {
  return ensureConfigured()
}

export interface StoredSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

export interface SendResult {
  ok: boolean
  /** True when the push service reports the subscription is dead (404/410) so
   *  the caller can prune it. */
  gone: boolean
}

/**
 * Send a single push. `payload` is serialized to JSON and read by the service
 * worker's `push` handler. Never throws — failures are returned so the caller
 * can decide whether to prune the subscription.
 */
export async function sendPush(sub: StoredSubscription, payload: unknown): Promise<SendResult> {
  if (!ensureConfigured()) return { ok: false, gone: false }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    )
    return { ok: true, gone: false }
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode
    // 404 = endpoint unknown, 410 = subscription expired/unsubscribed.
    return { ok: false, gone: statusCode === 404 || statusCode === 410 }
  }
}
