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

