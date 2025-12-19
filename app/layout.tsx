import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { CurrencyProvider } from "@/contexts/CurrencyContext"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Finance Tracker",
  description: "Track your finances with AI-powered insights",
  icons: {
    icon: [
      { url: '/icon.png', sizes: 'any' },
      { url: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' },
    ],
    apple: '/icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
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

