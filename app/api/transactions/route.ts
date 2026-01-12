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
    const authHeader = request.headers.get('Authorization')
    let user = null
    let accessToken = null

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '')
      try {
        const verifyResponse = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          }
        )
        
        if (verifyResponse.ok) {
          const userData = await verifyResponse.json()
          user = userData
          accessToken = token
        }
      } catch (err) {
      }
    }

    if (!user) {
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

      const { data: { user: cookieUser }, error: authError } = await supabase.auth.getUser()
      if (!authError && cookieUser) {
        user = cookieUser
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    const body = await request.json()

    const validationResult = transactionSchema.safeParse({
      ...body,
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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (accessToken) {
      const categoryResponse = await fetch(
        `${supabaseUrl}/rest/v1/categories?id=eq.${validatedData.category}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      const paymentSourceResponse = await fetch(
        `${supabaseUrl}/rest/v1/payment_sources?id=eq.${validatedData.payment_source}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!categoryResponse.ok || (await categoryResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (!paymentSourceResponse.ok || (await paymentSourceResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const insertResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            amount: validatedData.amount,
            type: validatedData.type,
            date: validatedData.date,
            category: validatedData.category,
            payment_source: validatedData.payment_source,
            notes: validatedData.notes,
            image_url: validatedData.image_url,
            user_id: user.id,
          }),
        }
      )

      if (!insertResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to create transaction. Please try again.' },
          { status: 500 }
        )
      }

      const transaction = await insertResponse.json()
      return NextResponse.json({ success: true, data: Array.isArray(transaction) ? transaction[0] : transaction }, { status: 201 })
    } else {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        supabaseUrl,
        supabaseKey,
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
        return NextResponse.json(
          { error: 'Failed to create transaction. Please try again.' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, data: transaction }, { status: 201 })
    }
  } catch (error: any) {
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
    const authHeader = request.headers.get('Authorization')
    let user = null
    let accessToken = null

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '')
      try {
        const verifyResponse = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          }
        )
        
        if (verifyResponse.ok) {
          const userData = await verifyResponse.json()
          user = userData
          accessToken = token
        }
      } catch (err) {
      }
    }

    if (!user) {
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

      const { data: { user: cookieUser }, error: authError } = await supabase.auth.getUser()
      if (!authError && cookieUser) {
        user = cookieUser
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { id, ...transactionData } = body

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Transaction ID is required for updates' },
        { status: 400 }
      )
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    if (accessToken) {
      const existingResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions?id=eq.${id}&select=id,user_id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!existingResponse.ok) {
        return NextResponse.json(
          { error: 'Transaction not found' },
          { status: 404 }
        )
      }

      const existing = await existingResponse.json()
      if (!existing || existing.length === 0 || existing[0].user_id !== user.id) {
        return NextResponse.json(
          { error: 'Transaction not found' },
          { status: 404 }
        )
      }

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

      const categoryResponse = await fetch(
        `${supabaseUrl}/rest/v1/categories?id=eq.${validatedData.category}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      const paymentSourceResponse = await fetch(
        `${supabaseUrl}/rest/v1/payment_sources?id=eq.${validatedData.payment_source}&select=id`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!categoryResponse.ok || (await categoryResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid category selected' },
          { status: 400 }
        )
      }

      if (!paymentSourceResponse.ok || (await paymentSourceResponse.json()).length === 0) {
        return NextResponse.json(
          { error: 'Invalid payment source selected' },
          { status: 400 }
        )
      }

      const updateResponse = await fetch(
        `${supabaseUrl}/rest/v1/transactions?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            amount: validatedData.amount,
            type: validatedData.type,
            date: validatedData.date,
            category: validatedData.category,
            payment_source: validatedData.payment_source,
            notes: validatedData.notes,
            image_url: validatedData.image_url,
          }),
        }
      )

      if (!updateResponse.ok) {
        return NextResponse.json(
          { error: 'Failed to update transaction. Please try again.' },
          { status: 500 }
        )
      }

      const transaction = await updateResponse.json()
      return NextResponse.json({ success: true, data: Array.isArray(transaction) ? transaction[0] : transaction })
    } else {
      const cookieStore = await cookies()
      const supabase = createServerClient(
        supabaseUrl,
        supabaseKey,
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
        .eq('user_id', user.id)
        .select()
        .single()

      if (updateError) {
        return NextResponse.json(
          { error: 'Failed to update transaction. Please try again.' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, data: transaction })
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to update transaction. Please try again.' },
      { status: 500 }
    )
  }
}
