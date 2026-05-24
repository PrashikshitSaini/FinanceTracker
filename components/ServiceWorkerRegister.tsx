'use client'

import { useEffect } from 'react'

/**
 * Registers /sw.js so Chrome on Android upgrades the site from "Add to Home
 * Screen" to a real "Install app" prompt. Returns nothing — pure side effect.
 *
 * The service worker itself (see public/sw.js) deliberately does no caching;
 * it exists only to satisfy Chrome's installability requirement that the site
 * have a registered SW with a fetch handler.
 *
 * Registration failure is swallowed silently: the SW is a progressive
 * enhancement, not required for the app to work.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return

    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Intentionally silent — see component comment above.
    })
  }, [])

  return null
}
