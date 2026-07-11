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

// OAuth scopes — 'repo' is required for Phase 2 (branch/commit/PR operations)
export const GITHUB_SCOPES = 'read:user user:email repo'

// Phase 2: Bug Fix Skill
export const MAX_BUGFIX_CONTEXT_CHUNKS = 8
// Fallback regex — primary check uses repository.defaultBranch dynamically
export const PROTECTED_BRANCH_PATTERN = /^(main|master|develop)$/

// Phase 3: Code Review and Documentation Skills
export const MAX_REVIEW_CONTEXT_CHUNKS = 6
export const MAX_DOCS_CONTEXT_CHUNKS = 8

// Phase 4: Execution Sandbox
export const MAX_EXECUTION_CODE_BYTES   = 65_536  // 64 KB hard cap before sending to Judge0
export const EXECUTION_POLL_TIMEOUT_MS  = 25_000  // 25s hard cap on polling loop
export const EXECUTION_POLL_INTERVAL_MS = 1_500   // poll every 1.5 seconds
export const MAX_CONCURRENT_EXECUTIONS  = 3       // per-workspace: QUEUED + RUNNING rows
export const MAX_EXECUTION_ATTEMPTS     = 2       // hard cap on re-diagnosis cycles
export const EXECUTION_QUEUE_NAME       = 'execute-code'
