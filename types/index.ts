export interface Transaction {
  id: string
  amount: number
  category: string
  payment_source: string
  notes?: string
  image_url?: string
  date: string
  type: 'income' | 'expense'
  created_at: string
  updated_at: string
}

export interface Category {
  id: string
  name: string
  color: string
  created_at: string
}

export interface PaymentSource {
  id: string
  name: string
  created_at: string
}

export type CalendarView = 'month' | 'day' | 'year'

/**
 * A savings goal — name, target, accumulated amount, optional target date.
 * Decoupled from transactions: contributions update `saved_amount` directly;
 * no separate ledger or auto-created expense rows.
 */
export interface SavingsPlan {
  id: string
  user_id: string
  name: string
  target_amount: number
  saved_amount: number
  target_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

