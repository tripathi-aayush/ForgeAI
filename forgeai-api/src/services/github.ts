import { env } from '../config/env'
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  GITHUB_SCOPES,
} from '../config/constants'

interface GitHubTokenResponse {
  access_token: string
  token_type: string
  scope: string
}

export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatar_url: string
  email: string | null
}

/**
 * Build the GitHub OAuth authorization URL.
 */
export function getAuthorizationUrl(state: string): string {
  // In development, the Next.js proxy rewrites /api/* to the backend,
  // so we use FRONTEND_URL for the callback. In production, use the same
  // pattern — the frontend proxies or a custom domain is configured.
  const callbackUrl =
    process.env.BACKEND_URL || `${env.FRONTEND_URL}/api/auth/github/callback`

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: GITHUB_SCOPES,
    state,
  })

  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Exchange an authorization code for an access token.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`)
  }

  const data = (await response.json()) as GitHubTokenResponse

  if (!data.access_token) {
    throw new Error('GitHub token exchange returned no access_token')
  }

  return data.access_token
}

/**
 * Fetch the authenticated user's GitHub profile.
 */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `token ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`)
  }

  return response.json() as Promise<GitHubUser>
}
