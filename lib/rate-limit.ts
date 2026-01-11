/**
 * Simple in-memory rate limiter for serverless functions
 * Uses user ID as the key for rate limiting
 * 
 * Note: This works per-instance (not shared across serverless instances),
 * but provides protection within each instance. For production scale,
 * consider using a distributed solution like @upstash/ratelimit
 */

interface RateLimitEntry {
  count: number
  resetTime: number
}

// In-memory store (per-instance)
const rateLimitStore = new Map<string, RateLimitEntry>()

// Cleanup old entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetTime < now) {
        rateLimitStore.delete(key)
      }
    }
  }, 5 * 60 * 1000) // Clean up every 5 minutes
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  limit: number // Maximum requests
  window: number // Time window in milliseconds
}

/**
 * Check if a user has exceeded the rate limit
 * @param userId - User ID to rate limit
 * @param config - Rate limit configuration
 * @returns Object with success status and reset time if limited
 */
export function checkRateLimit(
  userId: string,
  config: RateLimitConfig
): { success: boolean; resetTime?: number; remaining?: number } {
  try {
    const now = Date.now()
    const key = userId
    const entry = rateLimitStore.get(key)

    // If no entry or reset time passed, create new entry
    if (!entry || entry.resetTime < now) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + config.window,
      })
      return { success: true, remaining: config.limit - 1 }
    }

    // Check if limit exceeded
    if (entry.count >= config.limit) {
      const resetIn = Math.ceil((entry.resetTime - now) / 1000) // seconds
      return {
        success: false,
        resetTime: entry.resetTime,
      }
    }

    // Increment count
    entry.count++
    rateLimitStore.set(key, entry)

    return {
      success: true,
      remaining: config.limit - entry.count,
    }
  } catch (error) {
    // Graceful degradation: if rate limiting fails, allow the request
    // This prevents breaking the app if there's an issue
    console.error('Rate limit check error:', error instanceof Error ? error.message : 'Unknown error')
    return { success: true }
  }
}

/**
 * Default rate limit configs for different endpoints
 */
export const RATE_LIMITS = {
  AI_CHAT: { limit: 10, window: 60 * 1000 }, // 10 requests per minute
  RECEIPT: { limit: 20, window: 60 * 1000 }, // 20 requests per minute
} as const
