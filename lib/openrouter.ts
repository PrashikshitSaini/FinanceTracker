export async function callOpenRouterAPI(messages: any[]) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.NEXT_PUBLIC_OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Finance Tracker',
    },
    body: JSON.stringify({
      model: 'openrouter/gpt-oss-120b',
      messages: messages,
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.statusText}`)
  }

  const data = await response.json()
  return data.choices[0]?.message?.content || ''
}

