'use client'

import { useCurrency } from '@/contexts/CurrencyContext'
import { CURRENCIES } from '@/lib/currency'
import { Select } from '@/components/ui/select'
import { Globe } from 'lucide-react'

export default function CurrencySelector() {
  const { currency, setCurrency } = useCurrency()

  return (
    <div className="flex items-center gap-2">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <Select
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
        className="w-[120px]"
      >
        {CURRENCIES.map((curr) => (
          <option key={curr.code} value={curr.code}>
            {curr.symbol} {curr.code}
          </option>
        ))}
      </Select>
    </div>
  )
}
