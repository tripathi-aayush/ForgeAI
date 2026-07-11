import { Router, Request, Response } from 'express'
import { Octokit } from '@octokit/rest'
import { z } from 'zod'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { getEmbeddingService } from '../services/embeddings'
import { getLlmService } from '../services/llm'
import { createBugfixBranch, commitFix, openPullRequest } from '../services/gitops'
import { rateLimit } from '../middleware/rateLimit'
import { MAX_BUGFIX_CONTEXT_CHUNKS } from '../config/constants'
import { IndexingStatus } from '@prisma/client'
import { getExecutionService, resolveLanguageId } from '../services/execution'
import { executionQueue } from '../lib/queue'

const router = Router()

// Rate limit: 10 requests per minute per user
const bugfixRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many bugfix requests. Please wait before trying again.',
})

/**
 * Zod schema for validating LLM structured output.
 * This is the second validation layer on top of native JSON mode.
 */
const BugFixResponseSchema = z.object({
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  originalCode: z.string(),
  proposedCode: z.string(),
  explanation: z.string(),
})

type BugFixResponse = z.infer<typeof BugFixResponseSchema>

/**
 * Utility to get authenticated Octokit client.
 */
async function getOctokitForUser(userId: string): Promise<Octokit> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })

  if (!user) {
    throw new Error('User not found')
  }

  const decryptedToken = decrypt(user.githubToken)
  return new Octokit({ auth: decryptedToken })
}

/**
 * Fetch file content from GitHub via Octokit.
 */
async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref: string
): Promise<string> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref,
  })

  if (Array.isArray(data) || !('content' in data)) {
    throw new Error(`"${filePath}" is not a valid file`)
  }

  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Extract lines from file content (1-indexed, inclusive range).
 */
function extractLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n')
  return lines.slice(startLine - 1, endLine).join('\n')
}

/**
 * Attempt to diagnose a bug by calling the LLM with structured JSON output.
 */
async function diagnoseBug(
  context: string,
  errorMessage: string,
  correctionContext?: string
): Promise<BugFixResponse> {
  const llmService = getLlmService()

  const systemPrompt = `You are a senior debugging assistant for a codebase. Given error context and relevant code, identify the root cause and propose a SINGLE-FILE fix.

Respond ONLY with valid JSON matching this exact schema:
{
  "filePath": "path/to/file.ts",
  "startLine": 10,
  "endLine": 15,
  "originalCode": "the exact current code at those lines",
  "proposedCode": "your fixed replacement code",
  "explanation": "brief explanation of the root cause and fix"
}

Rules:
- SINGLE FILE ONLY. Do not reference multiple files in your fix.
- startLine and endLine must be valid 1-indexed line numbers.
- originalCode must exactly match the current code at those lines.
- proposedCode replaces originalCode entirely.
- Keep fixes minimal and targeted.`

  let prompt = `Error / Bug Report:
--------------------------------------
${errorMessage}
--------------------------------------

Retrieved Code Context:
--------------------------------------
${context}
--------------------------------------`

  if (correctionContext) {
    prompt += `

CORRECTION: The original code you referenced did not match the actual file content.
Here is the actual current file content. Please re-analyze and provide a corrected fix:
--------------------------------------
${correctionContext}
--------------------------------------`
  }

  // Use native JSON mode (Gemini: responseMimeType, Groq/OpenAI: response_format)
  // with Zod as the second validation layer
  const rawJson = await llmService.generateStructuredAnswer(prompt, systemPrompt)
  const parsed = JSON.parse(rawJson)
  return BugFixResponseSchema.parse(parsed)
}

/**
 * POST /api/repositories/:id/bugfix
 * RAG-powered bug diagnosis and fix proposal.
 */
router.post('/:id/bugfix', bugfixRateLimit, async (req: Request, res: Response) => {
  const id = req.params.id as string
  const { errorMessage } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!errorMessage) {
    res.status(400).json({ error: 'Missing errorMessage' })
    return
  }

  try {
    const repository = await prisma.repository.findUnique({
      where: { id: id as string },
      include: { workspace: true },
    }) as any

    if (!repository || repository.workspace.userId !== userId) {
      res.status(404).json({ error: 'Repository not found' })
      return
    }

    if (repository.indexingStatus !== IndexingStatus.COMPLETED) {
      res.status(400).json({
        error: `Repository is not fully indexed. Current status: ${repository.indexingStatus}`,
      })
      return
    }

    // 1. Generate query embedding from the error message
    const embeddingService = getEmbeddingService()
    const queryEmbedding = await embeddingService.generateEmbedding(errorMessage)

    // 2. Perform pgvector cosine similarity search
    const queryVectorStr = `[${queryEmbedding.join(',')}]`
    const matches = await prisma.$queryRawUnsafe<
      Array<{
        filePath: string
        content: string
        startLine: number
        endLine: number
        similarity: number
      }>
    >(
      `
      SELECT "filePath", "content", "startLine", "endLine",
             1 - ("embedding" <=> $1::vector) as "similarity"
      FROM "code_chunks"
      WHERE "repositoryId" = $2
      ORDER BY "embedding" <=> $1::vector
      LIMIT $3
      `,
      queryVectorStr,
      repository.id,
      MAX_BUGFIX_CONTEXT_CHUNKS
    )

    // 3. Build context for LLM
    const context = matches
      .map(
        (match) =>
          `File: ${match.filePath} (Lines ${match.startLine}-${match.endLine})\n\n${match.content}`
      )
      .join('\n\n---\n\n')

    // 4. Call LLM for diagnosis
    let diagnosis: BugFixResponse
    let confidence: 'verified' | 'low' = 'verified'

    try {
      diagnosis = await diagnoseBug(context, errorMessage)
    } catch (err: any) {
      console.error('LLM diagnosis failed (parse/validation):', err.message)
      res.status(422).json({
        error: 'Failed to parse LLM response as a valid bug fix proposal',
        details: err.message,
      })
      return
    }

    // 5. Diff validation — fetch actual file and compare
    const octokit = await getOctokitForUser(userId)
    let actualContent: string

    try {
      actualContent = await fetchFileContent(
        octokit,
        repository.owner,
        repository.name,
        diagnosis.filePath,
        repository.defaultBranch
      )
    } catch (err: any) {
      console.error('Failed to fetch file for diff validation:', err.message)
      res.status(422).json({
        error: `Could not fetch "${diagnosis.filePath}" from GitHub to verify the proposed fix`,
        details: err.message,
      })
      return
    }

    const actualLines = extractLines(actualContent, diagnosis.startLine, diagnosis.endLine)
    const normalizedActual = actualLines.trim()
    const normalizedOriginal = diagnosis.originalCode.trim()

    if (normalizedActual !== normalizedOriginal) {
      // Retry once with the real file content
      console.warn('Diff mismatch — retrying with actual file content')
      try {
        diagnosis = await diagnoseBug(context, errorMessage, actualContent)

        // Re-check after retry
        const retryActualLines = extractLines(actualContent, diagnosis.startLine, diagnosis.endLine)
        if (retryActualLines.trim() !== diagnosis.originalCode.trim()) {
          confidence = 'low'
        }
      } catch (retryErr: any) {
        console.error('LLM retry diagnosis failed:', retryErr.message)
        confidence = 'low'
      }
    }

    // 6. Save SkillRun
    const skillRun = await withRetry(() =>
      prisma.skillRun.create({
        data: {
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
          input: errorMessage,
          proposedDiff: {
            filePath: diagnosis.filePath,
            startLine: diagnosis.startLine,
            endLine: diagnosis.endLine,
            originalCode: diagnosis.originalCode,
            proposedCode: diagnosis.proposedCode,
            explanation: diagnosis.explanation,
          },
          status: 'PROPOSED',
        },
      })
    )

    // 7. Return response
    res.json({
      id: skillRun.id,
      confidence,
      diagnosis: {
        filePath: diagnosis.filePath,
        startLine: diagnosis.startLine,
        endLine: diagnosis.endLine,
        originalCode: diagnosis.originalCode,
        proposedCode: diagnosis.proposedCode,
        explanation: diagnosis.explanation,
      },
    })
  } catch (error: any) {
    console.error('Bugfix diagnosis failed:', error)
    res.status(500).json({ error: `Bug fix analysis failed: ${error.message}` })
  }
})

/**
 * POST /api/repositories/:id/bugfix/:runId/approve
 * Approves a proposed fix, creates a branch, commits the fix, and opens a PR.
 * Optionally accepts { editedCode } for user-modified proposals.
 */
router.post('/:id/bugfix/:runId/approve', bugfixRateLimit, async (req: Request, res: Response) => {
  const id = req.params.id as string
  const runId = req.params.runId as string
  const { editedCode } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const skillRun = await prisma.skillRun.findUnique({
      where: { id: runId },
      include: {
        repository: { include: { workspace: true } },
      },
    }) as any

    if (!skillRun || skillRun.repository.workspace.userId !== userId) {
      res.status(404).json({ error: 'Skill run not found' })
      return
    }

    if (skillRun.repositoryId !== id) {
      res.status(400).json({ error: 'Skill run does not belong to this repository' })
      return
    }

    if (skillRun.status !== 'PROPOSED') {
      res.status(400).json({ error: `Skill run is already ${skillRun.status.toLowerCase()}` })
      return
    }

    const diff = skillRun.proposedDiff as BugFixResponse
    const octokit = await getOctokitForUser(userId)
    const { owner, name: repoName, defaultBranch } = skillRun.repository

    // 1. Create bugfix branch
    const timestamp = Date.now()
    const branchName = await createBugfixBranch(octokit, owner, repoName, defaultBranch, timestamp)

    // 2. Commit the fix (splicing into the full file, not overwriting)
    const codeToCommit = editedCode || diff.proposedCode
    await commitFix(
      octokit,
      owner,
      repoName,
      branchName,
      defaultBranch,
      diff.filePath,
      diff.startLine,
      diff.endLine,
      codeToCommit,
      `fix: ${diff.explanation.slice(0, 72)}`
    )

    // 3. Open PR
    const prUrl = await openPullRequest(
      octokit,
      owner,
      repoName,
      branchName,
      defaultBranch,
      `🔧 ForgeAI Bug Fix: ${diff.explanation.slice(0, 60)}`,
      `## Bug Fix Proposal\n\n**File:** \`${diff.filePath}\` (Lines ${diff.startLine}–${diff.endLine})\n\n**Explanation:** ${diff.explanation}\n\n---\n*This PR was generated by [ForgeAI](https://github.com/forgeai).*`
    )

    // 4. Update SkillRun
    await prisma.skillRun.update({
      where: { id: runId },
      data: {
        status: 'APPROVED',
        prUrl,
      },
    })

    res.json({ status: 'approved', prUrl, branchName })
  } catch (error: any) {
    console.error('Bugfix approval failed:', error)
    res.status(500).json({ error: `Approval failed: ${error.message}` })
  }
})

/**
 * POST /api/repositories/:id/bugfix/:runId/reject
 * Rejects a proposed fix.
 */
router.post('/:id/bugfix/:runId/reject', async (req: Request, res: Response) => {
  const id = req.params.id as string
  const runId = req.params.runId as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const skillRun = await prisma.skillRun.findUnique({
      where: { id: runId },
      include: {
        repository: { include: { workspace: true } },
      },
    }) as any

    if (!skillRun || skillRun.repository.workspace.userId !== userId) {
      res.status(404).json({ error: 'Skill run not found' })
      return
    }

    if (skillRun.repositoryId !== id) {
      res.status(400).json({ error: 'Skill run does not belong to this repository' })
      return
    }

    if (skillRun.status !== 'PROPOSED') {
      res.status(400).json({ error: `Skill run is already ${skillRun.status.toLowerCase()}` })
      return
    }

    await prisma.skillRun.update({
      where: { id: runId },
      data: { status: 'REJECTED' },
    })

    res.json({ status: 'rejected' })
  } catch (error: any) {
    console.error('Bugfix rejection failed:', error)
    res.status(500).json({ error: `Rejection failed: ${error.message}` })
  }
})

/**
 * POST /api/repositories/:id/bugfix/:runId/execute
 * Triggers async execution of the en-memory patched file.
 * Submits execution request to BullMQ execution queue.
 */
router.post('/:id/bugfix/:runId/execute', bugfixRateLimit, async (req: Request, res: Response) => {
  const id = req.params.id as string
  const runId = req.params.runId as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const skillRun = await prisma.skillRun.findUnique({
      where: { id: runId },
      include: {
        repository: { include: { workspace: true } },
      },
    }) as any

    if (!skillRun || skillRun.repository.workspace.userId !== userId) {
      res.status(404).json({ error: 'Skill run not found' })
      return
    }

    if (skillRun.repositoryId !== id) {
      res.status(400).json({ error: 'Skill run does not belong to this repository' })
      return
    }

    if (skillRun.status !== 'PROPOSED') {
      res.status(400).json({ error: `Execution is only allowed for proposed fixes. Current status: ${skillRun.status}` })
      return
    }

    if (skillRun.executionStatus !== 'NOT_STARTED') {
      res.status(400).json({ error: `Execution is already in state: ${skillRun.executionStatus}` })
      return
    }

    // Detect language from file path
    const diff = skillRun.proposedDiff as { filePath?: string }
    if (!diff || !diff.filePath) {
      res.status(400).json({ error: 'No proposed diff / file path associated with this skill run' })
      return
    }

    const languageId = resolveLanguageId(diff.filePath)
    if (!languageId) {
      res.status(400).json({ error: `Unsupported file extension for code execution: ${diff.filePath}` })
      return
    }

    // Check if execution service is configured
    const execService = getExecutionService()
    if (!execService) {
      // Mark as DONE with skipped result
      await prisma.skillRun.update({
        where: { id: runId },
        data: {
          executionStatus: 'DONE',
          executionResult: {
            passed: false,
            stdout: null,
            stderr: 'Execution sandbox not configured on the server. Configure JUDGE0_BASE_URL.',
            exitCode: null,
            status: 'Skipped',
            attemptedAt: new Date().toISOString(),
          },
        },
      })
      res.json({ status: 'skipped', reason: 'Execution sandbox not configured' })
      return
    }

    // Update state to QUEUED in DB before enqueuing
    await prisma.skillRun.update({
      where: { id: runId },
      data: { executionStatus: 'QUEUED' },
    })

    // Enqueue BullMQ job
    const job = await executionQueue.add('execute_code', {
      skillRunId: runId,
      workspaceId: skillRun.workspaceId,
      languageId,
      attemptCount: 0,
    })

    res.json({ status: 'queued', jobId: job.id })
  } catch (error: any) {
    console.error('Trigger execution failed:', error)
    res.status(500).json({ error: `Trigger execution failed: ${error.message}` })
  }
})

/**
 * GET /api/repositories/:id/bugfix/:runId/execution-status
 * Poll endpoint to check execution status.
 */
router.get('/:id/bugfix/:runId/execution-status', async (req: Request, res: Response) => {
  const id = req.params.id as string
  const runId = req.params.runId as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const skillRun = await prisma.skillRun.findUnique({
      where: { id: runId },
      include: {
        repository: { include: { workspace: true } },
      },
    }) as any

    if (!skillRun || skillRun.repository.workspace.userId !== userId) {
      res.status(404).json({ error: 'Skill run not found' })
      return
    }

    if (skillRun.repositoryId !== id) {
      res.status(400).json({ error: 'Skill run does not belong to this repository' })
      return
    }

    res.json({
      executionStatus: skillRun.executionStatus,
      executionResult: skillRun.executionResult,
      attemptCount: skillRun.attemptCount,
      proposedDiff: skillRun.proposedDiff,
    })
  } catch (error: any) {
    console.error('Fetch execution status failed:', error)
    res.status(500).json({ error: `Fetch execution status failed: ${error.message}` })
  }
})

export default router
