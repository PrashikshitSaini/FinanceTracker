import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

// Two-tier model selection — the client picks per-request via `model_tier`:
//   • "flash" (default) — DeepSeek V4 Flash. ~4× cheaper, fast, no reasoning.
//                          Right choice for everyday casual chat in the bubble.
//   • "pro"             — DeepSeek V4 Pro with reasoning enabled. Slower but
//                          deeper — surfaced via a brain-icon toggle in the UI.
//
// Both are env-overridable for per-deployment rollbacks. The legacy
// OPENROUTER_CHAT_MODEL env var is honored as the Pro fallback so users who
// set it before the tiering existed don't have to re-configure.
const CHAT_MODEL_FLASH = process.env.OPENROUTER_CHAT_MODEL_FLASH || 'deepseek/deepseek-v4-flash'
const CHAT_MODEL_PRO =
  process.env.OPENROUTER_CHAT_MODEL_PRO ||
  process.env.OPENROUTER_CHAT_MODEL ||
  'deepseek/deepseek-v4-pro'

// Safety bound for the tool-execution loop. If the model keeps requesting
// tool calls beyond this, we bail rather than rack up unbounded API spend.
// Five rounds is plenty for any realistic conversation turn.
const MAX_TOOL_ROUNDS = 5

// Per-message and total-payload caps. The system prompt + a year of
// transactions can be sizable, so 20 KB per message and ~1 MB total are
// generous but bounded; the rate limit (10 chats/minute/user) backs this up.
const MAX_MESSAGES = 50
const MAX_CONTENT_LENGTH = 20000
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

// ─── Tool definitions ───────────────────────────────────────────────────────
// All tools operate on `savings_plans` for the authenticated user. The model
// can use the user's plan NAME (case-insensitive) or UUID as the identifier —
// we resolve to a UUID server-side before mutating, so a stale conversation
// can't accidentally hit the wrong row.

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_savings_plan',
      description:
        'Create a new savings goal for the user. Use when they explicitly want to start saving for something specific (a trip, an item, an emergency fund). Do not invent generic goals.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Goal name (e.g., "Hawaii Trip", "Emergency Fund"). Max 100 chars.',
          },
          target_amount: {
            type: 'number',
            description: 'Target amount in the user\'s currency. Must be positive.',
          },
          target_date: {
            type: 'string',
            description: 'Optional target date in YYYY-MM-DD format.',
          },
          notes: {
            type: 'string',
            description: 'Optional notes about the goal.',
          },
          initial_saved_amount: {
            type: 'number',
            description: 'Optional starting saved amount. Defaults to 0.',
          },
        },
        required: ['name', 'target_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contribute_to_savings_plan',
      description:
        'Add money to an existing savings goal. Use when user says things like "add $50 to Hawaii", "saved 100 toward emergency fund".',
      parameters: {
        type: 'object',
        properties: {
          plan_identifier: {
            type: 'string',
            description: 'The plan\'s name (case-insensitive match) or UUID.',
          },
          amount: {
            type: 'number',
            description: 'Positive amount to add to saved_amount.',
          },
        },
        required: ['plan_identifier', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_savings_plan',
      description:
        'Modify an existing savings goal — its name, target amount, target date, or notes. Only use when the user explicitly asks to change something.',
      parameters: {
        type: 'object',
        properties: {
          plan_identifier: {
            type: 'string',
            description: 'The plan\'s name (case-insensitive match) or UUID.',
          },
          name: { type: 'string' },
          target_amount: { type: 'number' },
          target_date: {
            type: 'string',
            description: 'YYYY-MM-DD, or empty string to clear the target date.',
          },
          notes: { type: 'string' },
        },
        required: ['plan_identifier'],
      },
    },
  },
] as const

// UUID v4 — used to detect when the model passes a UUID directly vs a name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ─── Tool execution ─────────────────────────────────────────────────────────
// Each tool returns a short text string that the model will see as the tool
// result. We keep results brief and human-readable so they cost few tokens
// and the model can summarize naturally.

type SupabaseClient = ReturnType<typeof createServerClient>

interface ToolResult {
  ok: boolean
  /** Human-readable result the model sees. Always present. */
  message: string
  /** Optional structured data the CLIENT can use (e.g., to refresh state). */
  data?: unknown
}

/**
 * Resolve a plan identifier (name or UUID) to a row. Returns null if not
 * found. RLS ensures only the caller's own plans are visible.
 */
async function findSavingsPlan(
  supabase: SupabaseClient,
  identifier: string,
): Promise<{ id: string; name: string; saved_amount: number; target_amount: number } | null> {
  if (UUID_RE.test(identifier)) {
    const { data } = await supabase
      .from('savings_plans')
      .select('id, name, saved_amount, target_amount')
      .eq('id', identifier)
      .maybeSingle()
    return data ?? null
  }
  // Name lookup, case-insensitive. ilike with no wildcards = exact match.
  const { data } = await supabase
    .from('savings_plans')
    .select('id, name, saved_amount, target_amount')
    .ilike('name', identifier)
    .limit(1)
    .maybeSingle()
  return data ?? null
}

async function executeToolCall(
  supabase: SupabaseClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (name === 'create_savings_plan') {
      const planName = typeof args.name === 'string' ? args.name.trim().slice(0, 100) : ''
      const targetAmount = typeof args.target_amount === 'number' ? args.target_amount : NaN
      const targetDate =
        typeof args.target_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.target_date)
          ? args.target_date
          : null
      const notes =
        typeof args.notes === 'string' && args.notes.trim().length > 0
          ? args.notes.trim().slice(0, 1000)
          : null
      const initialSaved =
        typeof args.initial_saved_amount === 'number' && args.initial_saved_amount >= 0
          ? Math.min(args.initial_saved_amount, 1_000_000_000)
          : 0

      if (!planName) return { ok: false, message: 'Refused: goal name is required.' }
      if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > 1_000_000_000) {
        return { ok: false, message: 'Refused: target amount must be a positive number up to 1B.' }
      }
      if (initialSaved > targetAmount) {
        return { ok: false, message: 'Refused: initial saved amount can\'t exceed target.' }
      }

      const { data, error } = await supabase
        .from('savings_plans')
        .insert([{
          user_id: userId,
          name: planName,
          target_amount: targetAmount,
          saved_amount: initialSaved,
          target_date: targetDate,
          notes,
        }])
        .select()
        .single()
      if (error || !data) {
        return { ok: false, message: 'Failed to create goal.' }
      }
      return {
        ok: true,
        message: `Created goal "${data.name}" with target ${data.target_amount}. Starting at ${data.saved_amount}.`,
        data: { kind: 'savings_plan_created', plan: data },
      }
    }

    if (name === 'contribute_to_savings_plan') {
      const identifier = typeof args.plan_identifier === 'string' ? args.plan_identifier.trim() : ''
      const amount = typeof args.amount === 'number' ? args.amount : NaN
      if (!identifier) return { ok: false, message: 'Refused: plan_identifier required.' }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        return { ok: false, message: 'Refused: amount must be positive and ≤ 1B.' }
      }
      const plan = await findSavingsPlan(supabase, identifier)
      if (!plan) return { ok: false, message: `No goal found matching "${identifier}".` }

      const newSaved = Math.min(Number(plan.saved_amount) + amount, 1_000_000_000)
      const { data, error } = await supabase
        .from('savings_plans')
        .update({ saved_amount: newSaved })
        .eq('id', plan.id)
        .select()
        .single()
      if (error || !data) return { ok: false, message: 'Failed to record contribution.' }

      const remaining = Math.max(Number(data.target_amount) - Number(data.saved_amount), 0)
      return {
        ok: true,
        message:
          `Added ${amount} to "${data.name}". Now at ${data.saved_amount} of ${data.target_amount}` +
          (remaining > 0 ? ` (${remaining} to go).` : ' — goal reached!'),
        data: { kind: 'savings_plan_contribution', plan: data },
      }
    }

    if (name === 'update_savings_plan') {
      const identifier = typeof args.plan_identifier === 'string' ? args.plan_identifier.trim() : ''
      if (!identifier) return { ok: false, message: 'Refused: plan_identifier required.' }
      const plan = await findSavingsPlan(supabase, identifier)
      if (!plan) return { ok: false, message: `No goal found matching "${identifier}".` }

      const update: Record<string, unknown> = {}
      if (typeof args.name === 'string' && args.name.trim().length > 0) {
        update.name = args.name.trim().slice(0, 100)
      }
      if (typeof args.target_amount === 'number' && args.target_amount > 0 && args.target_amount <= 1_000_000_000) {
        update.target_amount = args.target_amount
      }
      if (typeof args.target_date === 'string') {
        if (args.target_date === '') {
          update.target_date = null
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(args.target_date)) {
          update.target_date = args.target_date
        }
      }
      if (typeof args.notes === 'string') {
        update.notes = args.notes.trim().slice(0, 1000) || null
      }

      if (Object.keys(update).length === 0) {
        return { ok: false, message: 'Nothing to update — no valid fields provided.' }
      }
      const { data, error } = await supabase
        .from('savings_plans')
        .update(update)
        .eq('id', plan.id)
        .select()
        .single()
      if (error || !data) return { ok: false, message: 'Failed to update goal.' }
      return {
        ok: true,
        message: `Updated "${data.name}".`,
        data: { kind: 'savings_plan_updated', plan: data },
      }
    }

    return { ok: false, message: `Unknown tool: ${name}` }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Tool execution error:', err instanceof Error ? err.message : 'Unknown error')
    }
    return { ok: false, message: 'Tool execution threw an error.' }
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * POST /api/ai-chat
 *
 * Chat endpoint with savings-plan tool calling. The client sends:
 *   - messages: prior chat history (user/assistant turns)
 *   - system_context: optional string with the user's current finances
 *     (built client-side from data the client already has loaded)
 *
 * The server appends its own system prompt + the client context, sends to
 * OpenRouter with tools enabled, and runs a bounded execution loop: while
 * the model returns tool_calls, execute them and feed the results back.
 * Returns final assistant text once the model stops requesting tools.
 *
 * Auth: Bearer token or session cookie. Tools execute under the user's auth
 * context via the cookie-bound Supabase client → RLS applies on every op.
 */
export async function POST(request: NextRequest) {
  try {
    // ─── Auth (Bearer or cookie) ──────────────────────────────────────────
    const authHeader = request.headers.get('Authorization')
    let user: { id: string } | null = null

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
        if (verifyResponse.ok) user = await verifyResponse.json()
      } catch (err) {
        console.error('Token verification error:', err instanceof Error ? err.message : 'Unknown error')
      }
    }

    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set(name: string, value: string, options: any) { cookieStore.set({ name, value, ...options }) },
          remove(name: string, options: any) { cookieStore.set({ name, value: '', ...options }) },
        },
      }
    )

    if (!user) {
      const { data: { user: cookieUser } } = await supabase.auth.getUser()
      if (cookieUser) user = cookieUser
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in to use the AI assistant.' },
        { status: 401 }
      )
    }

    // ─── Rate limit ───────────────────────────────────────────────────────
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.AI_CHAT)
    if (!rateLimitResult.success) {
      const resetIn = rateLimitResult.resetTime
        ? Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        : 60
      return NextResponse.json(
        { error: `Rate limit exceeded. Please wait ${resetIn} seconds before trying again.` },
        { status: 429 }
      )
    }

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      console.error('OpenRouter API key is not configured')
      return NextResponse.json(
        { error: 'AI service is not configured. Please contact support.' },
        { status: 500 }
      )
    }

    // ─── Body + validation ────────────────────────────────────────────────
    const body = await request.json()
    const incomingMessages: unknown = body?.messages
    const systemContext: unknown = body?.system_context
    // Tier picker — anything other than literal "pro" treats as Flash. We
    // never trust client input to silently bump us to the more expensive
    // tier, but defaulting *down* (to Flash) is fine — that's the cheaper,
    // faster path.
    const useProTier = body?.model_tier === 'pro'
    const modelToUse = useProTier ? CHAT_MODEL_PRO : CHAT_MODEL_FLASH

    if (!Array.isArray(incomingMessages)) {
      return NextResponse.json({ error: 'messages array required.' }, { status: 400 })
    }
    if (incomingMessages.length > MAX_MESSAGES) {
      return NextResponse.json({ error: 'Too many messages in conversation history.' }, { status: 400 })
    }

    for (let i = 0; i < incomingMessages.length; i++) {
      const msg = incomingMessages[i] as { role?: unknown; content?: unknown }
      if (typeof msg !== 'object' || msg === null) {
        return NextResponse.json({ error: 'Invalid message format.' }, { status: 400 })
      }
      if (!ALLOWED_ROLES.has(msg.role as string)) {
        return NextResponse.json({ error: 'Invalid message role.' }, { status: 400 })
      }
      if (typeof msg.content !== 'string') {
        return NextResponse.json({ error: 'Invalid message content.' }, { status: 400 })
      }
      if (msg.content.length > MAX_CONTENT_LENGTH) {
        return NextResponse.json(
          {
            error: `Message content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
            details: `Message ${i} (role: ${msg.role}) was ${msg.content.length} characters.`,
          },
          { status: 400 }
        )
      }
    }

    // ─── Build the message stack we'll send to OpenRouter ─────────────────
    // System prompt + optional client-provided context + chat history.
    const contextBlock =
      typeof systemContext === 'string' && systemContext.length > 0 && systemContext.length <= MAX_CONTENT_LENGTH
        ? `\n\n${systemContext}`
        : ''

    const systemPrompt = `You are Finn, the user's friendly personal-finance buddy living inside their Finance Tracker app. You see their transactions, savings goals, and current finances. Keep replies SHORT (1-3 sentences) unless they ask for detail. Be warm and casual — like texting a friend.

You have tools to take actions on the user's behalf:
  • create_savings_plan — when they want a new goal
  • contribute_to_savings_plan — when they say "add X to Y" or "I just saved Z toward Y"
  • update_savings_plan — when they want to change a goal's name/target/date/notes

When a user asks for an action, USE THE TOOL. Don't just describe what they should do. After a tool succeeds, briefly confirm what you did.${contextBlock}`

    const messagesForApi: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      ...incomingMessages.map((m: any) => ({ role: m.role, content: m.content })),
    ]

    // ─── Tool execution loop ──────────────────────────────────────────────
    // Run up to MAX_TOOL_ROUNDS turns. Each turn: call OpenRouter; if the
    // assistant message has tool_calls, execute each, append results, loop.
    // Otherwise return the assistant content as the final answer.

    let lastAssistantContent: string | null = null
    const appliedToolResults: unknown[] = []

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          'X-Title': 'Finance Tracker',
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: messagesForApi,
          tools: TOOLS,
          tool_choice: 'auto',
          // Pro tier enables reasoning (chain-of-thought) — that's the
          // whole point of the brain toggle. Flash skips it for speed/cost.
          // max_tokens scales accordingly: reasoning eats budget before the
          // visible answer, so Pro needs more headroom.
          reasoning: { enabled: useProTier },
          max_tokens: useProTier ? 2000 : 800,
        }),
      })

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after')
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000
        return NextResponse.json(
          { error: `Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds before trying again.` },
          { status: 429 }
        )
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('OpenRouter API error:', response.status, errorData?.error?.message)
        if (response.status === 401 || response.status === 403) {
          return NextResponse.json(
            { error: 'AI service authentication failed. Please try again later.' },
            { status: 500 }
          )
        }
        return NextResponse.json(
          { error: 'AI service error. Please try again later.' },
          { status: 500 }
        )
      }

      const data = await response.json()
      const message = data.choices?.[0]?.message
      if (!message) {
        console.error('AI chat: missing message in response')
        return NextResponse.json({ error: 'No response from AI model.' }, { status: 500 })
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

      if (toolCalls.length === 0) {
        // Terminal — model returned a final text answer.
        lastAssistantContent = typeof message.content === 'string' ? message.content : ''
        break
      }

      // Append the assistant's tool_calls turn to history, then execute each
      // call and append a 'tool' message for each result.
      messagesForApi.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: toolCalls,
      })

      for (const call of toolCalls) {
        const fnName = call?.function?.name
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          // Malformed args from the model — return an error result so the
          // model can recover or apologize, but don't crash the loop.
          parsedArgs = {}
        }
        const result = await executeToolCall(supabase, user.id, fnName, parsedArgs)
        if (result.data !== undefined) appliedToolResults.push(result.data)
        messagesForApi.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.message,
        })
      }
      // Loop continues; next iteration calls the model again with the new history.
    }

    if (lastAssistantContent === null) {
      // Loop bailed without terminal text — shouldn't happen unless we hit
      // MAX_TOOL_ROUNDS. Return whatever we have so the UI doesn't hang.
      lastAssistantContent =
        'I tried to take a few steps but couldn\'t wrap it up cleanly. Want to try again?'
    }

    return NextResponse.json({
      success: true,
      content: lastAssistantContent,
      // Lets the client know which side effects happened so it can refresh
      // the relevant slice of UI (e.g., re-fetch savings_plans).
      tool_results: appliedToolResults,
    })
  } catch (error) {
    console.error('AI chat API error:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Failed to process AI chat request. Please try again.' },
      { status: 500 }
    )
  }
}
