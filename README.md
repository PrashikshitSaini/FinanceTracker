# Finance Tracker

A comprehensive finance tracking web application with AI-powered insights, built with Next.js, Supabase, and OpenRouter.

## Features

- 📊 **Dashboard**: View income, expenses, and net amount with category breakdowns
- 📅 **Calendar View**: Google Calendar-style views for month, day, and year
- 💰 **Transaction Management**: Add, edit, and delete transactions with categories and payment sources
- 📸 **Image Upload**: Capture receipts directly from camera or upload from gallery
- 📝 **Notes**: Add notes to each transaction
- 🤖 **AI Assistant**: Get insights and financial advice using GPT-OSS-120B from OpenRouter
- 📱 **Responsive Design**: Works seamlessly on mobile and desktop

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run the SQL from `supabase-schema.sql`
3. Go to Storage and create a bucket named `receipts` (or it will be created by the SQL script)
4. Make sure the bucket is public

### 3. Configure Environment Variables

Create a `.env.local` file in the root directory:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
NEXT_PUBLIC_OPENROUTER_API_KEY=your_openrouter_api_key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Get OpenRouter API Key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Get your API key from the dashboard
3. Add it to your `.env.local` file

### 5. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Tech Stack

- **Next.js 14** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **Supabase** - Database and storage
- **OpenRouter** - AI API (GPT-OSS-120B)
- **date-fns** - Date utilities

## Project Structure

```
├── app/
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Main page with tabs
│   └── globals.css         # Global styles
├── components/
│   ├── ui/                 # shadcn/ui components
│   ├── Dashboard.tsx       # Dashboard with charts and stats
│   ├── CalendarView.tsx    # Calendar views (month/day/year)
│   ├── TransactionForm.tsx # Add/edit transaction form
│   ├── ImageUpload.tsx     # Image upload component
│   └── AIChat.tsx          # AI assistant chat
├── lib/
│   ├── supabase.ts         # Supabase client
│   ├── openrouter.ts       # OpenRouter API client
│   └── utils.ts            # Utility functions
└── types/
    └── index.ts            # TypeScript types
```

## Usage

1. **Add Transaction**: Click "Add Transaction" button and fill in the details
2. **View Dashboard**: See your financial overview with charts and recent transactions
3. **Calendar View**: Switch to calendar tab to see transactions by date
4. **AI Assistant**: Ask questions about your finances, get insights, and set goals

## Database Schema

- **categories**: Transaction categories with colors
- **payment_sources**: Payment methods (cash, credit card, etc.)
- **transactions**: All financial transactions with amount, category, date, notes, and images

## Notes

- The app uses Supabase Row Level Security (RLS). For production, you should implement proper authentication and user-specific policies.
- Image uploads are stored in Supabase Storage in the `receipts` bucket.
- The AI assistant has access to all transactions and can provide insights based on your spending patterns.

