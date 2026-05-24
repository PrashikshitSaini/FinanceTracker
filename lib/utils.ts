import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a YYYY-MM-DD string as a date in the user's LOCAL timezone.
 *
 * `new Date('2026-05-23')` treats the input as UTC midnight, which for any
 * westward timezone (e.g., US Central UTC-5) renders as the PREVIOUS day in
 * the browser's locale — so a transaction dated 2026-05-23 in the DB displays
 * as "May 22" in the US. Splitting the components and using the Date
 * constructor avoids the UTC interpretation entirely.
 *
 * For ISO timestamps that include a time/zone (e.g., `created_at`), pass them
 * directly to `new Date(...)` — those parse correctly into local time.
 */
export function parseLocalDate(dateString: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [year, month, day] = dateString.split('-').map(Number)
    return new Date(year, month - 1, day)
  }
  return new Date(dateString)
}

/**
 * Return today's date as a YYYY-MM-DD string in the browser's LOCAL timezone.
 *
 * The naive `new Date().toISOString().split('T')[0]` returns UTC today, which
 * for any US (or other westward) timezone past ~5 PM is *tomorrow's* date.
 * That bug surfaces as transactions created in the evening being filed under
 * the next calendar day in the user's view. This helper uses the local
 * year/month/day components instead.
 *
 * Use this anywhere a "today" default needs to match what the user sees on
 * their phone/wall clock.
 */
export function getLocalTodayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

