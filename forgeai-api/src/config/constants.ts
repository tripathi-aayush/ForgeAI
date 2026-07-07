/**
 * Application-wide constants.
 * Indexing guardrails are set here and can be overridden via env vars.
 */
export const MAX_INDEX_FILES = parseInt(process.env.MAX_INDEX_FILES ?? '2000', 10)
export const MAX_FILE_SIZE_KB = parseInt(process.env.MAX_FILE_SIZE_KB ?? '512', 10)

export const JWT_EXPIRY = '7d'
export const COOKIE_NAME = 'forgeai_session'

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'

// OAuth scopes — start with read-only user info, expand in Phase 1
export const GITHUB_SCOPES = 'read:user user:email'
