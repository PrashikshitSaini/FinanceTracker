'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * On first render after login, capture the browser's IANA timezone (e.g.
 * "America/Chicago") and store it on the user's Supabase auth metadata if
 * it isn't already there or has changed (user moved cities, traveled, etc.).
 *
 * Server-side API routes read `user.user_metadata.timezone` when computing
 * "today" — so a user who logs into the web app even once gets their
 * timezone propagated to every subsequent API call, including ones triggered
 * by MacroDroid where there's no browser context to detect it from.
 *
 * No-ops cleanly when:
 *   - User isn't logged in (nothing to attach to)
 *   - Browser can't resolve a timezone (rare; falls back to UTC server-side)
 *   - Stored value already matches (saves a needless updateUser call + token
 *     refresh)
 */
export default function TimezoneSync() {
  useEffect(() => {
    let cancelled = false

    async function sync() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return

      let browserTz: string | undefined
      try {
        browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        return
      }
      if (!browserTz) return

      // Skip the write if it would be a no-op. user_metadata is JSONB on the
      // auth side — comparing the single field we care about is enough.
      const existing = (user.user_metadata as Record<string, unknown> | undefined)?.timezone
      if (existing === browserTz) return

      await supabase.auth.updateUser({
        data: {
          ...(user.user_metadata ?? {}),
          timezone: browserTz,
        },
      })
    }

    sync().catch(() => {
      // Silent — timezone sync is a progressive enhancement, not blocking.
    })

    return () => { cancelled = true }
  }, [])

  return null
}
