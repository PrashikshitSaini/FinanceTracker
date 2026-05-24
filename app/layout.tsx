import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { CurrencyProvider } from "@/contexts/CurrencyContext"
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister"
import TimezoneSync from "@/components/TimezoneSync"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Finance Tracker",
  description: "Track your finances with AI-powered insights",
  // Linking the manifest enables PWA install on supported browsers.
  // The companion service worker (registered below in <head>) provides the
  // fetch handler Chrome on Android requires before offering "Install app".
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/wallet-icon.svg', type: 'image/svg+xml' },
      { url: '/icon.png', sizes: 'any' },
      { url: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' },
    ],
    apple: '/icon.png',
  },
  // Tell mobile Safari this app can run in fullscreen / standalone mode when
  // launched from a home-screen icon. Android Chrome reads this from the
  // manifest's `display: standalone`, so this is iOS-specific.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Finance',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#0a0a0a',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        {/* Side-effect component: registers /sw.js so Chrome upgrades the
            install affordance from "Add to Home Screen" to "Install app". */}
        <ServiceWorkerRegister />
        {/* Side-effect component: syncs the browser's IANA timezone to the
            user's Supabase metadata so server-side "today" calculations match
            the user's wall clock — fixes evening transactions landing on the
            next calendar day. */}
        <TimezoneSync />
        <CurrencyProvider>
          {children}
        </CurrencyProvider>
      </body>
    </html>
  )
}

