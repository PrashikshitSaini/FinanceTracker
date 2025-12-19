'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/supabase'
import { callOpenRouterAPI } from '@/lib/openrouter'
import { Transaction } from '@/types'
import { Send, Bot, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useCurrency } from '@/contexts/CurrencyContext'
import { formatCurrency } from '@/lib/currency'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function AIChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const lastRequestTimeRef = useRef<number>(0)
  const { currency } = useCurrency()

  useEffect(() => {
    loadCategories()
    loadTransactions()
    
    // Check if API key is configured
    const apiKey = process.env.NEXT_PUBLIC_OPENROUTER_API_KEY
    if (!apiKey) {
      console.warn('NEXT_PUBLIC_OPENROUTER_API_KEY is not set')
    }
    
    // Initialize with welcome message
    setMessages([{
      role: 'assistant',
      content: 'Hey! 👋 I\'m here to help with your finances. Ask me anything!'
    }])
  }, [])

  const loadCategories = async () => {
    const { data } = await supabase.from('categories').select('id, name')
    if (data) {
      const map: Record<string, string> = {}
      data.forEach(cat => {
        map[cat.id] = cat.name
      })
      setCategoryMap(map)
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadTransactions = async () => {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .order('date', { ascending: false })
      .limit(1000)

    if (data) setTransactions(data)
  }

  const handleSend = async () => {
    if (!input.trim() || loading) return

    // Simple rate limiting: prevent requests more than once every 2 seconds
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequestTimeRef.current
    const minDelay = 2000 // 2 seconds minimum between requests

    if (timeSinceLastRequest < minDelay) {
      const waitTime = Math.ceil((minDelay - timeSinceLastRequest) / 1000)
      const errorMessage: Message = {
        role: 'assistant',
        content: `Please wait ${waitTime} more second${waitTime !== 1 ? 's' : ''} before sending another message.`
      }
      setMessages(prev => [...prev, errorMessage])
      return
    }

    lastRequestTimeRef.current = now

    const userMessage: Message = { role: 'user', content: input }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      // Prepare context with transaction summary
      const totalIncome = transactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0)
      const totalExpenses = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0)
      const netAmount = totalIncome - totalExpenses

      const categoryBreakdown = transactions
        .filter(t => t.type === 'expense')
        .reduce((acc, t) => {
          const categoryName = categoryMap[t.category] || t.category
          acc[categoryName] = (acc[categoryName] || 0) + t.amount
          return acc
        }, {} as Record<string, number>)

      const recentTransactions = transactions.slice(0, 10).map(t => ({
        date: t.date,
        type: t.type,
        category: categoryMap[t.category] || t.category,
        amount: t.amount,
        notes: t.notes
      }))

      const systemPrompt = `You're a friendly finance buddy chatting with a friend. Keep responses super short (20-30 words max) unless they ask for details. Be casual, warm, and human - like texting a friend. Use markdown for formatting (bold, lists, etc.) when helpful.

User's finances:
- Income: ${formatCurrency(totalIncome, currency)}
- Expenses: ${formatCurrency(totalExpenses, currency)}
- Net: ${formatCurrency(netAmount, currency)}

Top spending categories:
${Object.entries(categoryBreakdown).slice(0, 5).map(([cat, amt]) => `- ${cat}: ${formatCurrency(amt, currency)}`).join('\n')}

Recent transactions:
${recentTransactions.slice(0, 5).map(t => `- ${t.date}: ${formatCurrency(t.amount, currency)} on ${t.category}`).join('\n')}

Remember: Keep it short, friendly, and helpful. Only go longer if they specifically ask for more details.`

      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: input }
      ]

      const response = await callOpenRouterAPI(apiMessages)
      
      const assistantMessage: Message = { role: 'assistant', content: response }
      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      console.error('Error calling AI:', error)
      let errorContent = 'Sorry, I encountered an error.'
      
      if (error instanceof Error) {
        if (error.message.includes('API key is not configured')) {
          errorContent = 'OpenRouter API key is not configured. Please add NEXT_PUBLIC_OPENROUTER_API_KEY to your environment variables.'
        } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          errorContent = 'Invalid OpenRouter API key. Please check your NEXT_PUBLIC_OPENROUTER_API_KEY environment variable.'
        } else if (error.message.includes('429') || error.message.includes('Rate limit')) {
          // Extract wait time from error message if available
          const waitMatch = error.message.match(/(\d+)\s*seconds?/i)
          const waitTime = waitMatch ? parseInt(waitMatch[1]) : 30
          errorContent = `Rate limit exceeded. Please wait ${waitTime} seconds before trying again.`
        } else {
          errorContent = `Error: ${error.message}`
        }
      }
      
      const errorMessage: Message = {
        role: 'assistant',
        content: errorContent
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const quickQuestions = [
    'What are my spending insights?',
    'Help me set a savings goal',
    'Which category do I spend the most on?',
    'How can I save more money?'
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            AI Finance Assistant
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="h-[500px] overflow-y-auto border rounded-lg p-4 space-y-4 bg-muted/30">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`flex gap-3 ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.role === 'assistant' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary-foreground" />
                    </div>
                  )}
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background border'
                    }`}
                  >
                    {message.role === 'assistant' ? (
                      <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown
                          components={{
                            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                            ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
                            li: ({ children }) => <li className="ml-2">{children}</li>,
                            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                            em: ({ children }) => <em className="italic">{children}</em>,
                            code: ({ children }) => <code className="bg-muted px-1 py-0.5 rounded text-xs">{children}</code>,
                            h1: ({ children }) => <h1 className="text-base font-bold mb-2">{children}</h1>,
                            h2: ({ children }) => <h2 className="text-sm font-bold mb-1">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    )}
                  </div>
                  {message.role === 'user' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex gap-3 justify-start">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                    <Bot className="h-4 w-4 text-primary-foreground" />
                  </div>
                  <div className="bg-background border rounded-lg p-3">
                    <p className="text-sm text-muted-foreground">Thinking...</p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Quick questions:</p>
              <div className="flex flex-wrap gap-2">
                {quickQuestions.map((question, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setInput(question)
                      setTimeout(() => handleSend(), 100)
                    }}
                    disabled={loading}
                  >
                    {question}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask me anything about your finances..."
                disabled={loading}
              />
              <Button onClick={handleSend} disabled={loading || !input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

