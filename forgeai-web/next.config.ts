import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Proxy API requests to the backend in development.
  // /api/auth/github and /api/auth/github/callback are excluded — those are
  // handled by Next.js Route Handlers (src/app/api/) which properly set
  // cookies on the browser response without the proxy stripping Set-Cookie.
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
