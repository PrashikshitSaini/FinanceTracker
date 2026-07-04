---
name: project-finn-tool-calling
description: Non-obvious invariants of Finn's (AIBubble → /api/ai-chat) tool-calling flow. Read before changing Finn's tools, the chat route's tool loop, or the AIBubble/Dashboard refresh wiring.
metadata:
  type: project
---

Finn is the floating AI assistant: `components/AIBubble.tsx` (client) ↔ `app/api/ai-chat/route.ts` (server tool loop). Tools are OpenAI-style function definitions in the `TOOLS` array; `executeToolCall(supabase, userId, name, args)` runs each under the **cookie-bound** Supabase client, so RLS enforces ownership. Same model as the savings tools.

Tool set: savings (`create/contribute/update_savings_plan`) + transactions (`log_payment`, `find_transactions`, `update_payment`, `delete_payment`).

**Invariants a future edit must not break:**

1. **Client chat state does NOT persist tool context across turns.** `AIBubble`'s `messages` state stores only `{role: 'user'|'assistant', content}`. The server further strips everything but role+content (`messagesForApi = incomingMessages.map(m => ({role, content}))`). So tool_calls and `tool` result messages exist only *within a single request's* bounded loop (`MAX_TOOL_ROUNDS`) — they vanish between user turns. Any multi-step flow that must survive a turn boundary has to re-derive its state. This is why the confirm-before-destructive flow works by having Finn **re-run `find_transactions` on the confirmation turn** to re-fetch the id, rather than remembering it. Don't assume prior-turn tool output is available.

2. **Destructive-action confirmation is a PROMPT-level guardrail, not a hard server gate.** The system prompt tells Finn to find → state the transaction back → get a yes before `delete_payment`/`update_payment`. The tools themselves will act on any valid id immediately. This was the user's explicit choice (2026-07-04): conversational confirm, matching the app's `confirm()` dialog UX — they did NOT ask for a server-side two-step token. If you ever need a *hard* gate, that's new work, not a regression to fix.

3. **Category / payment_source are resolved by NAME against the user's own visible lists** (`fetchUserOptions` + `resolveOptionId`), never trusted from the model. `transactions.category`/`payment_source` are TEXT UUID-as-string (see project-database-schema). An unmatched name/id is rejected with a "your options: …" message so Finn asks the user — capture-correct, don't guess.

4. **Refund post-processing** (is_refund → force `type=income`, prefix notes `Refund:`) is duplicated in three places by design and must stay consistent: `log_payment`, `update_payment` (both in ai-chat), and `/api/transactions/[id]` PATCH + quick-add.

5. **UI refresh is event-based.** AIBubble dispatches `finn:savings-changed` (when a result `kind` starts with `savings_plan`) and `finn:transactions-changed` (kinds `transaction_logged|updated|deleted`; `transactions_found` is read-only → no event). Listeners: `Savings.tsx` + `TopSavingsCard.tsx` (savings), `Dashboard.tsx` (transactions). Add a listener anywhere else that must reflect Finn's writes live.

6. **Notes cap mismatch:** transactions main model + `log_payment`/`update_payment` use **1000** chars (via `transactionSchema`); the `/api/transactions/[id]` PATCH route uses **200** (`NOTES_MAX_LENGTH`). Not a bug — different entry points — but don't "unify" one to the other without checking the column and both callers.

7. **There is no DELETE HTTP handler for transactions.** The app (Dashboard) and Finn both delete via the Supabase client directly (`.delete().eq('id', …)`), relying on RLS. Ownership filter is `id`-only (matches Dashboard) — do NOT add `.eq('user_id', …)`, which would exclude legacy rows whose `user_id` is NULL.
