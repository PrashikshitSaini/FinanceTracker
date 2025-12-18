export type Currency = {
  code: string
  symbol: string
  name: string
}

export const CURRENCIES: Currency[] = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
]

export const DEFAULT_CURRENCY = 'USD'

export function formatCurrency(amount: number, currencyCode: string = DEFAULT_CURRENCY): string {
  const currency = CURRENCIES.find(c => c.code === currencyCode) || CURRENCIES[0]
  
  // For currencies like JPY that don't use decimals
  const decimals = ['JPY'].includes(currencyCode) ? 0 : 2
  
  // Format number with appropriate decimals
  const formattedAmount = Math.abs(amount).toFixed(decimals)
  
  // Add thousand separators
  const parts = formattedAmount.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const finalAmount = parts.join('.')
  
  // Return with symbol prefix or suffix based on currency
  if (currency.symbol === currencyCode) {
    return `${finalAmount} ${currency.symbol}`
  }
  return `${currency.symbol}${finalAmount}`
}

export function getCurrencySymbol(currencyCode: string = DEFAULT_CURRENCY): string {
  const currency = CURRENCIES.find(c => c.code === currencyCode) || CURRENCIES[0]
  return currency.symbol
}
