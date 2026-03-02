import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/ai-chat
 * Server-side API route for OpenRouter AI chat requests
 * This keeps the API key secure on the server
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user - try Authorization header first, then fallback to cookies
    const authHeader = request.headers.get('Authorization')
    let user = null

    if (authHeader?.startsWith('Bearer ')) {
      // Verify the access token by calling Supabase auth API
      const token = authHeader.replace('Bearer ', '')
      try {
        const verifyResponse = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          }
        )
        
        if (verifyResponse.ok) {
          const userData = await verifyResponse.json()
          user = userData
        }
      } catch (err) {
        // Log error without exposing sensitive token information
        console.error('Token verification error:', err instanceof Error ? err.message : 'Unknown error')
        // Will fallback to cookie-based auth
      }
    }

    // Fallback to cookie-based auth if token verification didn't work
    if (!user) {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            get(name: string) {
              return cookieStore.get(name)?.value
            },
            set(name: string, value: string, options: any) {
              cookieStore.set({ name, value, ...options })
            },
            remove(name: string, options: any) {
              cookieStore.set({ name, value: '', ...options })
            },
          },
        }
      )

      const { data: { user: cookieUser }, error: authError } = await supabase.auth.getUser()
      if (!authError && cookieUser) {
        user = cookieUser
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in to use the AI assistant.' },
        { status: 401 }
      )
    }

    // Check rate limit (after authentication)
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.AI_CHAT)
    if (!rateLimitResult.success) {
      const resetIn = rateLimitResult.resetTime
        ? Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        : 60
      return NextResponse.json(
        {
          error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.`,
        },
        { status: 429 }
      )
    }

    // Get API key from server-side environment variable (not NEXT_PUBLIC_)
    const apiKey = process.env.OPENROUTER_API_KEY
    
    if (!apiKey) {
      console.error('OpenRouter API key is not configured')
      return NextResponse.json(
        { error: 'AI service is not configured. Please contact support.' },
        { status: 500 }
      )
    }

    // Parse request body
    const body = await request.json()
    const { messages } = body

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Invalid request. Messages array is required.' },
        { status: 400 }
      )
    }

    // Cap message count and per-message content length to prevent token exhaustion and prompt injection.
    // 50 messages × 4 000 chars ≈ ~200 KB of context — generous for a chat but bounded.
    const MAX_MESSAGES = 50
    const MAX_CONTENT_LENGTH = 4000
    if (messages.length > MAX_MESSAGES) {
      return NextResponse.json(
        { error: 'Too many messages in conversation history.' },
        { status: 400 }
      )
    }

    const ALLOWED_ROLES = new Set(['user', 'assistant', 'system'])
    for (const msg of messages) {
      if (typeof msg !== 'object' || msg === null) {
        return NextResponse.json({ error: 'Invalid message format.' }, { status: 400 })
      }
      if (!ALLOWED_ROLES.has(msg.role)) {
        return NextResponse.json({ error: 'Invalid message role.' }, { status: 400 })
      }
      if (typeof msg.content !== 'string' || msg.content.length > MAX_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: 'Message content exceeds maximum length.' },
          { status: 400 }
        )
      }
    }

    // retries is server-controlled only — never accept from client input
    const MAX_RETRIES = 3

    // Call OpenRouter API with retry logic
    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
            'X-Title': 'Finance Tracker',
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: messages,
          }),
        })

        // Check for rate limit (429) - don't retry, just fail gracefully
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after')
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000 // Default to 60 seconds
          return NextResponse.json(
            { 
              error: `Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds before trying again.` 
            },
            { status: 429 }
          )
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          const errorMessage = errorData.error?.message || response.statusText
          
          // Log detailed error server-side only (don't expose to client)
          console.error('OpenRouter API error:', response.status, errorMessage)
          
          // Retry on 5xx errors
          if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
            lastError = new Error('AI service temporarily unavailable')
            continue
          }
          
          // Return generic error message to client (don't expose API details)
          if (response.status === 401 || response.status === 403) {
            return NextResponse.json(
              { error: 'AI service authentication failed. Please try again later.' },
              { status: 500 }
            )
          }
          
          return NextResponse.json(
            { error: 'AI service error. Please try again later.' },
            { status: 500 }
          )
        }

        const data = await response.json()
        
        if (!data.choices || !data.choices[0]?.message?.content) {
          return NextResponse.json(
            { error: 'Invalid response format from OpenRouter API' },
            { status: 500 }
          )
        }
        
        return NextResponse.json({ 
          success: true, 
          content: data.choices[0].message.content 
        })
      } catch (error) {
        // If it's the last attempt or not a retryable error, throw
        if (attempt === MAX_RETRIES - 1 || !(error instanceof Error && error.message.includes('429'))) {
          lastError = error instanceof Error ? error : new Error('Unknown error')
          break
        }
        // Otherwise, wait and retry
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
      }
    }
    
    // If we get here, all retries failed
    return NextResponse.json(
      { 
        error: 'AI service is temporarily unavailable. Please try again later.' 
      },
      { status: 500 }
    )
  } catch (error: any) {
    // Log detailed error server-side only
    console.error('AI chat API error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to process AI chat request. Please try again.' },
      { status: 500 }
    )
  }
}
