# Finance Tracker — Public API

External systems can read and write your transactions using your **X-API-Key**.
Create a key in the app (header → three-dots menu → API Keys → Create) and pass
it as the `X-API-Key` header on every request.

Base URL: `https://YOUR-APP.vercel.app` (replace with your deployed Finance
Tracker URL, e.g. `https://financetrackerforyou.vercel.app`).

All endpoints respect Row Level Security — every request is scoped to the user
who owns the API key. Rate limit: **30 writes + reads / minute / user**.

---

## `GET /api/transactions`

List transactions for the authenticated user, newest first, with optional
filters and pagination.

### Query parameters (all optional)

| Param | Format | Default | Notes |
|---|---|---|---|
| `start_date` | `YYYY-MM-DD` | none | Inclusive lower bound on `date` |
| `end_date` | `YYYY-MM-DD` | none | Inclusive upper bound on `date` |
| `type` | `income` \| `expense` | none | Filter by transaction type |
| `category` | UUID | none | Filter by category id |
| `payment_source` | UUID | none | Filter by payment_source id |
| `is_refund` | `true` \| `false` | none | Filter refund vs non-refund rows |
| `limit` | integer | `100` | Max `500` |
| `offset` | integer | `0` | Max `100000` |
| `expand` | `true` \| `false` | `false` | When `true`, includes `category_name` and `payment_source_name` resolved from the user's lookup tables |

### Response

```json
{
  "data": [
    {
      "id": "uuid",
      "amount": 5.40,
      "type": "expense",
      "date": "2026-05-23",
      "category": "uuid",
      "payment_source": "uuid",
      "notes": "Starbucks",
      "image_url": null,
      "user_id": "uuid",
      "is_refund": false,
      "client_ref": null,
      "created_at": "2026-05-23T21:10:44.974589+00:00",
      "updated_at": "2026-05-23T21:10:44.974589+00:00",
      // ↓ Only when ?expand=true
      "category_name": "Coffee",
      "payment_source_name": "Card •• 1234"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 247,
    "has_more": true
  }
}
```

### Examples

Last 30 days of expenses with resolved names:

```bash
curl -s "https://YOUR-APP.vercel.app/api/transactions?start_date=2026-05-01&type=expense&expand=true&limit=200" \
  -H "X-API-Key: ftqa_..."
```

Paginate through all transactions:

```bash
curl -s "https://YOUR-APP.vercel.app/api/transactions?limit=100&offset=0" \
  -H "X-API-Key: ftqa_..."
# bump offset by 100 each time until has_more is false
```

This month's refunds only:

```bash
curl -s "https://YOUR-APP.vercel.app/api/transactions?start_date=2026-05-01&end_date=2026-05-31&is_refund=true" \
  -H "X-API-Key: ftqa_..."
```

---

## `GET /api/transactions/{id}`

Fetch a single transaction by its UUID.

```bash
curl -s "https://YOUR-APP.vercel.app/api/transactions/280e3595-b51c-4ce7-9d0f-231ad9b3695c" \
  -H "X-API-Key: ftqa_..."
```

### Response

```json
{
  "data": {
    "id": "280e3595-b51c-4ce7-9d0f-231ad9b3695c",
    "amount": 116.44,
    "type": "expense",
    "date": "2026-05-23",
    "category": "uuid",
    "payment_source": "uuid",
    "notes": "WAL-MART NEIGHBORHOOD MARKET with Blue Cash Everyday ••1005",
    "is_refund": false,
    "client_ref": null,
    "...": "..."
  }
}
```

Returns `404` if the id doesn't exist OR belongs to a different user (we don't
distinguish — that would leak existence of other users' IDs).

---

## `POST /api/quick-add`

Create a transaction. Two body shapes:

**Simple (structured):**

```bash
curl -s "https://YOUR-APP.vercel.app/api/quick-add" \
  -H "X-API-Key: ftqa_..." \
  -H "Content-Type: application/json" \
  -d '{"amount": 5.40, "description": "Coffee", "category": "Food"}'
```

**AI (natural language) — form-encoded so non-ASCII chars survive:**

```bash
curl -s -X POST "https://YOUR-APP.vercel.app/api/quick-add" \
  -H "X-API-Key: ftqa_..." \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "text=WAL-MART NEIGHBORHOOD MARKET: \$116.44 with Blue Cash Everyday® ••1005"
```

See the inline doc comment in `app/api/quick-add/route.ts` for the full field
list (`card_last_four`, `is_refund`, `client_ref`, `source_app`).

---

## `PATCH /api/transactions/{id}`

Partial update of a single transaction. Two modes — structured patch (fields)
or AI free-text re-parse. See `app/api/transactions/[id]/route.ts` for full
documentation.

Quick example — change a transaction's category by name:

```bash
curl -s -X PATCH "https://YOUR-APP.vercel.app/api/transactions/<id>" \
  -H "X-API-Key: ftqa_..." \
  -H "Content-Type: application/json" \
  -d '{"category": "Groceries"}'
```

---

## Error responses

All errors are JSON: `{"error": "human-readable description"}`.

| Status | Meaning |
|---|---|
| `400` | Bad request (invalid query param, malformed body) |
| `401` | Auth missing or invalid |
| `404` | Resource not found (or not yours) |
| `422` | Validation failed (e.g., AI couldn't determine amount from text) |
| `429` | Rate limit (30/min/user) — back off and retry |
| `500` | Server error — check Vercel logs |

---

## Rate limit

In-memory, **per-user**, **30 requests / minute** across all `/api/quick-add`,
`/api/transactions` (GET / POST / PUT), and `/api/transactions/{id}`
(GET / PATCH) calls combined. If you're polling, batch your requests or use a
cron with a sane interval (every 5 min is plenty for personal use).

Hitting the limit returns `429` with a "wait N seconds" hint in the error
message.
