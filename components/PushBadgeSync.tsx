'use client'

import { useEffect } from 'react'

/**
 * Clears the app-icon badge whenever the app is opened or brought to the
 * foreground. The badge (a number on iOS, a dot on Android) is set by the
 * service worker when a push arrives; clearing it on focus keeps it meaning
 * "there's something new since you last looked." Pure side effect.
 *
 * `clearAppBadge` is unsupported on some browsers (notably Android Chrome only
 * shows an auto dot) — the capability check + try/catch make this a safe no-op
 * there.
 */
export default function PushBadgeSync() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('clearAppBadge' in navigator)) return

    const clear = () => {
      if (document.visibilityState === 'visible') {
        navigator.clearAppBadge().catch(() => { /* unsupported — ignore */ })
      }
    }

    clear() // clear on initial mount (app just opened)
    document.addEventListener('visibilitychange', clear)
    window.addEventListener('focus', clear)
    return () => {
      document.removeEventListener('visibilitychange', clear)
      window.removeEventListener('focus', clear)
    }
  }, [])

  return null
}
