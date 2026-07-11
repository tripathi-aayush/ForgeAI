import { env } from '../config/env'
import {
  MAX_EXECUTION_CODE_BYTES,
  EXECUTION_POLL_TIMEOUT_MS,
  EXECUTION_POLL_INTERVAL_MS,
} from '../config/constants'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExecutionPayloadTooLargeError extends Error {
  constructor(actualBytes: number) {
    super(
      `Code payload exceeds max allowed size (${actualBytes} bytes > ${MAX_EXECUTION_CODE_BYTES} bytes). ` +
        `Reduce the file size before submitting.`
    )
    this.name = 'ExecutionPayloadTooLargeError'
  }
}

export class ExecutionTimeoutError extends Error {
  constructor() {
    super(
      `Execution timed out after ${EXECUTION_POLL_TIMEOUT_MS}ms. ` +
        `The sandbox did not return a result within the allowed polling window.`
    )
    this.name = 'ExecutionTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionRequest {
  /** Raw source code — the service base64-encodes it before sending to Judge0. */
  sourceCode: string
  /** Judge0 language ID (e.g. 71=Python, 93=Node.js, 94=TypeScript, 60=Go, 91=Java) */
  languageId: number
  /** Optional stdin to pass to the program. */
  stdin?: string
}

export interface ExecutionResult {
  stdout: string | null
  stderr: string | null
  /** The process exit code returned by Judge0. Null if compilation failed. */
  exitCode: number | null
  /**
   * True only when Judge0 status ID = 3 (Accepted) AND exitCode = 0.
   * All other outcomes — compile error, runtime error, TLE, MLE, etc. — are false.
   */
  passed: boolean
  /** Human-readable Judge0 status description (e.g. "Accepted", "Runtime Error"). */
  status: string
}

/**
 * Internal Judge0 submission response shape (abbreviated).
 * Full schema: https://github.com/judge0/judge0/blob/master/docs/api/submissions/get.md
 */
interface Judge0Submission {
  token: string
  status?: {
    id: number
    description: string
  }
  stdout?: string | null
  stderr?: string | null
  compile_output?: string | null
  exit_code?: number | null
  message?: string | null
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Abstracts all HTTP calls to the self-hosted Judge0 instance.
 *
 * Security notes:
 * - Source code is base64-encoded before transmission; no shell commands are constructed.
 * - Full source code is NEVER logged. Audit logs contain only workspace/run IDs and outcome.
 * - Polling is bounded by EXECUTION_POLL_TIMEOUT_MS to prevent indefinite waiting.
 * - Code size is checked before any network call.
 */
export class Judge0ExecutionService {
  private baseUrl: string
  private apiKey: string | undefined

  constructor(baseUrl: string, apiKey?: string) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  /**
   * Submit code for execution and poll until a result is available.
   *
   * @param request - Source code, language ID, optional stdin.
   * @param workspaceId - For audit logging only (never used to modify behaviour).
   * @param skillRunId - For audit logging only.
   * @returns ExecutionResult with stdout, stderr, exitCode, passed, status.
   * @throws ExecutionPayloadTooLargeError if sourceCode exceeds MAX_EXECUTION_CODE_BYTES.
   * @throws ExecutionTimeoutError if polling exceeds EXECUTION_POLL_TIMEOUT_MS.
   */
  async submit(
    request: ExecutionRequest,
    workspaceId: string,
    skillRunId: string
  ): Promise<ExecutionResult> {
    // ── Guardrail 1: Size check ──────────────────────────────────────────────
    const byteLength = Buffer.byteLength(request.sourceCode, 'utf8')
    if (byteLength > MAX_EXECUTION_CODE_BYTES) {
      throw new ExecutionPayloadTooLargeError(byteLength)
    }

    // ── Step 1: Submit to Judge0 ─────────────────────────────────────────────
    const submitBody = {
      source_code: Buffer.from(request.sourceCode, 'utf8').toString('base64'),
      language_id: request.languageId,
      stdin: request.stdin ? Buffer.from(request.stdin, 'utf8').toString('base64') : undefined,
    }

    const submitResponse = await fetch(
      `${this.baseUrl}/submissions?base64_encoded=true&wait=false`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(submitBody),
      }
    )

    if (!submitResponse.ok) {
      const text = await submitResponse.text()
      throw new Error(`Judge0 submission failed: ${submitResponse.status} — ${text}`)
    }

    const { token } = (await submitResponse.json()) as { token: string }

    if (!token) {
      throw new Error('Judge0 returned no submission token')
    }

    // ── Step 2: Poll for result with hard timeout ────────────────────────────
    const pollStart = Date.now()

    while (true) {
      // Hard timeout — never wait indefinitely
      if (Date.now() - pollStart > EXECUTION_POLL_TIMEOUT_MS) {
        throw new ExecutionTimeoutError()
      }

      await this.sleep(EXECUTION_POLL_INTERVAL_MS)

      const pollResponse = await fetch(
        `${this.baseUrl}/submissions/${token}?base64_encoded=true`,
        { headers: this.buildHeaders() }
      )

      if (!pollResponse.ok) {
        const text = await pollResponse.text()
        throw new Error(`Judge0 poll failed: ${pollResponse.status} — ${text}`)
      }

      const submission = (await pollResponse.json()) as Judge0Submission
      const statusId = submission.status?.id ?? 0

      // Status IDs 1 (In Queue) and 2 (Processing) → keep polling
      if (statusId === 1 || statusId === 2) {
        continue
      }

      // Terminal state reached — build result
      const passed = statusId === 3 && (submission.exit_code ?? 1) === 0

      // Decode base64 outputs (Judge0 returns them base64-encoded)
      const stdout = this.decodeBase64OrNull(submission.stdout)
      const stderr = this.decodeBase64OrNull(submission.stderr ?? submission.compile_output)

      const result: ExecutionResult = {
        stdout,
        stderr,
        exitCode: submission.exit_code ?? null,
        passed,
        status: submission.status?.description ?? 'Unknown',
      }

      // ── Guardrail 2: Audit log — no code content ─────────────────────────
      console.log('[exec-audit]', {
        workspaceId,
        skillRunId,
        languageId: request.languageId,
        statusId,
        passed,
        exitCode: result.exitCode,
        attemptedAt: new Date().toISOString(),
        // NOTE: sourceCode is intentionally NOT logged here
      })

      return result
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    if (this.apiKey) {
      headers['X-Auth-Token'] = this.apiKey
    }
    return headers
  }

  private decodeBase64OrNull(value: string | null | undefined): string | null {
    if (!value) return null
    try {
      return Buffer.from(value, 'base64').toString('utf8')
    } catch {
      return value // return as-is if decoding fails
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a Judge0ExecutionService instance if JUDGE0_BASE_URL is configured,
 * or null if it is not. Callers must handle the null case (graceful skip).
 *
 * This never throws — a missing sandbox config is a normal "not configured" state,
 * not an error.
 */
export function getExecutionService(): Judge0ExecutionService | null {
  if (!env.JUDGE0_BASE_URL) {
    return null
  }
  return new Judge0ExecutionService(env.JUDGE0_BASE_URL, env.JUDGE0_API_KEY)
}

// ---------------------------------------------------------------------------
// Judge0 Language ID Map
// ---------------------------------------------------------------------------

/**
 * Maps common file extensions to Judge0 language IDs.
 *
 * IMPORTANT: These IDs are for the standard Judge0 CE build. Your self-hosted
 * instance may use different IDs depending on the version and installed language
 * packs. Verify by calling GET JUDGE0_BASE_URL/languages before live testing.
 */
export const LANGUAGE_ID_MAP: Record<string, number> = {
  // JavaScript / TypeScript
  '.js':   93,  // Node.js 18
  '.mjs':  93,
  '.ts':   94,  // TypeScript 5
  '.tsx':  94,
  // Python
  '.py':   71,  // Python 3.11
  // Go
  '.go':   60,  // Go 1.21
  // Java
  '.java': 91,  // Java 17
  // C / C++
  '.c':    50,  // C (GCC 9.2)
  '.cpp':  54,  // C++ (GCC 9.2)
  // Rust
  '.rs':   73,  // Rust 1.65
  // Ruby
  '.rb':   72,  // Ruby 3
  // PHP
  '.php':  68,  // PHP 8
  // C#
  '.cs':   51,  // C# Mono 6
  // Bash
  '.sh':   46,  // Bash 5
}

/**
 * Resolve a Judge0 language ID from a file path extension.
 * Returns null if the extension is not in the map.
 */
export function resolveLanguageId(filePath: string): number | null {
  const ext = filePath.includes('.') ? `.${filePath.split('.').pop()!.toLowerCase()}` : ''
  return LANGUAGE_ID_MAP[ext] ?? null
}
