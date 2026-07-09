import { Router, Request, Response } from 'express'
import { Octokit } from '@octokit/rest'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { indexingQueue } from '../lib/queue'
import { getEmbeddingService } from '../services/embeddings'
import { getLlmService } from '../services/llm'
import { IndexingStatus } from '@prisma/client'

const router = Router()

/**
 * Utility to parse owner and repository name from various GitHub URL formats.
 */
function parseGitHubUrl(urlStr: string): { owner: string; repo: string } | null {
  try {
    let cleanUrl = urlStr.trim()
    if (cleanUrl.endsWith('.git')) {
      cleanUrl = cleanUrl.slice(0, -4)
    }
    
    // Support formats:
    // 1. https://github.com/owner/repo
    // 2. git@github.com:owner/repo
    // 3. owner/repo
    if (cleanUrl.includes('github.com/')) {
      const parts = cleanUrl.split('github.com/')[1].split('/')
      if (parts.length >= 2) {
        return { owner: parts[0], repo: parts[1] }
      }
    } else if (cleanUrl.includes('github.com:')) {
      const parts = cleanUrl.split('github.com:')[1].split('/')
      if (parts.length >= 2) {
        return { owner: parts[0], repo: parts[1] }
      }
    } else {
      const parts = cleanUrl.split('/')
      if (parts.length === 2) {
        return { owner: parts[0], repo: parts[1] }
      }
    }
  } catch (e) {
    // Ignore error
  }
  return null
}

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
 * POST /api/repositories/import
 * Imports and queues a repository for indexing.
 */
router.post('/import', async (req: Request, res: Response) => {
  const { githubUrl, workspaceId } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!githubUrl || !workspaceId) {
    res.status(400).json({ error: 'Missing githubUrl or workspaceId' })
    return
  }

  const parsed = parseGitHubUrl(githubUrl)
  if (!parsed) {
    res.status(400).json({ error: 'Invalid GitHub URL format' })
    return
  }

  const { owner, repo: repoName } = parsed

  try {
    // Verify user owns the workspace
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    })

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found or unauthorized' })
      return
    }

    // Retrieve default branch via Octokit to verify repo accessibility
    const octokit = await getOctokitForUser(userId)
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo: repoName,
    })

    const defaultBranch = repoData.default_branch || 'main'
    const fullGitHubUrl = repoData.clone_url || `https://github.com/${owner}/${repoName}.git`

    // Create or find repository
    const repository = await withRetry(() =>
      prisma.repository.upsert({
        where: {
          workspaceId_githubUrl: {
            workspaceId,
            githubUrl: fullGitHubUrl,
          },
        },
        update: {
          indexingStatus: IndexingStatus.PENDING,
        },
        create: {
          workspaceId,
          name: repoName,
          owner,
          githubUrl: fullGitHubUrl,
          defaultBranch,
          indexingStatus: IndexingStatus.PENDING,
        },
      })
    )

    // Trigger BullMQ indexing job
    await indexingQueue.add('index_repository', {
      repositoryId: repository.id,
      userId,
    })

    res.json(repository)
  } catch (error: any) {
    console.error('Failed to import repository:', error)
    res.status(500).json({
      error: error.status === 404
        ? 'Repository not found or private. Make sure you have authorized access.'
        : `Import failed: ${error.message}`,
    })
  }
})

/**
 * GET /api/repositories/:id/status
 * Check the indexing status of a repository.
 */
router.get('/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
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

    res.json({
      id: repository.id,
      name: repository.name,
      owner: repository.owner,
      githubUrl: repository.githubUrl,
      indexingStatus: repository.indexingStatus,
      lastIndexedAt: repository.lastIndexedAt,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/repositories/:id/files
 * Fetch recursive Git file tree directly from GitHub API.
 */
router.get('/:id/files', async (req: Request, res: Response) => {
  const { id } = req.params
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
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

    const octokit = await getOctokitForUser(userId)
    const { data } = await octokit.git.getTree({
      owner: repository.owner,
      repo: repository.name,
      tree_sha: repository.defaultBranch,
      recursive: 'true',
    })

    // Filter to only include files (blobs)
    const files = data.tree
      .filter((node) => node.type === 'blob')
      .map((node) => ({
        path: node.path || '',
        sha: node.sha || '',
        size: node.size || 0,
      }))

    res.json(files)
  } catch (error: any) {
    console.error('Failed to fetch file tree:', error)
    res.status(500).json({ error: `Failed to fetch file tree: ${error.message}` })
  }
})

/**
 * GET /api/repositories/:id/files/content
 * Fetch file content directly from GitHub API.
 */
router.get('/:id/files/content', async (req: Request, res: Response) => {
  const { id } = req.params
  const filePath = req.query.path as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!filePath) {
    res.status(400).json({ error: 'Missing path query parameter' })
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

    const octokit = await getOctokitForUser(userId)
    const { data } = await octokit.repos.getContent({
      owner: repository.owner,
      repo: repository.name,
      path: filePath,
      ref: repository.defaultBranch,
    })

    if (Array.isArray(data) || !('content' in data)) {
      res.status(400).json({ error: 'Invalid file path' })
      return
    }

    // Decode base64 content from GitHub API
    const content = Buffer.from(data.content, 'base64').toString('utf8')
    res.json({ content })
  } catch (error: any) {
    console.error('Failed to fetch file content:', error)
    res.status(500).json({ error: `Failed to fetch file content: ${error.message}` })
  }
})

/**
 * POST /api/repositories/:id/ask
 * RAG-powered Q&A endpoint.
 */
router.post('/:id/ask', async (req: Request, res: Response) => {
  const { id } = req.params
  const { question } = req.body
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!question) {
    res.status(400).json({ error: 'Missing question' })
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

    // 1. Generate query embedding
    const embeddingService = getEmbeddingService()
    const queryEmbedding = await embeddingService.generateEmbedding(question)

    // 2. Perform Cosine Similarity vector search via pgvector
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
      LIMIT 6
      `,
      queryVectorStr,
      repository.id
    )

    // 3. Compile context for LLM
    const context = matches
      .map(
        (match) =>
          `File: ${match.filePath} (Lines ${match.startLine}-${match.endLine})\n\n${match.content}`
      )
      .join('\n\n---\n\n')

    // 4. Invoke LLM Service
    const systemPrompt = `You are ForgeAI, a helpful, context-aware coding assistant.
Your goal is to answer the user's questions about their codebase using the retrieved code context.
Be direct, technically precise, and concise. Format your answers in GitHub Markdown.
Refer to specific files and line numbers where appropriate.
If the retrieved context does not contain enough information to answer the question, state that clearly.`

    const prompt = `Retrieved Code Context:
--------------------------------------
${context}
--------------------------------------

User Query:
${question}

Answer:`

    const llmService = getLlmService()
    const answer = await llmService.generateAnswer(prompt, systemPrompt)

    res.json({
      answer,
      citations: matches.map((match) => ({
        filePath: match.filePath,
        startLine: match.startLine,
        endLine: match.endLine,
      })),
    })
  } catch (error: any) {
    console.error('RAG query failed:', error)
    res.status(500).json({ error: `Query execution failed: ${error.message}` })
  }
})

export default router
