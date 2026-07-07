// Minimal service worker.
//
// Chrome on Android requires a registered service worker with a fetch handler
// before it will offer the "Install app" prompt (without one, users only get
// the weaker "Add to Home Screen" shortcut that opens in the browser).
//
// We deliberately do NOT cache anything here — the app uses Supabase + an
// authenticated session, so a stale cache would surface wrong / stale data to
// the user. The fetch handler is therefore a pure pass-through to the network.
// If we later want offline support, we'd add a network-first cache strategy
// for /static assets only, leaving API and authenticated routes uncached.

self.addEventListener('install', (event) => {
  // Activate immediately on first install so the install prompt becomes
  // available on the very first visit, not the second.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Take control of any open pages so subsequent fetches go through this SW.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Pass through. The listener has to exist for Chrome's installability
  // criteria; the behavior itself is exactly what would happen without an SW.
  event.respondWith(fetch(event.request))
})

// ─── Web Push ────────────────────────────────────────────────────────────────
// The server (see /api/push/*) sends a JSON payload: { title, body, tag,
// badgeCount, data: { url } }. We show it as a notification and, where the
// platform supports it, set the app-icon badge (a number on iOS, a dot on
// Android). A stable `tag` + renotify means a fresh daily summary replaces the
// previous one in the tray instead of stacking.
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (e) {
    payload = { body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || 'Finance Tracker'
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.png',
    badge: payload.badge || '/icon.png',
    tag: payload.tag || 'finance-summary',
    renotify: true,
    data: payload.data || {},
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options)
    if (typeof payload.badgeCount === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
      try {
        await self.navigator.setAppBadge(payload.badgeCount)
      } catch (e) {
        // Unsupported (e.g. Android Chrome shows an auto dot) — ignore.
      }
    }
  })())
})

// Focus an existing tab (or open one) at the notification's target URL when
// tapped. The URL carries ?from=push&spent=NNN so the app can show the
// in-app count-up reveal.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const targetUrl = data.url || '/?from=push'

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) {
          try { await client.navigate(targetUrl) } catch (e) { /* cross-origin/nav guard — ignore */ }
        }
        return
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl)
    }
  })())
})
