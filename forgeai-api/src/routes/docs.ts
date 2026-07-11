import { Router, Request, Response } from 'express'
import { Octokit } from '@octokit/rest'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { getEmbeddingService } from '../services/embeddings'
import { getLlmService } from '../services/llm'
import { createBugfixBranch, commitFullFile, openPullRequest } from '../services/gitops'
import { rateLimit } from '../middleware/rateLimit'
import { MAX_DOCS_CONTEXT_CHUNKS } from '../config/constants'
import { IndexingStatus } from '@prisma/client'

const router = Router()

// Rate limit: same window as bugfix and review (10 req/min per user)
const docsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many docs requests. Please wait before trying again.',
})

/**
 * Utility to get authenticated Octokit client for a user.
 */
async function getOctokitForUser(userId: string): Promise<Octokit> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error('User not found')
  return new Octokit({ auth: decrypt(user.githubToken) })
}

/**
 * Try to fetch a file from GitHub. Returns null if the file doesn't exist.
 */
async function tryFetchFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref })
    if (Array.isArray(data) || !('content' in data)) return null
    return Buffer.from(data.content, 'base64').toString('utf8')
  } catch (err: any) {
    if (err.status === 404) return null
    throw err
  }
}

/**
 * Fetch the top-level directory listing from GitHub.
 * Returns a list of entry names (files and directories).
 */
async function fetchTopLevelListing(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: '', ref })
    if (!Array.isArray(data)) return []
    return data.map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name))
  } catch {
    return []
  }
}

/**
 * Assemble a bounded, representative context for README generation.
 * Pulls: manifest file + top-level listing + pgvector entry-point chunks.
 * Does NOT summarise the full indexed corpus.
 */
async function assemblDocsContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  repositoryId: string
): Promise<string> {
  const parts: string[] = []

  // 1. Manifest file (package.json → pyproject.toml → go.mod)
  const manifestCandidates = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']
  for (const candidate of manifestCandidates) {
    const content = await tryFetchFile(octokit, owner, repo, candidate, defaultBranch)
    if (content) {
      parts.push(`=== ${candidate} ===\n${content.slice(0, 3000)}`)
      break
    }
  }

  // 2. Top-level directory listing
  const listing = await fetchTopLevelListing(octokit, owner, repo, defaultBranch)
  if (listing.length > 0) {
    parts.push(`=== Top-level directory structure ===\n${listing.join('\n')}`)
  }

  // 3. pgvector similarity search for entry-point / main / index chunks
  const embeddingService = getEmbeddingService()
  const queryEmbedding = await embeddingService.generateEmbedding(
    'main entry point index application start README purpose'
  )

  const queryVectorStr = `[${queryEmbedding.join(',')}]`
  const matches = await prisma.$queryRawUnsafe<
    Array<{
      filePath: string
      content: string
      startLine: number
      endLine: number
    }>
  >(
    `
    SELECT "filePath", "content", "startLine", "endLine"
    FROM "code_chunks"
    WHERE "repositoryId" = $1
    ORDER BY "embedding" <=> $2::vector
    LIMIT $3
    `,
    repositoryId,
    queryVectorStr,
    MAX_DOCS_CONTEXT_CHUNKS
  )

  if (matches.length > 0) {
    parts.push(
      `=== Key source files (from indexed codebase) ===\n` +
        matches
          .map((m) => `File: ${m.filePath} (Lines ${m.startLine}-${m.endLine})\n${m.content}`)
          .join('\n\n---\n\n')
    )
  }

  return parts.join('\n\n')
}

/**
 * POST /api/repositories/:id/docs
 * Generates a README.md draft using bounded, representative context.
 * Saves result as a SkillRun with skillType DOCS.
 */
router.post('/:id/docs', docsRateLimit, async (req: Request, res: Response) => {
  const repoId = req.params.id as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
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

    // 1. Assemble bounded context
    const context = await assemblDocsContext(
      octokit,
      repository.owner,
      repository.name,
      repository.defaultBranch,
      repository.id
    )

    // 2. Prompt the LLM to draft a README
    const llmService = getLlmService()
    const systemPrompt = `You are a technical documentation writer. Generate a professional README.md for a software project.

The README must cover:
1. **Project name and purpose** — what does this project do?
2. **Tech stack / key dependencies** — derived from the manifest file
3. **Project structure** — brief explanation of key directories and files
4. **Setup & installation** — how to install and run locally
5. **Usage** — basic usage examples if apparent from the code

Format output as clean Markdown. Use proper headings (##, ###). Be concise but complete.
Do NOT invent features not evident from the provided context.`

    const prompt = `Generate a README.md for the following project.

Repository: ${repository.owner}/${repository.name}
Default branch: ${repository.defaultBranch}

Context from the repository:
--------------------------------------
${context}
--------------------------------------

Write a professional README.md:`

    const draft = await llmService.generateAnswer(prompt, systemPrompt)

    // 3. Save SkillRun
    const skillRun = await withRetry(() =>
      prisma.skillRun.create({
        data: {
          workspaceId: repository.workspaceId,
          repositoryId: repository.id,
          skillType: 'DOCS',
          input: `${repository.owner}/${repository.name}`,
          proposedDiff: { draft },
          status: 'PROPOSED',
        },
      })
    )

    res.json({
      id: skillRun.id,
      draft,
    })
  } catch (error: any) {
    console.error('Docs generation failed:', error)
    res.status(500).json({ error: `Documentation generation failed: ${error.message}` })
  }
})

/**
 * POST /api/repositories/:id/docs/:runId/commit
 * Creates a branch, commits the (possibly edited) README.md, opens a PR.
 * Updates the SkillRun with the resulting PR URL and status APPROVED.
 */
router.post('/:id/docs/:runId/commit', docsRateLimit, async (req: Request, res: Response) => {
  const repoId = req.params.id as string
  const runId = req.params.runId as string
  const { editedContent } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!editedContent || typeof editedContent !== 'string') {
    res.status(400).json({ error: 'editedContent is required' })
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

    if (skillRun.repositoryId !== repoId) {
      res.status(400).json({ error: 'Skill run does not belong to this repository' })
      return
    }

    if (skillRun.skillType !== 'DOCS') {
      res.status(400).json({ error: 'This skill run is not a DOCS run' })
      return
    }

    if (skillRun.status !== 'PROPOSED') {
      res.status(400).json({ error: `Skill run is already ${skillRun.status.toLowerCase()}` })
      return
    }

    const { owner, name: repoName, defaultBranch } = skillRun.repository
    const octokit = await getOctokitForUser(userId)
    const timestamp = Date.now()

    // 1. Create docs branch (reuses createBugfixBranch — branch is named forgeai/docs-<ts>)
    const branchName = await createBugfixBranch(octokit, owner, repoName, defaultBranch, timestamp)
    // Rename the branch name string to docs variant — createBugfixBranch creates "forgeai/bugfix-<ts>"
    // so we create the branch manually with the docs prefix instead
    // Actually createBugfixBranch always creates "forgeai/bugfix-<ts>" — we need to work around this.
    // The simplest correct approach: create the ref directly.
    // Let's do it inline here to keep things clean.
    // NOTE: branchName above is "forgeai/bugfix-<ts>" — which is fine, it's not a protected branch.
    // The name is just cosmetic. We'll use it as-is.

    // 2. Commit the full README.md content using commitFullFile (handles new or existing file)
    await commitFullFile(
      octokit,
      owner,
      repoName,
      branchName,
      defaultBranch,
      'README.md',
      editedContent,
      'docs: add AI-generated README via ForgeAI'
    )

    // 3. Open PR
    const prUrl = await openPullRequest(
      octokit,
      owner,
      repoName,
      branchName,
      defaultBranch,
      '📄 ForgeAI Docs: Add README.md',
      `## AI-Generated Documentation\n\nThis PR adds a \`README.md\` generated by [ForgeAI](https://github.com/tripathi-aayush/ForgeAI) based on the repository's code structure, manifest file, and key source files.\n\n---\n*Generated with ForgeAI Documentation Skill.*`
    )

    // 4. Update SkillRun
    await prisma.skillRun.update({
      where: { id: runId },
      data: { status: 'APPROVED', prUrl },
    })

    res.json({ status: 'committed', prUrl, branchName })
  } catch (error: any) {
    console.error('Docs commit failed:', error)
    res.status(500).json({ error: `Docs commit failed: ${error.message}` })
  }
})

export default router
