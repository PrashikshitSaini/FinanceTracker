'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/supabase'
import { callOpenRouterAPI } from '@/lib/openrouter'
import { Transaction } from '@/types'
import { Send, Bot, User } from 'lucide-react'

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

  useEffect(() => {
    loadCategories()
    loadTransactions()
    // Initialize with welcome message
    setMessages([{
      role: 'assistant',
      content: 'Hello! I\'m your AI finance assistant. I have access to all your transactions and can help you with insights, goal setting, and financial advice. What would you like to know?'
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

      const systemPrompt = `You are a helpful AI finance assistant. You have access to the user's financial data:

Total Income: $${totalIncome.toFixed(2)}
Total Expenses: $${totalExpenses.toFixed(2)}
Net Amount: $${netAmount.toFixed(2)}

Category Breakdown:
${Object.entries(categoryBreakdown).map(([cat, amt]) => `- ${cat}: $${amt.toFixed(2)}`).join('\n')}

Recent Transactions:
${recentTransactions.map(t => `- ${t.date}: ${t.type} of $${t.amount} in ${t.category}${t.notes ? ` (${t.notes})` : ''}`).join('\n')}

You can:
1. Provide insights on spending patterns
2. Help set financial goals
3. Suggest ways to save money
4. Analyze spending by category
5. Answer questions about their finances

Be helpful, concise, and actionable.`

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
      const errorMessage: Message = {
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please make sure your OpenRouter API key is configured correctly.'
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
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
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

