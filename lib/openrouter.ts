export async function callOpenRouterAPI(messages: any[], retries = 3): Promise<string> {
  const apiKey = process.env.NEXT_PUBLIC_OPENROUTER_API_KEY
  
  if (!apiKey) {
    throw new Error('OpenRouter API key is not configured. Please set NEXT_PUBLIC_OPENROUTER_API_KEY in your environment variables.')
  }

  for (let attempt = 0; attempt < retries; attempt++) {
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
        throw new Error(`Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds before trying again.`)
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMessage = errorData.error?.message || response.statusText
        
        // Retry on 5xx errors
        if (response.status >= 500 && attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
          continue
        }
        
        throw new Error(`OpenRouter API error (${response.status}): ${errorMessage}`)
      }

      const data = await response.json()
      
      if (!data.choices || !data.choices[0]?.message?.content) {
        throw new Error('Invalid response format from OpenRouter API')
      }
      
      return data.choices[0].message.content
    } catch (error) {
      // If it's the last attempt or not a retryable error, throw
      if (attempt === retries - 1 || !(error instanceof Error && error.message.includes('429'))) {
        throw error
      }
      // Otherwise, wait and retry
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
    }
  }
  
  throw new Error('Failed to get response from OpenRouter API after retries')
}

