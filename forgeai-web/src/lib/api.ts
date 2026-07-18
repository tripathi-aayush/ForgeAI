/**
 * API client for ForgeAI.
 *
 * In the browser, requests go to /api/* which Next.js rewrites to the backend.
 * This avoids CORS issues with httpOnly cookies.
 * The NEXT_PUBLIC_API_URL is only used for server-side calls or direct links
 * (like the GitHub OAuth redirect).
 */
const API_BASE = ''  // Relative — Next.js rewrites /api/* to the backend

interface FetchOptions extends RequestInit {
  skipAuth?: boolean
}

const COLD_START_RETRY_STATUSES = [502, 503]
const COLD_START_MAX_RETRIES = 2
const COLD_START_RETRY_DELAY_MS = 1000

async function fetchWithRetry(url: string, options: RequestInit, retriesLeft: number): Promise<Response> {
  const response = await fetch(url, options)

  if (
    !response.ok &&
    COLD_START_RETRY_STATUSES.includes(response.status) &&
    retriesLeft > 0
  ) {
    await new Promise((r) => setTimeout(r, COLD_START_RETRY_DELAY_MS))
    return fetchWithRetry(url, options, retriesLeft - 1)
  }

  return response
}

export async function api<T = unknown>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { skipAuth: _skipAuth, ...fetchOptions } = options

  const fetchOpts: RequestInit = {
    ...fetchOptions,
    credentials: 'include' as RequestCredentials,
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  }

  const response = await fetchWithRetry(`${API_BASE}${endpoint}`, fetchOpts, COLD_START_MAX_RETRIES)

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

// ---------------------------------------------------------------------------
// Phase 6: GitBrain Lite — Discovery API helpers
// ---------------------------------------------------------------------------

export interface DiscoveredRepo {
  id: string
  githubUrl: string
  owner: string
  name: string
  description: string | null
  stars: number
  openIssues: number
  lastPushedAt: string
  domainTags: string[]
  techTags: string[]
  architectureTags: string[]
  healthScore: number
  embeddingProvider: string
  lastRefreshedAt: string
  similarity?: number
}

export interface DiscoverCatalogParams {
  limit?: number
  offset?: number
  tag?: string
  minStars?: number
}

export interface DiscoverSearchParams {
  query: string
  limit?: number
  minStars?: number
}

export async function discoverCatalog(params: DiscoverCatalogParams = {}): Promise<{
  repos: DiscoveredRepo[]
  total: number
  limit: number
  offset: number
}> {
  const searchParams = new URLSearchParams()
  if (params.limit)    searchParams.set('limit',    String(params.limit))
  if (params.offset)   searchParams.set('offset',   String(params.offset))
  if (params.tag)      searchParams.set('tag',      params.tag)
  if (params.minStars) searchParams.set('minStars', String(params.minStars))
  const qs = searchParams.toString()
  return api<{ repos: DiscoveredRepo[]; total: number; limit: number; offset: number }>(
    `/api/discover${qs ? `?${qs}` : ''}`
  )
}

export async function discoverSearch(params: DiscoverSearchParams): Promise<{
  results: DiscoveredRepo[]
  provider: string
  note: string
}> {
  return api<{ results: DiscoveredRepo[]; provider: string; note: string }>(
    '/api/discover/search',
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  )
}

