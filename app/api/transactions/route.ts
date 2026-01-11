import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { transactionSchema, transactionUpdateSchema } from '@/lib/validation'

/**
 * POST /api/transactions
 * Create a new transaction with server-side validation
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user using cookie-based auth (required for RLS policies)
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set(name: string, value: string, options: any) {
            cookieStore.set({ name, value, ...options })
          },
          remove(name: string, options: any) {
            cookieStore.set({ name, value: '', ...options })
          },
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    // Parse and validate request body
    const body = await request.json()

    // Validate transaction data using Zod schema
    const validationResult = transactionSchema.safeParse({
      ...body,
      user_id: user.id, // Set user_id from authenticated user
    })

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid transaction data',
          details: validationResult.error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      )
    }

    const validatedData = validationResult.data

    // Verify that category and payment_source belong to the user
    const [categoryCheck, paymentSourceCheck] = await Promise.all([
      supabase
        .from('categories')
        .select('id')
        .eq('id', validatedData.category)
        .single(),
      supabase
        .from('payment_sources')
        .select('id')
        .eq('id', validatedData.payment_source)
        .single(),
    ])

    if (categoryCheck.error || !categoryCheck.data) {
      return NextResponse.json(
        { error: 'Invalid category selected' },
        { status: 400 }
      )
    }

    if (paymentSourceCheck.error || !paymentSourceCheck.data) {
      return NextResponse.json(
        { error: 'Invalid payment source selected' },
        { status: 400 }
      )
    }

    // Create transaction
    const { data: transaction, error: insertError } = await supabase
      .from('transactions')
      .insert([{
        amount: validatedData.amount,
        type: validatedData.type,
        date: validatedData.date,
        category: validatedData.category,
        payment_source: validatedData.payment_source,
        notes: validatedData.notes,
        image_url: validatedData.image_url,
        user_id: user.id,
      }])
      .select()
      .single()

    if (insertError) {
      // Log detailed error server-side only
      console.error('Database error creating transaction:', insertError.message)
      return NextResponse.json(
        { error: 'Failed to create transaction. Please try again.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, data: transaction }, { status: 201 })
  } catch (error: any) {
    // Log detailed error server-side only
    console.error('Transaction creation error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to create transaction. Please try again.' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/transactions
 * Update an existing transaction with server-side validation
 */
export async function PUT(request: NextRequest) {
  try {
    // Authenticate user using cookie-based auth (required for RLS policies)
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set(name: string, value: string, options: any) {
            cookieStore.set({ name, value, ...options })
          },
          remove(name: string, options: any) {
            cookieStore.set({ name, value: '', ...options })
          },
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    // Parse and validate request body
    const body = await request.json()
    const { id, ...transactionData } = body

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Transaction ID is required for updates' },
        { status: 400 }
      )
    }

    // Verify transaction exists and belongs to user
    const { data: existingTransaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, user_id')
      .eq('id', id)
      .single()

    if (fetchError || !existingTransaction) {
      return NextResponse.json(
        { error: 'Transaction not found' },
        { status: 404 }
      )
    }

    if (existingTransaction.user_id !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized. You can only update your own transactions.' },
        { status: 403 }
      )
    }

    // Validate transaction data using Zod schema
    const validationResult = transactionSchema.safeParse({
      ...transactionData,
      user_id: user.id,
    })

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid transaction data',
          details: validationResult.error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      )
    }

    const validatedData = validationResult.data

    // Verify that category and payment_source belong to the user
    const [categoryCheck, paymentSourceCheck] = await Promise.all([
      supabase
        .from('categories')
        .select('id')
        .eq('id', validatedData.category)
        .single(),
      supabase
        .from('payment_sources')
        .select('id')
        .eq('id', validatedData.payment_source)
        .single(),
    ])

    if (categoryCheck.error || !categoryCheck.data) {
      return NextResponse.json(
        { error: 'Invalid category selected' },
        { status: 400 }
      )
    }

    if (paymentSourceCheck.error || !paymentSourceCheck.data) {
      return NextResponse.json(
        { error: 'Invalid payment source selected' },
        { status: 400 }
      )
    }

    // Update transaction
    const { data: transaction, error: updateError } = await supabase
      .from('transactions')
      .update({
        amount: validatedData.amount,
        type: validatedData.type,
        date: validatedData.date,
        category: validatedData.category,
        payment_source: validatedData.payment_source,
        notes: validatedData.notes,
        image_url: validatedData.image_url,
      })
      .eq('id', id)
      .eq('user_id', user.id) // Additional security check
      .select()
      .single()

    if (updateError) {
      // Log detailed error server-side only
      console.error('Database error updating transaction:', updateError.message)
      return NextResponse.json(
        { error: 'Failed to update transaction. Please try again.' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, data: transaction })
  } catch (error: any) {
    // Log detailed error server-side only
    console.error('Transaction update error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to update transaction. Please try again.' },
      { status: 500 }
    )
  }
}
