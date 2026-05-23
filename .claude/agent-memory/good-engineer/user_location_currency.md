---
name: user-location-currency
description: User is based in the US and works in USD — do not assume India / INR or any other locale
metadata:
  type: user
---

User is in the **United States** and uses **USD ($)**.

**How to apply:**
- All examples, mocks, sample data, currency formatting, and locale-specific suggestions should default to US conventions (USD, $, mm/dd/yyyy if a date format is shown casually, US merchant names in examples).
- Do NOT use INR / ₹ / Indian merchant examples (Starbucks-in-India, chai, Paytm, UPI, etc.) unless the user explicitly asks for them.
- When recommending integrations (banking, payments, identity), default to US-available options: Plaid (US), Finicity, MX, Stripe, Visa/Mastercard rails, Zelle, ACH. Do not lead with India-specific options (Setu, Account Aggregator, UPI).
- When suggesting Android automation that depends on locale-specific notifications (e.g., Google Wallet payment notification format), assume the US version of the app and the US notification phrasing.
