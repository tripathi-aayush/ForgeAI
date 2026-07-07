import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

/**
 * GET /api/auth/github/callback
 *
 * Next.js Route Handler that acts as the real OAuth callback endpoint.
 * We handle this in Next.js (not via the proxy rewrite) so we can:
 *   1. Forward the request to Express to do the heavy lifting
 *   2. Copy the Set-Cookie header from Express's response directly
 *      into the browser response — avoiding the proxy stripping issue
 *      where Next.js rewrites drop Set-Cookie on redirect responses.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  // Build the backend callback URL with the same query params GitHub sent
  const backendUrl = new URL(
    `${BACKEND_URL}/api/auth/github/callback`
  )
  searchParams.forEach((value, key) => {
    backendUrl.searchParams.set(key, value)
  })

  // Forward the request to Express, including all browser cookies
  // (so Express can read the oauth_state cookie we set earlier)
  const backendResponse = await fetch(backendUrl.toString(), {
    headers: {
      // Forward cookies so Express can validate oauth_state
      cookie: request.headers.get('cookie') || '',
    },
    redirect: 'manual', // Don't follow the redirect — we want the raw 302
  })

  const destination = backendResponse.headers.get('location')

  if (!destination) {
    // Express returned an error JSON response
    const body = await backendResponse.text()
    console.error('[callback] No location header from Express:', body)
    return NextResponse.redirect(new URL('/?error=auth_failed', request.url))
  }

  // Build our redirect response to the browser
  const response = NextResponse.redirect(
    destination.startsWith('http')
      ? destination
      : new URL(destination, request.url).toString()
  )

  // Copy ALL Set-Cookie headers from Express → browser response
  // This is the key fix: the proxy (rewrite) was silently dropping these
  const setCookieHeader = backendResponse.headers.get('set-cookie')
  if (setCookieHeader) {
    // split on ", " only between separate cookies (after flag values)
    // A simple approach: split on "; " followed by a capitalized flag or new cookie
    // Actually the safest is to use getSetCookie() if available (Node 18+)
    const cookies = splitSetCookieHeader(setCookieHeader)
    cookies.forEach((cookie) => {
      response.headers.append('set-cookie', cookie)
    })
  }

  return response
}

/**
 * Split a combined Set-Cookie header string into individual cookie strings.
 * Handles the edge case where commas appear inside cookie values/dates.
 */
function splitSetCookieHeader(header: string): string[] {
  const cookies: string[] = []
  let current = ''

  // Split on ", " that precede a new cookie name (word=value pattern)
  // This is safer than a simple split on ","
  for (let i = 0; i < header.length; i++) {
    if (
      header[i] === ',' &&
      i + 1 < header.length &&
      /\s[A-Za-z0-9_-]+=/.test(header.slice(i + 1, i + 30))
    ) {
      cookies.push(current.trim())
      current = ''
    } else {
      current += header[i]
    }
  }

  if (current.trim()) {
    cookies.push(current.trim())
  }

  return cookies
}
