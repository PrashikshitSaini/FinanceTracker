'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { supabase } from '@/lib/supabase'
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

  // Helper function to parse date string safely (handles YYYY-MM-DD format)
  const parseDate = (dateString: string): Date => {
    // If date is in YYYY-MM-DD format, parse it as local date to avoid timezone issues
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-').map(Number)
      return new Date(year, month - 1, day)
    }
    return new Date(dateString)
  }

  // Helper function to get week number and year from date (ISO week)
  const getWeekKey = (dateString: string): string => {
    const date = parseDate(dateString)
    // Get ISO week number
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const dayNum = d.getDay() || 7
    d.setDate(d.getDate() + 4 - dayNum)
    const yearStart = new Date(d.getFullYear(), 0, 1)
    const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
    const year = d.getFullYear()
    return `${year}-W${week.toString().padStart(2, '0')}`
  }

  // Helper function to get month key from date
  const getMonthKey = (dateString: string): string => {
    const date = parseDate(dateString)
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December']
    return `${year}-${month} (${monthNames[date.getMonth()]})`
  }

  // Helper function to get year key from date
  const getYearKey = (dateString: string): string => {
    return parseDate(dateString).getFullYear().toString()
  }

  // Organize transactions by time periods
  const organizeTransactionsByTime = () => {
    const byWeek: Record<string, Transaction[]> = {}
    const byMonth: Record<string, Transaction[]> = {}
    const byYear: Record<string, Transaction[]> = {}

    transactions.forEach(transaction => {
      // Group by week
      const weekKey = getWeekKey(transaction.date)
      if (!byWeek[weekKey]) byWeek[weekKey] = []
      byWeek[weekKey].push(transaction)

      // Group by month
      const monthKey = getMonthKey(transaction.date)
      if (!byMonth[monthKey]) byMonth[monthKey] = []
      byMonth[monthKey].push(transaction)

      // Group by year
      const yearKey = getYearKey(transaction.date)
      if (!byYear[yearKey]) byYear[yearKey] = []
      byYear[yearKey].push(transaction)
    })

    return { byWeek, byMonth, byYear }
  }

  const handleSend = async () => {
    if (!input.trim() || loading) return

    // Check if user is authenticated before making API call
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) {
      const errorMessage: Message = {
        role: 'assistant',
        content: 'Please log in to use the AI assistant.'
      }
      setMessages(prev => [...prev, errorMessage])
      return
    }

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
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
      const totalExpenses = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
      const netAmount = totalIncome - totalExpenses

      const categoryBreakdown = transactions
        .filter(t => t.type === 'expense')
        .reduce((acc, t) => {
          const categoryName = categoryMap[t.category] || t.category
          acc[categoryName] = (acc[categoryName] || 0) + (Number(t.amount) || 0)
          return acc
        }, {} as Record<string, number>)

      const recentTransactions = transactions.slice(0, 10).map(t => ({
        date: t.date,
        type: t.type,
        category: categoryMap[t.category] || t.category,
        amount: t.amount,
        notes: t.notes
      }))

      // Organize transactions by time periods
      const { byWeek, byMonth, byYear } = organizeTransactionsByTime()

      // Debug logging in development
      if (process.env.NODE_ENV === 'development') {
        console.log('Transaction organization:', {
          totalTransactions: transactions.length,
          weeks: Object.keys(byWeek).length,
          months: Object.keys(byMonth).length,
          years: Object.keys(byYear).length,
          sampleWeek: Object.entries(byWeek)[0],
          sampleMonth: Object.entries(byMonth)[0],
        })
      }

      // Format transactions by week
      const weeklyData = Object.entries(byWeek)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 12) // Last 12 weeks
        .map(([week, txs]) => {
          const weekIncome = txs.filter(t => t.type === 'income').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          const weekExpenses = txs.filter(t => t.type === 'expense').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          return `Week ${week}: Income ${formatCurrency(weekIncome, currency)}, Expenses ${formatCurrency(weekExpenses, currency)}, Net ${formatCurrency(weekIncome - weekExpenses, currency)} (${txs.length} transactions)`
        })
        .join('\n')

      // Format transactions by month
      const monthlyData = Object.entries(byMonth)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 12) // Last 12 months
        .map(([month, txs]) => {
          const monthIncome = txs.filter(t => t.type === 'income').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          const monthExpenses = txs.filter(t => t.type === 'expense').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          return `${month}: Income ${formatCurrency(monthIncome, currency)}, Expenses ${formatCurrency(monthExpenses, currency)}, Net ${formatCurrency(monthIncome - monthExpenses, currency)} (${txs.length} transactions)`
        })
        .join('\n')

      // Format transactions by year
      const yearlyData = Object.entries(byYear)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([year, txs]) => {
          const yearIncome = txs.filter(t => t.type === 'income').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          const yearExpenses = txs.filter(t => t.type === 'expense').reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
          return `Year ${year}: Income ${formatCurrency(yearIncome, currency)}, Expenses ${formatCurrency(yearExpenses, currency)}, Net ${formatCurrency(yearIncome - yearExpenses, currency)} (${txs.length} transactions)`
        })
        .join('\n')

      // Format detailed transactions by time period (for AI to reference specific transactions)
      const detailedWeeklyTransactions = Object.entries(byWeek)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 4) // Last 4 weeks with details
        .map(([week, txs]) => {
          // Sort transactions by date (newest first) within the week
          const sortedTxs = [...txs].sort((a, b) => b.date.localeCompare(a.date))
          const txsList = sortedTxs.slice(0, 10).map(t => 
            `  - ${t.date}: ${formatCurrency(t.amount, currency)} (${t.type}) - ${categoryMap[t.category] || t.category}${t.notes ? ` - ${t.notes}` : ''}`
          ).join('\n')
          return `Week ${week}:\n${txsList}${txs.length > 10 ? `\n  ... and ${txs.length - 10} more transactions` : ''}`
        })
        .join('\n\n')

      const detailedMonthlyTransactions = Object.entries(byMonth)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 3) // Last 3 months with details
        .map(([month, txs]) => {
          // Sort transactions by date (newest first) within the month
          const sortedTxs = [...txs].sort((a, b) => b.date.localeCompare(a.date))
          const txsList = sortedTxs.slice(0, 15).map(t => 
            `  - ${t.date}: ${formatCurrency(t.amount, currency)} (${t.type}) - ${categoryMap[t.category] || t.category}${t.notes ? ` - ${t.notes}` : ''}`
          ).join('\n')
          return `${month}:\n${txsList}${txs.length > 15 ? `\n  ... and ${txs.length - 15} more transactions` : ''}`
        })
        .join('\n\n')

      const systemPrompt = `You're a friendly finance buddy chatting with a friend. Keep responses super short (20-30 words max) unless they ask for details. Be casual, warm, and human - like texting a friend. Use markdown for formatting (bold, lists, etc.) when helpful.

User's overall finances:
- Total Income: ${formatCurrency(totalIncome, currency)}
- Total Expenses: ${formatCurrency(totalExpenses, currency)}
- Net: ${formatCurrency(netAmount, currency)}

Top spending categories:
${Object.entries(categoryBreakdown).slice(0, 5).map(([cat, amt]) => `- ${cat}: ${formatCurrency(amt, currency)}`).join('\n')}

Recent transactions (last 5):
${recentTransactions.slice(0, 5).map(t => `- ${t.date}: ${formatCurrency(t.amount, currency)} on ${t.category}`).join('\n')}

Transactions by WEEK (last 12 weeks):
${weeklyData || 'No weekly data available'}

Transactions by MONTH (last 12 months):
${monthlyData || 'No monthly data available'}

Transactions by YEAR:
${yearlyData || 'No yearly data available'}

Detailed weekly transactions (last 4 weeks):
${detailedWeeklyTransactions || 'No weekly transaction details available'}

Detailed monthly transactions (last 3 months):
${detailedMonthlyTransactions || 'No monthly transaction details available'}

You have access to all transaction data organized by week, month, and year. When the user asks about specific time periods (e.g., "How much did I spend last month?", "What were my expenses in week 45?", "Show me transactions from 2024"), use the organized data above to provide accurate answers. You can reference specific transactions, dates, amounts, and categories from the detailed sections.

Remember: Keep it short, friendly, and helpful. Only go longer if they specifically ask for more details.`

      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: input }
      ]

      // Get session to pass access token for authentication
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        throw new Error('Please log in to use the AI assistant.')
      }

      // Call server-side API route to keep API key secure
      const response = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        credentials: 'include', // Include cookies as backup
        body: JSON.stringify({ messages: apiMessages }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Failed to get AI response')
      }

      if (!result.success || !result.content) {
        throw new Error('Invalid response from AI service')
      }
      
      const assistantMessage: Message = { role: 'assistant', content: result.content }
      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      // Log error without exposing sensitive information
      if (process.env.NODE_ENV === 'development') {
        console.error('Error calling AI:', error instanceof Error ? error.message : 'Unknown error')
      }
      let errorContent = 'Sorry, I encountered an error.'
      
      if (error instanceof Error) {
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          errorContent = 'Please log in to use the AI assistant.'
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

