/**
 * API client for ForgeAI.
 *
 * In the browser, requests go to /api/* which Next.js rewrites to the backend.
 * This avoids CORS issues with httpOnly cookies.
 * The NEXT_PUBLIC_API_URL is only used for server-side calls or direct links
 * (like the GitHub OAuth redirect).
 */
const API_BASE = ''  // Relative — Next.js rewrites /api/* to the backend

const DIRECT_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

interface FetchOptions extends RequestInit {
  skipAuth?: boolean
}

export async function api<T = unknown>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { skipAuth: _skipAuth, ...fetchOptions } = options

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...fetchOptions,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}))
    throw new ApiError(
      (errorBody as { error?: string }).error || response.statusText,
      response.status
    )
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Initiates GitHub OAuth — goes through Next.js proxy (/api/*) so the
 * oauth_state cookie is set on the SAME origin (localhost:3000) as the
 * callback URL. Going direct to :4000 causes state cookie mismatch in
 * Brave/Edge/Chrome which are strict about cross-port cookie scope.
 */
export function getGitHubLoginUrl(): string {
  return '/api/auth/github'
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' })
}
