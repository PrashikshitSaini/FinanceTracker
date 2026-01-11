import { z } from 'zod'

/**
 * Sanitize HTML from user input by stripping HTML tags
 * This prevents XSS attacks if notes are ever rendered as HTML
 */
export function sanitizeHtml(input: string | null | undefined): string | null {
  if (!input) return null
  // Strip HTML tags - replace with plain text equivalent
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
}

/**
 * Validate date string format (YYYY-MM-DD) and ensure it's within reasonable range
 */
function validateDate(dateString: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(dateString)) return false
  
  const date = new Date(dateString)
  const minDate = new Date('1900-01-01')
  const maxDate = new Date()
  maxDate.setFullYear(maxDate.getFullYear() + 1) // Allow up to 1 year in the future
  
  return date >= minDate && date <= maxDate && !isNaN(date.getTime())
}

/**
 * Base transaction object schema (before refine/transform)
 * - Amount: Must be positive for expenses, can be positive for income
 * - Date: Must be valid YYYY-MM-DD format within reasonable range
 * - Category and Payment Source: Must be valid UUIDs
 * - Notes: Optional, max 1000 characters, HTML sanitized
 */
const transactionBaseSchema = z.object({
  amount: z.number({
    required_error: 'Amount is required',
    invalid_type_error: 'Amount must be a number',
  })
    .positive('Amount must be greater than 0')
    .max(1000000000, 'Amount exceeds maximum limit (1 billion)')
    .refine((val) => val !== 0, 'Amount cannot be zero'),
  
  type: z.enum(['income', 'expense'], {
    required_error: 'Transaction type is required',
    invalid_type_error: 'Type must be either "income" or "expense"',
  }),
  
  date: z.string({
    required_error: 'Date is required',
  })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine(validateDate, {
      message: 'Date must be between 1900-01-01 and 1 year from today',
    }),
  
  category: z.string({
    required_error: 'Category is required',
  })
    .uuid('Category must be a valid UUID'),
  
  payment_source: z.string({
    required_error: 'Payment source is required',
  })
    .uuid('Payment source must be a valid UUID'),
  
  notes: z.string()
    .max(1000, 'Notes cannot exceed 1000 characters')
    .nullable()
    .optional()
    .transform((val) => sanitizeHtml(val)),
  
  image_url: z.union([
    z.string().url('Image URL must be a valid URL'),
    z.null()
  ]).optional(),
  
  user_id: z.string().uuid('User ID must be a valid UUID').optional(),
})

/**
 * Transaction validation schema (for creating transactions)
 */
export const transactionSchema = transactionBaseSchema

/**
 * Receipt extraction data validation schema
 * Used for validating data extracted from receipt images
 */
export const receiptExtractionSchema = z.object({
  amount: z.number()
    .min(0, 'Amount cannot be negative')
    .max(1000000000, 'Amount exceeds maximum limit')
    .default(0),
  
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .optional(),
  
  category: z.string()
    .uuid('Category must be a valid UUID'),
  
  payment_source: z.string()
    .uuid('Payment source must be a valid UUID'),
  
  notes: z.string()
    .max(1000, 'Notes cannot exceed 1000 characters')
    .nullable()
    .optional()
    .transform((val) => sanitizeHtml(val)),
}).transform((data) => {
  // Ensure date is set if missing
  if (!data.date) {
    data.date = new Date().toISOString().split('T')[0]
  }
  return data
})

/**
 * Transaction update schema (same as create, but with optional ID)
 * Defined separately to avoid extend/merge issues with transformed schemas
 */
export const transactionUpdateSchema = z.object({
  id: z.string().uuid('Transaction ID must be a valid UUID').optional(),
  amount: z.number({
    required_error: 'Amount is required',
    invalid_type_error: 'Amount must be a number',
  })
    .positive('Amount must be greater than 0')
    .max(1000000000, 'Amount exceeds maximum limit (1 billion)')
    .refine((val) => val !== 0, 'Amount cannot be zero'),
  
  type: z.enum(['income', 'expense'], {
    required_error: 'Transaction type is required',
    invalid_type_error: 'Type must be either "income" or "expense"',
  }),
  
  date: z.string({
    required_error: 'Date is required',
  })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .refine(validateDate, {
      message: 'Date must be between 1900-01-01 and 1 year from today',
    }),
  
  category: z.string({
    required_error: 'Category is required',
  })
    .uuid('Category must be a valid UUID'),
  
  payment_source: z.string({
    required_error: 'Payment source is required',
  })
    .uuid('Payment source must be a valid UUID'),
  
  notes: z.string()
    .max(1000, 'Notes cannot exceed 1000 characters')
    .nullable()
    .optional()
    .transform((val) => sanitizeHtml(val)),
  
  image_url: z.union([
    z.string().url('Image URL must be a valid URL'),
    z.null()
  ]).optional(),
  
  user_id: z.string().uuid('User ID must be a valid UUID').optional(),
})

/**
 * Type exports for use in components and API routes
 */
export type TransactionInput = z.infer<typeof transactionSchema>
export type ReceiptExtractionInput = z.infer<typeof receiptExtractionSchema>
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>
