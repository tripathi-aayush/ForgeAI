import { Router, Request, Response } from 'express'
import { Octokit } from '@octokit/rest'
import { z } from 'zod'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { getEmbeddingService } from '../services/embeddings'
import { getLlmService } from '../services/llm'
import { rateLimit } from '../middleware/rateLimit'
import { MAX_REVIEW_CONTEXT_CHUNKS } from '../config/constants'
import { IndexingStatus } from '@prisma/client'

const router = Router()

// Rate limit: same window as bugfix (10 req/min per user)
const reviewRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many review requests. Please wait before trying again.',
})

/**
 * Zod schema for a single review comment.
 * Used as the second validation layer on top of Gemini native JSON mode.
 */
const ReviewCommentSchema = z.object({
  filePath: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'critical']),
  comment: z.string(),
})

const ReviewResponseSchema = z.array(ReviewCommentSchema)

type ReviewComment = z.infer<typeof ReviewCommentSchema>

/**
 * Utility to get authenticated Octokit client for a user.
 */
async function getOctokitForUser(userId: string): Promise<Octokit> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('User not found')
  return new Octokit({ auth: decrypt(user.githubToken) })
}

/**
 * Fetch a GitHub PR diff via Octokit using the raw diff media type.
 * Parses owner/repo/number from the PR URL.
 */
async function fetchPrDiff(octokit: Octokit, prUrl: string): Promise<string> {
  // Match: https://github.com/{owner}/{repo}/pull/{number}
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!match) {
    throw new Error('Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123')
  }

  const [, owner, repo, pullNumber] = match

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: parseInt(pullNumber, 10),
    mediaType: { format: 'diff' },
  })

  // Octokit returns the diff as a string when using the diff media type
  return data as unknown as string
}

/**
 * Call the LLM to generate structured review comments for a diff.
 * Uses Gemini native JSON mode + Zod as the second validation layer.
 * Guardrail: if the LLM returns a non-array object, retries once with a stricter prompt.
 */
async function generateReviewComments(
  diff: string,
  context: string,
  isRetry = false
): Promise<ReviewComment[]> {
  const llmService = getLlmService()

  const systemPrompt = isRetry
    ? `You are a senior code reviewer. You MUST respond with a JSON array (not an object) of review comments.
Your entire response must be a valid JSON array starting with "[" and ending with "]".
Each element must have exactly these fields: filePath (string), line (number), severity ("info"|"warning"|"critical"), comment (string).
Do not wrap the array in an object. Do not add extra fields.`
    : `You are a senior code reviewer. Review the provided diff and return structured feedback.

Respond ONLY with a valid JSON array (starting with "[", ending with "]") of review comments.
Each element must follow this exact schema:
{
  "filePath": "path/to/file.ts",
  "line": 42,
  "severity": "info" | "warning" | "critical",
  "comment": "Explanation of the issue or suggestion"
}

Rules:
- severity "critical" = bugs, security issues, data loss risk
- severity "warning" = performance, maintainability, missing error handling
- severity "info" = style suggestions, minor improvements
- Focus on the changed lines (+) in the diff
- filePath must match file paths seen in the diff header
- Return an empty array [] if there are no comments
- Do NOT wrap the array in an object`

  const prompt = `${isRetry ? 'RETRY — return ONLY a JSON array, not an object.\n\n' : ''}Code Diff to Review:
--------------------------------------
${diff}
--------------------------------------

Relevant Codebase Context (conventions and surrounding code):
--------------------------------------
${context}
--------------------------------------`

  const rawJson = await llmService.generateStructuredAnswer(prompt, systemPrompt)
  const parsed = JSON.parse(rawJson)

  // Guardrail: reject non-array responses and retry once
  if (!Array.isArray(parsed)) {
    if (!isRetry) {
      console.warn('Review LLM returned a non-array object — retrying with stricter prompt')
      return generateReviewComments(diff, context, true)
    }
    throw new Error('LLM returned a non-array object even after retry. Cannot produce review comments.')
  }

  return ReviewResponseSchema.parse(parsed)
}

/**
 * POST /api/repositories/:id/review
 * AI-powered code review for a diff or PR URL.
 * Saves the result as a SkillRun with skillType REVIEW.
 */
router.post('/:id/review', reviewRateLimit, async (req: Request, res: Response) => {
  const repoId = req.params.id as string
  const { diff, prUrl } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!diff && !prUrl) {
    res.status(400).json({ error: 'Provide either a diff string or a prUrl' })
    return
  }

  try {
    const repository = await prisma.repository.findUnique({
      where: { id: repoId },
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

    const octokit = await getOctokitForUser(userId)

    // 1. Resolve diff text
    let diffText: string
    if (prUrl) {
      try {
        diffText = await fetchPrDiff(octokit, prUrl)
      } catch (err: any) {
        res.status(422).json({ error: `Failed to fetch PR diff: ${err.message}` })
        return
      }
    } else {
      diffText = diff
    }

    if (!diffText || diffText.trim().length === 0) {
      res.status(400).json({ error: 'Diff is empty — nothing to review' })
      return
    }

    // 2. RAG retrieval — embed the diff text and find relevant context
    const embeddingService = getEmbeddingService()
    const queryEmbedding = await embeddingService.generateEmbedding(
      // Use first ~2000 chars of the diff for embedding (avoid huge inputs)
      diffText.slice(0, 2000)
    )

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
      MAX_REVIEW_CONTEXT_CHUNKS
    )

    const context = matches
      .map(
        (m) => `File: ${m.filePath} (Lines ${m.startLine}-${m.endLine})\n\n${m.content}`
      )
      .join('\n\n---\n\n')

    // 3. Generate review comments via LLM
    let comments: ReviewComment[]
    try {
      comments = await generateReviewComments(diffText, context)
    } catch (err: any) {
      console.error('Review LLM failed:', err.message)
      res.status(422).json({
        error: 'Failed to generate review comments',
        details: err.message,
      })
      return
    }

    // 4. Save SkillRun
    const skillRun = await withRetry(() =>
      prisma.skillRun.create({
        data: {
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
          skillType: 'REVIEW',
          input: prUrl || diffText.slice(0, 500),
          proposedDiff: { comments },
          status: 'PROPOSED',
        },
      })
    )

    // 5. Return result
    res.json({
      id: skillRun.id,
      comments,
      commentCount: comments.length,
    })
  } catch (error: any) {
    console.error('Review skill failed:', error)
    res.status(500).json({ error: `Review failed: ${error.message}` })
  }
})

export default router
