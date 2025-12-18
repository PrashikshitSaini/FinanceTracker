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

