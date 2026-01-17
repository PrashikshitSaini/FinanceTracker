<div align="center">
  <img src="logo.png" alt="Finance Tracker Logo" width="200" />

  # Finance Tracker

  **Track your finances with AI-powered insights**

  [![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
  [![Supabase](https://img.shields.io/badge/Supabase-Powered-green)](https://supabase.com/)
</div>

---

## About

Finance Tracker is a modern, AI-powered web application designed to help you take complete control of your personal finances. With intelligent insights, beautiful visualizations, and seamless transaction management, you'll never lose track of your spending again.

Whether you're managing daily expenses, tracking income, analyzing spending patterns, or setting financial goals, Finance Tracker provides you with the tools and AI assistance to make informed financial decisions.

**Perfect for:**
- Individuals tracking personal expenses and income
- Budget-conscious users who want spending insights
- Anyone looking to understand their financial patterns
- People seeking AI-powered financial advice and recommendations

## Features

- **Comprehensive Dashboard** - Visualize income, expenses, and net balance with interactive charts and category breakdowns
- **Real-Time Transaction Management** - Add, edit, and categorize transactions with custom categories and payment sources
- **Calendar Views** - Google Calendar-style month, day, and year views to track transactions by date
- **AI Financial Assistant** - Get personalized insights, spending analysis, and financial advice powered by advanced AI
- **Receipt Scanning** - Capture and attach receipt images directly from your camera or upload from gallery
- **Multi-Currency Support** - Track finances in multiple currencies including USD, EUR, GBP, and more
- **Transaction Notes** - Add detailed notes to each transaction for better record-keeping
- **Category Management** - Organize transactions with customizable categories and color coding
- **Payment Source Tracking** - Monitor spending across different payment methods (cash, credit cards, digital wallets)
- **Secure Authentication** - Sign in securely with Google OAuth via Supabase
- **Dark Mode Interface** - Beautiful, eye-friendly dark theme for comfortable viewing
- **Fully Responsive** - Works seamlessly on desktop, tablet, and mobile devices
- **Receipt Storage** - Automatic cloud storage for all receipt images via Supabase Storage

## Screenshots

*Screenshots coming soon - start using the app to see it in action!*

---

# Developer Documentation

## Tech Stack

**Frontend:**
- Next.js 14 (App Router)
- TypeScript 5
- Tailwind CSS 3.4.0
- shadcn/ui component library
- Lucide React (icons)

**Backend & Services:**
- Supabase (PostgreSQL database, authentication, storage)
- OpenRouter AI API (GPT-OSS-120B model)
- date-fns (date utilities)

**Security & Validation:**
- Zod (input validation)
- Rate limiting (user-based)
- Row Level Security (RLS)
- Security headers (HSTS, CSP, etc.)

**Styling:**
- Tailwind CSS with dark mode
- Class Variance Authority (component variants)

## Prerequisites

Before you begin, ensure you have the following:
- Node.js (version 18.x or higher recommended)
- npm or yarn package manager
- Supabase account (free tier available)
- OpenRouter API account (for AI features)

## Getting Started

### Installation

1. Clone the repository:
```bash
git clone https://github.com/[your-username]/finance-tracker.git
cd finance-tracker
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file in the root directory:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
OPENROUTER_API_KEY=your_openrouter_api_key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

4. Set up Supabase:
   - Create a new project at [supabase.com](https://supabase.com)
   - Run the SQL schema from `supabase-schema.sql` in the SQL Editor
   - Create a storage bucket named `receipts` (make it public)
   - Enable Google OAuth in Authentication settings

5. Get OpenRouter API Key:
   - Sign up at [openrouter.ai](https://openrouter.ai)
   - Generate an API key from the dashboard
   - Add it to your `.env.local` file as `OPENROUTER_API_KEY`

6. Start the development server:
```bash
npm run dev
```

The app will open at [http://localhost:3000](http://localhost:3000)

### Available Scripts

In the project directory, you can run:

#### `npm run dev`
Runs the app in development mode. Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

#### `npm run build`
Builds the app for production to the `.next` folder. It correctly bundles Next.js in production mode and optimizes the build for the best performance.

#### `npm run start`
Starts the production server after building.

#### `npm run lint`
Runs ESLint to check for code quality issues.

## Project Structure

```
finance-tracker/
├── app/                          # Next.js app directory
│   ├── layout.tsx               # Root layout with providers
│   ├── page.tsx                 # Main app with tabs
│   ├── globals.css              # Global styles (dark theme)
│   ├── auth/
│   │   └── callback/
│   │       └── route.ts         # OAuth callback handler
│   └── api/
│       ├── ai-chat/route.ts     # AI assistant API
│       ├── transactions/route.ts # Transaction CRUD API
│       └── receipt/route.ts      # Receipt processing API
├── components/                   # React components
│   ├── Auth.tsx                 # Google OAuth login
│   ├── AnimatedBackground.tsx   # Animated SVG background
│   ├── Dashboard.tsx            # Main dashboard with charts
│   ├── TransactionForm.tsx      # Add/edit transactions
│   ├── CalendarView.tsx         # Calendar views (month/day/year)
│   ├── AIChat.tsx               # AI assistant chat interface
│   ├── ReceiptScanner.tsx       # Receipt image capture
│   ├── ImageUpload.tsx          # Image upload component
│   ├── CurrencySelector.tsx     # Currency switcher
│   └── ui/                      # shadcn/ui components
│       ├── button.tsx
│       ├── card.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── select.tsx
│       ├── tabs.tsx
│       └── [other ui components]
├── lib/                          # Utility functions
│   ├── supabase.ts              # Supabase client
│   ├── supabase-client.ts       # Browser client factory
│   ├── rate-limit.ts            # Rate limiting utility
│   ├── validation.ts            # Zod schemas
│   ├── currency.ts              # Currency utilities
│   └── utils.ts                 # General utilities
├── contexts/                     # React contexts
│   └── CurrencyContext.tsx      # Currency state management
├── types/
│   └── index.ts                 # TypeScript type definitions
├── public/                       # Static assets
├── supabase-schema.sql          # Database schema
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
├── tailwind.config.ts           # Tailwind config
├── next.config.js               # Next.js config
└── README.md                    # This file
```

## Database Schema

### Tables

**categories:**
- `id` (uuid, primary key)
- `name` (text)
- `color` (text) - Hex color for category
- `created_at` (timestamp)

**payment_sources:**
- `id` (uuid, primary key)
- `name` (text)
- `created_at` (timestamp)

**transactions:**
- `id` (uuid, primary key)
- `user_id` (uuid) - Links to Supabase auth users
- `amount` (numeric)
- `type` (text) - 'income' or 'expense'
- `category_id` (uuid) - Foreign key to categories
- `payment_source_id` (uuid) - Foreign key to payment_sources
- `date` (date)
- `notes` (text)
- `image_url` (text) - URL to receipt image in Supabase Storage
- `created_at` (timestamp)

### Row Level Security (RLS)

All tables have RLS policies to ensure users can only access their own data:
- Users can only view their own transactions
- Categories and payment sources are shared across users
- Receipt images are stored with user-specific paths

## Configuration

### Supabase Setup

1. **Create Tables:** Run the SQL schema from `supabase-schema.sql`
2. **Enable RLS:** Policies are included in the schema
3. **Storage Bucket:** Create a public `receipts` bucket for images
4. **Google OAuth:**
   - Enable Google provider in Authentication settings
   - Add authorized redirect URLs (localhost and production)

### OpenRouter AI Configuration

The AI assistant uses OpenRouter's API to provide:
- Spending pattern analysis
- Budget recommendations
- Financial goal tracking
- Natural language transaction queries

**Rate Limits:**
- AI Chat: 10 requests per minute per user
- Receipt Processing: 20 requests per minute per user

### Environment Variables

Required environment variables:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# OpenRouter AI
OPENROUTER_API_KEY=sk-or-v1-your-key

# App URL (for OAuth redirects)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Important:**
- `OPENROUTER_API_KEY` is server-side only (no `NEXT_PUBLIC_` prefix)
- Supabase keys are intentionally public (security via RLS)

## Deployment

### Deploy to Vercel (Recommended)

1. Push your code to GitHub
2. Visit [vercel.com](https://vercel.com) and import your repository
3. Configure environment variables in Vercel dashboard
4. Deploy! Vercel will automatically detect Next.js config

### Deploy to Other Platforms

The app can be deployed to any platform supporting Next.js:
- Netlify
- Railway
- AWS Amplify
- Self-hosted with Node.js

**Remember to:**
- Set all environment variables
- Configure Supabase redirect URLs for your domain
- Enable production mode in Supabase

## Security

This application implements comprehensive security measures:

### Implemented Security Features

✅ **API Key Protection** - OpenRouter API key stored server-side only
✅ **Row Level Security** - Database-level access control via Supabase RLS
✅ **Input Validation** - Zod schemas for all user inputs
✅ **Rate Limiting** - User-based rate limits on AI and receipt endpoints
✅ **Security Headers** - HSTS, CSP, X-Frame-Options, etc.
✅ **OAuth Callback Validation** - Whitelist-based redirect validation
✅ **PII Protection** - Sanitized logs with no personal data exposure
✅ **Authentication** - Secure Google OAuth via Supabase Auth

### Security Best Practices

- Never commit `.env.local` files (included in `.gitignore`)
- All API requests validated with Zod schemas
- Supabase RLS ensures user data isolation
- HTTPS enforced in production (HSTS headers)
- Regular security audits recommended

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a new branch: `git checkout -b feature/your-feature-name`
3. Make your changes and commit: `git commit -m 'Add some feature'`
4. Push to your branch: `git push origin feature/your-feature-name`
5. Open a Pull Request

Please ensure your code:
- Follows TypeScript best practices
- Includes proper type definitions
- Passes linting (`npm run lint`)
- Has been tested locally

## Usage Guide

### Adding Transactions

1. Click "Add Transaction" button in the header
2. Fill in transaction details:
   - Amount
   - Type (Income or Expense)
   - Category
   - Payment Source
   - Date
   - Notes (optional)
   - Receipt Image (optional)
3. Click "Add Transaction" to save

### Using the AI Assistant

1. Navigate to the "AI Assistant" tab
2. Ask questions about your finances:
   - "What are my top spending categories?"
   - "How much did I spend on food this month?"
   - "Give me budget recommendations"
3. Get personalized insights and recommendations

### Calendar Views

- **Month View:** See transactions organized by day
- **Day View:** Detailed view of transactions for a specific day
- **Year View:** Monthly summary across the entire year

## Troubleshooting

**Login Issues:**
- Ensure Google OAuth is enabled in Supabase
- Check redirect URLs match your deployment domain
- Clear browser cookies and try again

**AI Not Responding:**
- Verify `OPENROUTER_API_KEY` is set correctly
- Check rate limits haven't been exceeded
- Ensure API key has sufficient credits

**Database Errors:**
- Verify Supabase connection strings
- Check RLS policies are properly configured
- Ensure tables were created from schema

## License

This project is licensed under the MIT License. This means you are free to use, modify, and distribute this software, even for commercial purposes, as long as you include the original copyright notice.

To add a license file, create a `LICENSE` file in the root directory with the MIT License text.

## Support

- **Issues:** Found a bug or have a feature request? [Open an issue](https://github.com/[your-username]/finance-tracker/issues)
- **Discussions:** Have questions or want to discuss features? Use GitHub Discussions

---

<div align="center">
  Made with ❤️ for better financial management

  [Report Bug](https://github.com/[your-username]/finance-tracker/issues) • [Request Feature](https://github.com/[your-username]/finance-tracker/issues)
</div>
