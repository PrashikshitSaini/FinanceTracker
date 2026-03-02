/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on'
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload'
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          },
          {
            // Supabase auth requires supabase.co origins for OAuth flows.
            // openrouter.ai is allowed as a connect-src because the receipt/ai-chat API
            // routes call it server-side (fetch from Node), but defensive CSP still
            // blocks any accidental client-side calls.
            // 'unsafe-inline' for styles is required by Tailwind's runtime class injection.
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://accounts.google.com",
              "style-src 'self' 'unsafe-inline' https://accounts.google.com",
              "img-src 'self' data: blob: https://*.supabase.co https://supabase.co https://*.googleusercontent.com https://accounts.google.com",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co https://supabase.co wss://*.supabase.co https://accounts.google.com",
              "frame-src 'self' https://accounts.google.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self' https://accounts.google.com",
            ].join('; ')
          }
        ],
      },
    ]
  },
}

module.exports = nextConfig

