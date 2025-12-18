'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { DEFAULT_CURRENCY, type Currency } from '@/lib/currency'

interface CurrencyContextType {
  currency: string
  setCurrency: (currency: string) => void
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined)

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<string>(DEFAULT_CURRENCY)

  // Load currency from localStorage on mount
  useEffect(() => {
    const savedCurrency = localStorage.getItem('currency')
    if (savedCurrency) {
      setCurrencyState(savedCurrency)
    }
  }, [])

  // Save currency to localStorage when it changes
  const setCurrency = (newCurrency: string) => {
    setCurrencyState(newCurrency)
    localStorage.setItem('currency', newCurrency)
  }

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (context === undefined) {
    throw new Error('useCurrency must be used within a CurrencyProvider')
  }
  return context
}
