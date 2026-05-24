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
