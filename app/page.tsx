'use client'

import { useState, useEffect } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import Dashboard from '@/components/Dashboard'
import TransactionForm from '@/components/TransactionForm'
import CalendarView from '@/components/CalendarView'
import AIChat from '@/components/AIChat'
import Auth from '@/components/Auth'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Wallet, Calendar, BarChart3, Bot, LogOut, User } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { User as SupabaseUser } from '@supabase/supabase-js'
import CurrencySelector from '@/components/CurrencySelector'

export default function Home() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [showTransactionForm, setShowTransactionForm] = useState(false)
  const [user, setUser] = useState<SupabaseUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check if this is a logout redirect
    const urlParams = new URLSearchParams(window.location.search)
    if (urlParams.get('logout') === 'true') {
      // Clear the URL parameter
      window.history.replaceState({}, '', window.location.pathname)
      // Ensure user is null
      setUser(null)
      setLoading(false)
      return
    }

    // Check active session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Only log auth events in development mode, without exposing PII
      if (process.env.NODE_ENV === 'development') {
        console.log('Auth state changed:', event)
      }
      
      // If signed out, ensure we show the login screen
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null)
        setLoading(false)
        return
      }
      
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleSignOut = async () => {
    try {
      // Clear local storage
      localStorage.removeItem('currency')
      
      // Sign out from Supabase
      await supabase.auth.signOut()
      
      // Clear all Supabase-related localStorage items
      const keys = Object.keys(localStorage)
      keys.forEach(key => {
        if (key.includes('supabase') || key.includes('sb-')) {
          localStorage.removeItem(key)
        }
      })
      
      // Clear all cookies related to Supabase/auth
      document.cookie.split(";").forEach((c) => {
        const cookieName = c.split("=")[0].trim()
        if (cookieName.includes('supabase') || cookieName.includes('sb-') || cookieName.includes('auth')) {
          document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`
          document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${window.location.hostname}`
        }
      })
      
      // Clear session storage
      sessionStorage.clear()
      
      // Clear user state
      setUser(null)
      
      // Wait a moment to ensure everything is cleared
      await new Promise(resolve => setTimeout(resolve, 200))
      
      // Force a hard reload with cache bypass
      window.location.href = window.location.origin + '?logout=true'
    } catch (error: any) {
      // Log error without exposing PII - only log error message, not full error object
      if (process.env.NODE_ENV === 'development') {
        console.warn('Sign out exception:', error?.message || 'Unknown error')
      }
      // On any error, still clear everything and redirect
      localStorage.clear()
      sessionStorage.clear()
      setUser(null)
      window.location.href = window.location.origin + '?logout=true'
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <Auth />
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <Wallet className="h-5 w-5 sm:h-6 sm:w-6" />
              <span className="hidden xs:inline">Finance Tracker</span>
              <span className="xs:hidden">Finance</span>
            </h1>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <CurrencySelector />
              <div className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm text-muted-foreground">
                <User className="h-3 w-3 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">{user.email}</span>
              </div>
              <Button onClick={() => setShowTransactionForm(true)} size="sm" className="text-xs sm:text-sm">
                <span className="hidden sm:inline">Add Transaction</span>
                <span className="sm:hidden">Add</span>
              </Button>
              <Button variant="outline" onClick={handleSignOut} size="sm">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-6">
            <TabsTrigger value="dashboard" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </TabsTrigger>
            <TabsTrigger value="calendar" className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span className="hidden sm:inline">Calendar</span>
            </TabsTrigger>
            <TabsTrigger value="transactions" className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              <span className="hidden sm:inline">Transactions</span>
            </TabsTrigger>
            <TabsTrigger value="ai" className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              <span className="hidden sm:inline">AI Assistant</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard">
            <Dashboard />
          </TabsContent>

          <TabsContent value="calendar">
            <CalendarView />
          </TabsContent>

          <TabsContent value="transactions">
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">All Transactions</h2>
              <Dashboard showTableOnly={true} />
            </Card>
          </TabsContent>

          <TabsContent value="ai">
            <AIChat />
          </TabsContent>
        </Tabs>
      </main>

      {showTransactionForm && (
        <TransactionForm
          open={showTransactionForm}
          onOpenChange={setShowTransactionForm}
        />
      )}
    </div>
  )
}

