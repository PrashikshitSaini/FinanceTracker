export async function callOpenRouterAPI(messages: any[]) {
  const apiKey = process.env.NEXT_PUBLIC_OPENROUTER_API_KEY
  
  if (!apiKey) {
    throw new Error('OpenRouter API key is not configured. Please set NEXT_PUBLIC_OPENROUTER_API_KEY in your environment variables.')
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Finance Tracker',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b:free',
      messages: messages,
    }),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    const errorMessage = errorData.error?.message || response.statusText
    throw new Error(`OpenRouter API error (${response.status}): ${errorMessage}`)
  }

  const data = await response.json()
  
  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error('Invalid response format from OpenRouter API')
  }
  
  return data.choices[0].message.content
}

