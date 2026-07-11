'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Bell, BellOff, Loader2, Send } from 'lucide-react'

/**
 * Spending-alerts settings, shown in a dialog from the header menu.
 *
 * Flow: request Notification permission (must be a user gesture — the button
 * click), subscribe via the service worker's PushManager using the public VAPID
 * key, then POST the subscription to the server. "Send test" fires a push to
 * confirm delivery on-device.
 *
 * On Android/Chrome the app-icon badge is only a dot (the number lives in the
 * push text); on iOS an installed PWA can show the number. Web push on iOS
 * requires the app be added to the Home Screen first.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

// VAPID public keys are URL-safe base64; PushManager needs the raw bytes.
// Allocate over an explicit ArrayBuffer so the result is a
// Uint8Array<ArrayBuffer> that satisfies BufferSource (applicationServerKey).
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const output = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

type Status = 'checking' | 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on'

export default function NotificationSettings() {
  const [status, setStatus] = useState<Status>('checking')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function detect() {
      if (typeof window === 'undefined') return
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!cancelled) setStatus('unsupported')
        return
      }
      if (!VAPID_PUBLIC_KEY) {
        if (!cancelled) setStatus('unconfigured')
        return
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setStatus('denied')
        return
      }
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (!cancelled) setStatus(sub ? 'on' : 'off')
      } catch {
        if (!cancelled) setStatus('off')
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  const enable = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off')
        setMessage('Notifications were not allowed.')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
      const json = sub.toJSON()
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          subscription: { endpoint: json.endpoint, keys: json.keys },
        }),
      })
      if (!res.ok) {
        const info = await res.json().catch(() => ({}))
        setMessage(
          `Could not save your subscription (${res.status}${info?.error ? `: ${info.error}` : ''}).`,
        )
        setStatus('off')
        return
      }
      setStatus('on')
      setMessage('Spending alerts are on. 🎉')
    } catch {
      setMessage('Something went wrong enabling alerts.')
      setStatus('off')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        await sub.unsubscribe().catch(() => {})
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ endpoint }),
        }).catch(() => {})
      }
      if ('clearAppBadge' in navigator) {
        try { await navigator.clearAppBadge() } catch { /* unsupported — ignore */ }
      }
      setStatus('off')
      setMessage('Alerts turned off.')
    } catch {
      setMessage('Could not turn off alerts.')
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/push/test', { method: 'POST', credentials: 'include' })
      const json = await res.json().catch(() => ({}))
      setMessage(res.ok ? `Test sent to ${json.sent ?? 0} device(s). Check your notifications.` : (json.error || 'Could not send test.'))
    } catch {
      setMessage('Could not send test.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Get a daily summary of your spending, right on your phone. Tap it to open Finance Tracker.
      </p>

      {status === 'checking' && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking…
        </div>
      )}

      {status === 'unsupported' && (
        <p className="text-muted-foreground">
          This browser doesn&apos;t support push notifications. On iPhone, add the app to your Home Screen first.
        </p>
      )}

      {status === 'unconfigured' && (
        <p className="text-muted-foreground">
          Notifications aren&apos;t set up on the server yet (missing VAPID key).
        </p>
      )}

      {status === 'denied' && (
        <p className="text-muted-foreground">
          Notifications are blocked for this app. Enable them in your browser/site settings, then reopen this.
        </p>
      )}

      {status === 'off' && (
        <Button onClick={enable} disabled={busy} className="w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
          <span className="ml-2">Enable spending alerts</span>
        </Button>
      )}

      {status === 'on' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <Bell className="h-4 w-4" /> Alerts are on for this device.
          </div>
          <div className="flex gap-2">
            <Button onClick={sendTest} disabled={busy} variant="outline" size="sm" className="flex-1">
              <Send className="h-4 w-4" /> <span className="ml-2">Send test</span>
            </Button>
            <Button onClick={disable} disabled={busy} variant="outline" size="sm" className="flex-1">
              <BellOff className="h-4 w-4" /> <span className="ml-2">Turn off</span>
            </Button>
          </div>
        </div>
      )}

      {message && <p className="text-muted-foreground">{message}</p>}
    </div>
  )
}
