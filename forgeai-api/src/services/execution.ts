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
  /** The process exit code. Null if compilation failed. */
  exitCode: number | null
  /**
   * True only when compilation and execution succeeded (exitCode === 0).
   */
  passed: boolean
  /** Human-readable status description (e.g. "Accepted", "Runtime Error"). */
  status: string
  /** Which execution backend served this request */
  executedVia?: 'judge0' | 'piston'
}

/**
 * Internal Judge0 submission response shape (abbreviated).
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
// Judge0 Execution Service
// ---------------------------------------------------------------------------

/**
 * Abstracts HTTP calls to the self-hosted Judge0 instance.
 */
class Judge0ExecutionService {
  private baseUrl: string
  private apiKey: string | undefined

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  async submit(
    request: ExecutionRequest,
    workspaceId: string,
    skillRunId: string
  ): Promise<Omit<ExecutionResult, 'executedVia'>> {
    // Submit to Judge0
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

    // Poll for result
    const pollStart = Date.now()
    while (true) {
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

      // Queue/Processing states
      if (statusId === 1 || statusId === 2) {
        continue
      }

      // Sandbox Internal Error (statusId 13) indicates infrastructure failure, not code failure.
      // Throw an error to trigger Piston fallback.
      if (statusId === 13) {
        throw new Error(
          `Judge0 sandbox returned Internal Error (status 13): ${submission.message || 'No details provided'}`
        )
      }

      const passed = statusId === 3 && (submission.exit_code ?? 1) === 0
      const stdout = this.decodeBase64OrNull(submission.stdout)
      const stderr = this.decodeBase64OrNull(submission.stderr ?? submission.compile_output)

      const result: Omit<ExecutionResult, 'executedVia'> = {
        stdout,
        stderr,
        exitCode: submission.exit_code ?? null,
        passed,
        status: submission.status?.description ?? 'Unknown',
      }

      // Audit log (no code content)
      console.log('[exec-audit]', {
        workspaceId,
        skillRunId,
        languageId: request.languageId,
        statusId,
        passed,
        exitCode: result.exitCode,
        attemptedAt: new Date().toISOString(),
        executedVia: 'judge0',
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
      return value
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ---------------------------------------------------------------------------
// Piston Fallback Service Map
// ---------------------------------------------------------------------------

export const PISTON_LANGUAGE_MAP: Record<string, { language: string; version: string }> = {
  '.js':   { language: 'javascript', version: '*' },
  '.mjs':  { language: 'javascript', version: '*' },
  '.ts':   { language: 'typescript', version: '*' },
  '.tsx':  { language: 'typescript', version: '*' },
  '.py':   { language: 'python', version: '*' },
  '.go':   { language: 'go', version: '*' },
  '.java': { language: 'java', version: '*' },
  '.c':    { language: 'c', version: '*' },
  '.cpp':  { language: 'cpp', version: '*' },
  '.rs':   { language: 'rust', version: '*' },
  '.rb':   { language: 'ruby', version: '*' },
  '.php':  { language: 'php', version: '*' },
  '.cs':   { language: 'csharp', version: '*' },
  '.sh':   { language: 'bash', version: '*' },
}

// ---------------------------------------------------------------------------
// Swappable Unified Code Execution Service
// ---------------------------------------------------------------------------

export class CodeExecutionService {
  private judge0Service: Judge0ExecutionService | null = null

  constructor() {
    if (env.JUDGE0_BASE_URL) {
      this.judge0Service = new Judge0ExecutionService(env.JUDGE0_BASE_URL, env.JUDGE0_API_KEY)
    }
  }

  /**
   * Submit code for execution. Tries Judge0 first (if configured and reachable);
   * otherwise gracefully falls back to Piston public API.
   *
   * @param request - Code execution input
   * @param workspaceId - Workspace reference for audit logs
   * @param skillRunId - SkillRun reference for audit logs
   * @param filePath - Path to file being executed (used to map file extension for Piston)
   */
  async submit(
    request: ExecutionRequest,
    workspaceId: string,
    skillRunId: string,
    filePath: string
  ): Promise<ExecutionResult> {
    // Size check guardrail applies to all backends
    const byteLength = Buffer.byteLength(request.sourceCode, 'utf8')
    if (byteLength > MAX_EXECUTION_CODE_BYTES) {
      throw new ExecutionPayloadTooLargeError(byteLength)
    }

    if (this.judge0Service) {
      try {
        console.log(`[exec-service] Attempting sandbox execution via Judge0...`)
        const result = await this.judge0Service.submit(request, workspaceId, skillRunId)
        return {
          ...result,
          executedVia: 'judge0',
        }
      } catch (err: any) {
        console.warn(
          `[exec-service] Judge0 execution failed or host is unreachable. ` +
            `Falling back to Piston. Error: ${err.message}`
        )
      }
    }

    // Unconfigured or failed Judge0 -> execute via Piston
    return this.runViaPiston(request, workspaceId, skillRunId, filePath)
  }

  private async runViaPiston(
    request: ExecutionRequest,
    workspaceId: string,
    skillRunId: string,
    filePath: string
  ): Promise<ExecutionResult> {
    const ext = filePath.includes('.') ? `.${filePath.split('.').pop()!.toLowerCase()}` : ''
    const mapping = PISTON_LANGUAGE_MAP[ext] || { language: 'plaintext', version: '*' }
    const filename = filePath.split('/').pop() || 'index'

    console.log(`[exec-service] Executing code via Piston public API (${mapping.language})...`)

    const pistonBody = {
      language: mapping.language,
      version: mapping.version,
      files: [
        {
          name: filename,
          content: request.sourceCode,
        },
      ],
      stdin: request.stdin || '',
    }

    const response = await fetch('https://emkc.org/api/v2/piston/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pistonBody),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Piston API execution failed: ${response.status} — ${text}`)
    }

    const data = (await response.json()) as {
      run: {
        stdout: string
        stderr: string
        code: number
        signal: string | null
        output: string
      }
      compile?: {
        stdout: string
        stderr: string
        code: number
        signal: string | null
        output: string
      }
    }

    const runCode = data.run.code
    const compileCode = data.compile?.code ?? 0
    const passed = runCode === 0 && compileCode === 0

    const result: ExecutionResult = {
      stdout: data.run.stdout || null,
      stderr: data.run.stderr || data.compile?.stderr || null,
      exitCode: data.run.code ?? null,
      passed,
      status: passed ? 'Accepted' : data.compile?.code !== 0 ? 'Compile Error' : 'Runtime Error',
      executedVia: 'piston',
    }

    // Audit log (no code content)
    console.log('[exec-audit]', {
      workspaceId,
      skillRunId,
      language: mapping.language,
      passed,
      exitCode: result.exitCode,
      attemptedAt: new Date().toISOString(),
      executedVia: 'piston',
    })

    return result
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a swappable CodeExecutionService instance.
 * Never returns null, as Piston serves as a zero-config fallback.
 */
export function getExecutionService(): CodeExecutionService {
  return new CodeExecutionService()
}

// ---------------------------------------------------------------------------
// Language maps
// ---------------------------------------------------------------------------

export const LANGUAGE_ID_MAP: Record<string, number> = {
  '.js':   93,
  '.mjs':  93,
  '.ts':   94,
  '.tsx':  94,
  '.py':   71,
  '.go':   60,
  '.java': 91,
  '.c':    50,
  '.cpp':  54,
  '.rs':   73,
  '.rb':   72,
  '.php':  68,
  '.cs':   51,
  '.sh':   46,
}

export function resolveLanguageId(filePath: string): number | null {
  const ext = filePath.includes('.') ? `.${filePath.split('.').pop()!.toLowerCase()}` : ''
  return LANGUAGE_ID_MAP[ext] ?? null
}
