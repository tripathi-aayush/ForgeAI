import { Worker, Job } from 'bullmq'
import { Octokit } from '@octokit/rest'
import { getRedisConnection } from '../lib/redis'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { executionQueue, EXECUTION_QUEUE_NAME } from '../lib/queue'
import { getExecutionService, resolveLanguageId, ExecutionResult } from '../services/execution'
import { getLlmService } from '../services/llm'
import { spliceLines } from '../services/gitops'
import {
  MAX_CONCURRENT_EXECUTIONS,
  MAX_EXECUTION_ATTEMPTS,
} from '../config/constants'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Job payload type
// ---------------------------------------------------------------------------

export interface ExecuteCodeJobData {
  skillRunId:   string
  workspaceId:  string
  languageId:   number
  /** Informational only — worker reads attemptCount from DB, not from this field. */
  attemptCount: number
}

// ---------------------------------------------------------------------------
// Zod schema — same shape as diagnoseBug output in bugfix.ts
// ---------------------------------------------------------------------------

const BugFixResponseSchema = z.object({
  filePath:     z.string(),
  startLine:    z.number().int().positive(),
  endLine:      z.number().int().positive(),
  originalCode: z.string(),
  proposedCode: z.string(),
  explanation:  z.string(),
})

type BugFixResponse = z.infer<typeof BugFixResponseSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOctokitForUser(userId: string): Promise<Octokit> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error(`User ${userId} not found`)
  return new Octokit({ auth: decrypt(user.githubToken) })
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref: string
): Promise<string> {
  const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref })
  if (Array.isArray(data) || !('content' in data)) {
    throw new Error(`"${filePath}" is not a file`)
  }
  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Try to fetch package.json scripts.test for Node/TypeScript projects.
 * Returns the test command string, or null if not found.
 * File path is fetched via Octokit — never opened from local disk.
 */
async function detectTestCommand(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<string | null> {
  try {
    const raw = await fetchFileContent(octokit, owner, repo, 'package.json', defaultBranch)
    const pkg = JSON.parse(raw)
    return (pkg?.scripts?.test as string) || null
  } catch {
    return null
  }
}

/**
 * Write a terminal executionResult to the SkillRun and set executionStatus = DONE.
 * Used both for successful/failed results and for cap-reached hard stops.
 */
async function writeTerminalResult(skillRunId: string, result: Partial<ExecutionResult> & {
  passed: boolean
  capReached?: boolean
  note?: string
  language?: string
}): Promise<void> {
  await withRetry(() =>
    prisma.skillRun.update({
      where: { id: skillRunId },
      data: {
        executionStatus: 'DONE',
        executionResult: {
          ...result,
          attemptedAt: new Date().toISOString(),
        },
      },
    })
  )
}

/**
 * Re-diagnose a failed fix using the LLM.
 * Returns the updated BugFixResponse, or null if the LLM call fails.
 */
async function reDiagnose(
  context: string,
  errorMessage: string,
  executionOutput: string
): Promise<BugFixResponse | null> {
  const llmService = getLlmService()

  const systemPrompt = `You are a senior debugging assistant. The proposed fix was executed but FAILED.
Analyze the execution output and the original error, then provide a corrected single-file fix.

Respond ONLY with valid JSON:
{
  "filePath": "path/to/file.ts",
  "startLine": 10,
  "endLine": 15,
  "originalCode": "the exact current code",
  "proposedCode": "your corrected fix",
  "explanation": "what was wrong with the previous fix and how this corrects it"
}`

  const prompt = `Original bug report:
${errorMessage}

Previous fix execution FAILED with this output:
${executionOutput}

Codebase context used previously:
${context}

Provide a corrected fix.`

  try {
    const rawJson = await llmService.generateStructuredAnswer(prompt, systemPrompt)
    const parsed = JSON.parse(rawJson)
    return BugFixResponseSchema.parse(parsed)
  } catch (err: any) {
    console.error('[execution-worker] Re-diagnosis LLM call failed:', err.message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Core worker function
// ---------------------------------------------------------------------------

async function processExecutionJob(job: Job<ExecuteCodeJobData>): Promise<void> {
  const { skillRunId, workspaceId, languageId } = job.data

  console.log(`[execution-worker] Processing job ${job.id} — skillRun: ${skillRunId}`)

  // ── Step 1: Fetch SkillRun from DB (authoritative source for attemptCount) ─
  const skillRun = await prisma.skillRun.findUnique({
    where: { id: skillRunId },
    include: {
      repository: {
        include: { workspace: { include: { user: true } } },
      },
    },
  }) as any

  if (!skillRun) {
    console.error(`[execution-worker] SkillRun ${skillRunId} not found — aborting`)
    return
  }

  // ── Step 2: Hard-stop if attempt cap already reached ────────────────────────
  // Read from DB, not from job.data.attemptCount, to be restart-safe.
  if (skillRun.attemptCount >= MAX_EXECUTION_ATTEMPTS) {
    console.warn(
      `[execution-worker] SkillRun ${skillRunId} has reached attempt cap ` +
        `(${skillRun.attemptCount}/${MAX_EXECUTION_ATTEMPTS}) — writing cap-reached result`
    )
    await writeTerminalResult(skillRunId, {
      passed: false,
      capReached: true,
      note: `Attempt cap (${MAX_EXECUTION_ATTEMPTS}) reached. No further re-diagnosis will be attempted.`,
      stdout: null,
      stderr: null,
      exitCode: null,
      status: 'Cap reached',
    })
    return
  }

  // ── Step 3: Increment attemptCount in DB BEFORE doing any work ──────────────
  // This ensures a crash or restart does not re-run an attempt that already counted.
  const updatedRun = await withRetry(() =>
    prisma.skillRun.update({
      where: { id: skillRunId },
      data: {
        attemptCount: { increment: 1 },
        executionStatus: 'RUNNING',
      },
    })
  )
  const currentAttempt = updatedRun.attemptCount

  console.log(
    `[execution-worker] SkillRun ${skillRunId} — attempt ${currentAttempt}/${MAX_EXECUTION_ATTEMPTS}`
  )

  // ── Step 4: Per-workspace concurrency check ──────────────────────────────────
  // Count only QUEUED or RUNNING rows — NOT "executionResult IS NULL" which would
  // incorrectly include NOT_STARTED rows.
  const concurrentCount = await prisma.skillRun.count({
    where: {
      workspaceId,
      executionStatus: { in: ['QUEUED', 'RUNNING'] },
    },
  })

  if (concurrentCount > MAX_CONCURRENT_EXECUTIONS) {
    console.warn(
      `[execution-worker] Workspace ${workspaceId} at concurrency limit ` +
        `(${concurrentCount}/${MAX_CONCURRENT_EXECUTIONS}) — re-queuing with delay`
    )
    await withRetry(() =>
      prisma.skillRun.update({
        where: { id: skillRunId },
        data: { executionStatus: 'QUEUED' },
      })
    )
    // Re-enqueue with a 10-second delay — pass the (already incremented) attemptCount
    await executionQueue.add(
      'execute_code',
      { skillRunId, workspaceId, languageId, attemptCount: currentAttempt },
      { delay: 10_000 }
    )
    return
  }

  // ── Step 5: Build in-memory patched file ────────────────────────────────────
  const diff = skillRun.proposedDiff as BugFixResponse
  const repository = skillRun.repository

  const octokit = await getOctokitForUser(repository.workspace.user.id)
  let patchedContent: string

  try {
    const currentContent = await fetchFileContent(
      octokit,
      repository.owner,
      repository.name,
      diff.filePath,
      repository.defaultBranch
    )
    // spliceLines is pure string manipulation — no disk writes, no git operations
    patchedContent = spliceLines(currentContent, diff.startLine, diff.endLine, diff.proposedCode)
  } catch (err: any) {
    console.error(`[execution-worker] Failed to build patched content:`, err.message)
    await writeTerminalResult(skillRunId, {
      passed: false,
      stdout: null,
      stderr: `Failed to fetch source file for execution: ${err.message}`,
      exitCode: null,
      status: 'Setup error',
    })
    return
  }

  // ── Step 6: Detect test command (Node/TypeScript only for now) ───────────────
  const testCommand = await detectTestCommand(
    octokit,
    repository.owner,
    repository.name,
    repository.defaultBranch
  )

  // For now: submit the patched file content as stdin-less source.
  // If a test script is detected, include it as a comment for audit trail only —
  // full test harness wiring is a future enhancement.
  let sourceToRun = patchedContent
  if (testCommand) {
    console.log(`[execution-worker] Test command detected: ${testCommand}`)
  }

  // ── Step 7: Submit to Judge0 ─────────────────────────────────────────────────
  const execService = getExecutionService()
  if (!execService) {
    console.warn('[execution-worker] Execution service not configured — writing skipped result')
    await writeTerminalResult(skillRunId, {
      passed: false,
      stdout: null,
      stderr: 'Execution sandbox not configured (JUDGE0_BASE_URL is not set).',
      exitCode: null,
      status: 'Not configured',
    })
    return
  }

  let execResult: ExecutionResult
  try {
    execResult = await execService.submit(
      { sourceCode: sourceToRun, languageId },
      workspaceId,
      skillRunId
    )
  } catch (err: any) {
    console.error(`[execution-worker] Judge0 submission/poll failed:`, err.message)
    await writeTerminalResult(skillRunId, {
      passed: false,
      stdout: null,
      stderr: `Execution infrastructure error: ${err.message}`,
      exitCode: null,
      status: 'Infrastructure error',
    })
    return
  }

  // ── Step 8: Handle result — re-diagnose or write terminal ────────────────────
  if (!execResult.passed && currentAttempt < MAX_EXECUTION_ATTEMPTS) {
    console.log(
      `[execution-worker] Execution FAILED on attempt ${currentAttempt}/${MAX_EXECUTION_ATTEMPTS}. ` +
        `Attempting re-diagnosis...`
    )

    const executionOutput = [
      execResult.stdout ? `stdout:\n${execResult.stdout}` : '',
      execResult.stderr ? `stderr:\n${execResult.stderr}` : '',
      `Status: ${execResult.status}`,
    ]
      .filter(Boolean)
      .join('\n\n')

    const newDiagnosis = await reDiagnose(
      '', // context was not persisted; LLM uses execution output
      skillRun.input,
      executionOutput
    )

    if (newDiagnosis) {
      // Update proposedDiff with corrected diagnosis and re-queue
      await withRetry(() =>
        prisma.skillRun.update({
          where: { id: skillRunId },
          data: {
            proposedDiff: newDiagnosis as any,
            executionStatus: 'QUEUED',
          },
        })
      )

      await executionQueue.add(
        'execute_code',
        { skillRunId, workspaceId, languageId, attemptCount: currentAttempt },
        {} // no delay on re-diagnosis re-queue
      )

      console.log(
        `[execution-worker] Re-queued SkillRun ${skillRunId} for attempt ` +
          `${currentAttempt + 1}/${MAX_EXECUTION_ATTEMPTS}`
      )
      return
    }

    // Re-diagnosis failed — fall through to write terminal result
    console.warn(
      `[execution-worker] Re-diagnosis failed. Writing terminal result for SkillRun ${skillRunId}.`
    )
  }

  // Write terminal result (passed=true, or cap/re-diagnosis exhausted)
  await writeTerminalResult(skillRunId, {
    ...execResult,
    language: String(languageId),
  })

  console.log(
    `[execution-worker] SkillRun ${skillRunId} complete — passed: ${execResult.passed}`
  )
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

const connection = getRedisConnection()

console.log(`[worker] Initializing execution worker for queue: ${EXECUTION_QUEUE_NAME}`)

export const executionWorker = new Worker(
  EXECUTION_QUEUE_NAME,
  async (job: Job<ExecuteCodeJobData>) => {
    console.log(`[execution-worker] Job ${job.id} received — skillRun: ${job.data?.skillRunId}`)
    await processExecutionJob(job)
  },
  {
    connection: connection as any,
    // Secondary enforcement: BullMQ won't run more than MAX_CONCURRENT_EXECUTIONS
    // jobs simultaneously from this worker process.
    concurrency: MAX_CONCURRENT_EXECUTIONS,
  }
)

executionWorker.on('failed', (job, err) => {
  console.error(`[execution-worker] Job failed ${job?.id}: ${err.message}`)
})

executionWorker.on('completed', (job) => {
  console.log(`[execution-worker] Job completed ${job.id}`)
})
