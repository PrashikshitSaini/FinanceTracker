import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { receiptExtractionSchema } from '@/lib/validation'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  try {
    const { imageBase64 } = await request.json()

    if (!imageBase64) {
      return NextResponse.json(
        { error: 'Image is required' },
        { status: 400 }
      )
    }

    // Get authenticated user - try Authorization header first (from client), then fallback to cookies
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
      const supabaseClient = createServerClient(
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

      const { data: { user: cookieUser }, error: authError } = await supabaseClient.auth.getUser()
      if (!authError && cookieUser) {
        user = cookieUser
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    // Check rate limit (after authentication)
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.RECEIPT)
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

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OpenRouter API key is not configured' },
        { status: 500 }
      )
    }

    // Get available categories and payment sources for context
    // Use Supabase REST API directly with the access token
    const accessToken = authHeader?.replace('Bearer ', '') || null
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    
    let categories: { id: string; name: string }[] = []
    let paymentSources: { id: string; name: string }[] = []
    
    if (accessToken) {
      // Use REST API with access token
      try {
        const [categoriesResponse, sourcesResponse] = await Promise.all([
          fetch(`${supabaseUrl}/rest/v1/categories?select=id,name&order=name`, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'apikey': supabaseKey,
              'Content-Type': 'application/json',
            },
          }),
          fetch(`${supabaseUrl}/rest/v1/payment_sources?select=id,name&order=name`, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'apikey': supabaseKey,
              'Content-Type': 'application/json',
            },
          }),
        ])
        
        if (categoriesResponse.ok) {
          categories = await categoriesResponse.json()
        }
        if (sourcesResponse.ok) {
          paymentSources = await sourcesResponse.json()
        }
      } catch (err) {
        // Log error without exposing user data
        console.error('Error fetching categories/sources:', err instanceof Error ? err.message : 'Unknown error')
        // Fallback to cookie-based client
        const cookieStore = await cookies()
        const supabaseForQuery = createServerClient(
          supabaseUrl,
          supabaseKey,
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
        const [categoriesResult, sourcesResult] = await Promise.all([
          supabaseForQuery.from('categories').select('id, name').order('name'),
          supabaseForQuery.from('payment_sources').select('id, name').order('name')
        ])
        if (categoriesResult.data) categories = categoriesResult.data
        if (sourcesResult.data) paymentSources = sourcesResult.data
      }
    } else {
      // Fallback to cookie-based client
      const cookieStore = await cookies()
      const supabaseForQuery = createServerClient(
        supabaseUrl,
        supabaseKey,
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
      const [categoriesResult, sourcesResult] = await Promise.all([
        supabaseForQuery.from('categories').select('id, name').order('name'),
        supabaseForQuery.from('payment_sources').select('id, name').order('name')
      ])
      if (categoriesResult.data) categories = categoriesResult.data
      if (sourcesResult.data) paymentSources = sourcesResult.data
    }

    if (categories.length === 0 || paymentSources.length === 0) {
      return NextResponse.json(
        { error: 'Please set up at least one category and payment source before scanning receipts.' },
        { status: 400 }
      )
    }

    // Prepare the prompt for receipt extraction
    const categoriesList = categories.map(c => `- ${c.name} (ID: ${c.id})`).join('\n')
    const sourcesList = paymentSources.map(s => `- ${s.name} (ID: ${s.id})`).join('\n')

    const prompt = `You are a receipt scanning assistant. Analyze this receipt image and extract the following information:

1. **Total amount** (required) - Extract the total amount paid
2. **Date** (optional) - Extract the transaction date from the receipt. If not found, use today's date: ${new Date().toISOString().split('T')[0]}
3. **Category** (required) - Match the merchant/store name or items purchased to the most appropriate category from this list:
${categoriesList}

4. **Payment source** (required) - If you can determine the payment method (cash, card type, etc.), match it to the most appropriate payment source from this list:
${sourcesList}
If unclear, use the first payment source in the list.

5. **Notes** (optional) - Extract merchant name, key items purchased, or any other relevant information

IMPORTANT: Return ONLY a valid JSON object with this exact structure (no markdown, no explanations):
{
  "amount": <number>,
  "date": "YYYY-MM-DD",
  "category": "<category_id>",
  "payment_source": "<payment_source_id>",
  "notes": "<string or null>"
}

If you cannot extract required fields, use these defaults:
- amount: 0 (user will need to correct)
- category: first category ID from the list
- payment_source: first payment source ID from the list
- date: ${new Date().toISOString().split('T')[0]}
- notes: null`

    // Call OpenRouter API with vision model
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Finance Tracker',
      },
      body: JSON.stringify({
        model: 'bytedance-seed/seed-1.6-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageBase64.startsWith('data:') 
                    ? imageBase64 
                    : `data:image/jpeg;base64,${imageBase64}` // Fallback to jpeg if format not specified
                }
              }
            ]
          }
        ],
        max_tokens: 500,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || response.statusText
      
      if (response.status === 429) {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Please try again in a moment.' },
          { status: 429 }
        )
      }
      
      // Log detailed error server-side only (don't expose API details)
      console.error('OpenRouter API error:', response.status, errorMessage)
      
      // Return generic error message to client
      return NextResponse.json(
        { error: 'Failed to process receipt. Please try again.' },
        { status: 500 }
      )
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      return NextResponse.json(
        { error: 'No response from AI model' },
        { status: 500 }
      )
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = content.trim()
    if (jsonStr.includes('```json')) {
      jsonStr = jsonStr.split('```json')[1].split('```')[0].trim()
    } else if (jsonStr.includes('```')) {
      jsonStr = jsonStr.split('```')[1].split('```')[0].trim()
    }

    let parsedData
    try {
      parsedData = JSON.parse(jsonStr)
    } catch (parseError) {
      // Log parse error without exposing potentially sensitive AI response content
      console.error('Failed to parse AI response:', parseError instanceof Error ? parseError.message : 'Parse error')
      return NextResponse.json(
        { error: 'Failed to parse receipt data. Please try again.' },
        { status: 500 }
      )
    }

    // Validate and sanitize extracted data using Zod schema
    // First, ensure category and payment_source exist in the user's data
    const validCategoryId = categories.find(c => c.id === parsedData.category)?.id || categories[0]?.id
    const validPaymentSourceId = paymentSources.find(s => s.id === parsedData.payment_source)?.id || paymentSources[0]?.id

    if (!validCategoryId || !validPaymentSourceId) {
      return NextResponse.json(
        { error: 'Please set up at least one category and payment source before scanning receipts.' },
        { status: 400 }
      )
    }

    // Prepare data for validation
    const dataToValidate = {
      amount: typeof parsedData.amount === 'number' ? parsedData.amount : 0,
      category: validCategoryId,
      payment_source: validPaymentSourceId,
      date: parsedData.date || new Date().toISOString().split('T')[0],
      notes: parsedData.notes || null,
    }

    // Validate using Zod schema
    const validationResult = receiptExtractionSchema.safeParse(dataToValidate)

    if (!validationResult.success) {
      console.error('Receipt extraction validation failed:', validationResult.error.errors)
      return NextResponse.json(
        { 
          error: 'Invalid receipt data extracted. Please try again.',
          details: validationResult.error.errors.map(e => e.message).join(', ')
        },
        { status: 400 }
      )
    }

    const extractedData = validationResult.data

    return NextResponse.json({ success: true, data: extractedData })
  } catch (error: any) {
    // Log error without exposing sensitive user or transaction data
    console.error('Receipt processing error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to process receipt. Please try again.' },
      { status: 500 }
    )
  }
}
