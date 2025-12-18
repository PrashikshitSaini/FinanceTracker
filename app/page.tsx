'use client'

import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import Dashboard from '@/components/Dashboard'
import TransactionForm from '@/components/TransactionForm'
import CalendarView from '@/components/CalendarView'
import AIChat from '@/components/AIChat'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Wallet, Calendar, BarChart3, Bot } from 'lucide-react'

export default function Home() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [showTransactionForm, setShowTransactionForm] = useState(false)

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="h-6 w-6" />
            Finance Tracker
          </h1>
          <Button onClick={() => setShowTransactionForm(true)}>
            Add Transaction
          </Button>
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

