import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

/**
 * GET /api/auth/github
 *
 * Next.js Route Handler that initiates the GitHub OAuth flow.
 * We handle this here (not via proxy rewrite) so Set-Cookie (oauth_state)
 * is applied to the Next.js response directly — guaranteeing it's on the
 * same origin (localhost:3000) as the callback URL.
 */
export async function GET(request: NextRequest) {
  // Ask Express to build the authorization URL + state cookie
  const backendResponse = await fetch(
    `${BACKEND_URL}/api/auth/github`,
    {
      redirect: 'manual', // Don't follow — we want the raw 302 + Set-Cookie
    }
  )

  const githubUrl = backendResponse.headers.get('location')

  if (!githubUrl) {
    console.error('[auth/github] No location header from Express')
    return NextResponse.redirect(new URL('/?error=auth_failed', request.url))
  }

  // Redirect browser to GitHub
  const response = NextResponse.redirect(githubUrl)

  // Copy the oauth_state Set-Cookie from Express → browser response
  const setCookieHeader = backendResponse.headers.get('set-cookie')
  if (setCookieHeader) {
    response.headers.append('set-cookie', setCookieHeader)
  }

  return response
}
