import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { CurrencyProvider } from "@/contexts/CurrencyContext"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Finance Tracker",
  description: "Track your finances with AI-powered insights",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <CurrencyProvider>
          {children}
        </CurrencyProvider>
      </body>
    </html>
  )
}

