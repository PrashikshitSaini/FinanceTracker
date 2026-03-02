'use client'

import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { DEFAULT_CURRENCY, CURRENCIES, type Currency } from '@/lib/currency'

interface CurrencyContextType {
  currency: string
  setCurrency: (currency: string) => void
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined)

const VALID_CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code))

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<string>(DEFAULT_CURRENCY)

  // Load currency from localStorage on mount, validating against the known allowlist
  // to prevent a tampered localStorage value from propagating through the UI.
  useEffect(() => {
    const savedCurrency = localStorage.getItem('currency')
    if (savedCurrency && VALID_CURRENCY_CODES.has(savedCurrency)) {
      setCurrencyState(savedCurrency)
    }
  }, [])

  const setCurrency = (newCurrency: string) => {
    if (!VALID_CURRENCY_CODES.has(newCurrency)) return
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
