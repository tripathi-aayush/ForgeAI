import { Worker, Job } from 'bullmq'
import simpleGit from 'simple-git'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getRedisConnection } from '../lib/redis'
import { prisma, withRetry } from '../lib/prisma'
import { decrypt } from '../lib/crypto'
import { getEmbeddingService } from '../services/embeddings'
import { INDEX_QUEUE_NAME } from '../lib/queue'
import { IndexingStatus } from '@prisma/client'
import { MAX_INDEX_FILES, MAX_FILE_SIZE_KB } from '../config/constants'
import { env } from '../config/env'

// Indexing payload type
interface IndexingJobData {
  repositoryId: string
  userId: string
}

// Chunker interface
interface CodeChunkInput {
  id: string
  repositoryId: string
  filePath: string
  content: string
  startLine: number
  endLine: number
}

// Generate CUID-like local IDs for raw inserts
function generateLocalId() {
  return crypto.randomUUID()
}

/**
 * Line-based chunking strategy for code.
 * Chunks files into 50-line blocks with a 10-line overlap.
 */
function chunkFile(filePath: string, content: string, repositoryId: string): CodeChunkInput[] {
  const lines = content.split('\n')
  const chunks: CodeChunkInput[] = []
  
  const chunkSize = 50
  const overlap = 10
  
  let i = 0
  while (i < lines.length) {
    const startLine = i + 1
    const endLine = Math.min(i + chunkSize, lines.length)
    const chunkLines = lines.slice(i, endLine)
    const chunkContent = chunkLines.join('\n')
    
    // Skip empty chunks
    if (chunkContent.trim().length > 0) {
      chunks.push({
        id: `chunk_${generateLocalId()}`,
        repositoryId,
        filePath,
        content: chunkContent,
        startLine,
        endLine,
      })
    }
    
    if (endLine === lines.length) {
      break
    }
    
    i += chunkSize - overlap
  }
  
  return chunks
}

/**
 * Check if a file is binary by searching for null bytes.
 */
function isBinaryFile(content: string): boolean {
  return content.includes('\0')
}

/**
 * Traverses directories recursively to find valid source files.
 */
export function getIndexableFiles(
  dir: string,
  baseDir: string,
  fileList: string[] = []
): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err: any) {
    console.warn(`⚠️ Skipped traversing directory "${dir}" due to read error: ${err.message}`)
    return fileList
  }
  
  // List of directories and files to ignore (supports partial matches and exact matches)
  const ignoredPatterns = [
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'out',
    'target',
    'vendor',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    '.DS_Store',
    '__pycache__',
  ]

  for (const entry of entries) {
    try {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(baseDir, fullPath)
      const fileName = entry.name.toLowerCase()
      
      // Check if path contains ignored patterns
      if (
        ignoredPatterns.some((pattern) => {
          const parts = relativePath.split(path.sep)
          return parts.some((p) => p === pattern || p.includes(pattern))
        })
      ) {
        continue
      }

      // Skip specific compiled/secret/env extensions or patterns
      if (
        fileName.endsWith('.pyc') ||
        fileName.includes('.cpython-') ||
        fileName.startsWith('.env') ||
        ['.pem', '.key', '.p12', '.pfx', '.cert', '.crt'].includes(path.extname(fileName))
      ) {
        continue
      }

      if (entry.isDirectory()) {
        getIndexableFiles(fullPath, baseDir, fileList)
      } else if (entry.isFile()) {
        // Validate file size safely
        let stats: fs.Stats
        try {
          stats = fs.statSync(fullPath)
        } catch (statErr: any) {
          console.warn(`⚠️ Skipped file size check for "${fullPath}": ${statErr.message}`)
          continue
        }

        const fileSizeKB = stats.size / 1024
        if (fileSizeKB > MAX_FILE_SIZE_KB) {
          continue
        }
        
        // Filter out typical non-code assets by extension
        const ext = path.extname(entry.name).toLowerCase()

        const indexableExtensions = [
          '.ts', '.tsx', '.js', '.jsx', '.json',
          '.py', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.rs',
          '.rb', '.php', '.html', '.css', '.md', '.yml', '.yaml',
          '.sh', '.txt', '.sql', '.toml', '.gradle', '.xml',
          '.dockerfile', '.ini', '.conf', '.cfg'
        ]
        
        const isAllowedExtension = indexableExtensions.includes(ext)
        const hasNoExt = ext === ''
        
        const isCommonConfigFilename = [
          'dockerfile',
          'makefile',
          'jenkinsfile',
          'procfile',
          'gemfile',
          'rakefile',
          'readme',
          'license',
          'todo'
        ].includes(fileName)

        // Strict allowlist-primary logic:
        // Only allow matching indexable extensions or explicit extensionless text/config files.
        // Everything else is rejected by default.
        if (isAllowedExtension || (hasNoExt && isCommonConfigFilename)) {
          fileList.push(fullPath)
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Skipped entry "${entry.name}" in "${dir}" due to error: ${err.message}`)
    }
  }

  return fileList
}

/**
 * Batch insert helper using raw parameterized queries for pgvector compatibility.
 */
async function bulkInsertChunks(
  chunks: Array<CodeChunkInput & { embedding: number[] }>
): Promise<void> {
  if (chunks.length === 0) return

  const values: any[] = []
  let query = 'INSERT INTO "code_chunks" ("id", "repositoryId", "filePath", "content", "startLine", "endLine", "embedding", "updatedAt") VALUES '

  chunks.forEach((chunk, i) => {
    const idx = i * 7
    query += `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}::vector, NOW())`
    if (i < chunks.length - 1) query += ', '

    values.push(
      chunk.id,
      chunk.repositoryId,
      chunk.filePath,
      chunk.content,
      chunk.startLine,
      chunk.endLine,
      `[${chunk.embedding.join(',')}]`
    )
  })

  query += ' ON CONFLICT (id) DO NOTHING'

  await prisma.$executeRawUnsafe(query, ...values)
}

/**
 * Helper to process embedding batches for a given repository and provider.
 * Supports automatic full restart/fallback to Jina on Gemini failure.
 */
export async function embedAndSaveChunks(
  repositoryId: string,
  chunks: CodeChunkInput[],
  provider: 'GEMINI' | 'JINA',
  jinaApiKey: string | undefined
): Promise<'GEMINI' | 'JINA'> {
  console.log(`Running embedding generation using provider: ${provider}`)
  const embeddingService = getEmbeddingService(provider)
  const batchSize = 100 // Safe batch size (limit is 250 items per request) to minimize request overhead

  // Clear out any old chunks first to keep the repository's vector space consistent
  await withRetry(() =>
    prisma.codeChunk.deleteMany({
      where: { repositoryId },
    })
  )

  try {
    for (let idx = 0; idx < chunks.length; idx += batchSize) {
      if (idx > 0) {
        // Proactive delay between batches to avoid bursting requests
        await new Promise((r) => setTimeout(r, 1200))
      }

      const batch = chunks.slice(idx, idx + batchSize)
      const contents = batch.map((c) => `File: ${c.filePath}\n\n${c.content}`)

      console.log(
        `Generating embeddings with ${provider} for batch ${Math.floor(idx / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}...`
      )

      let embeddings: number[][] = []
      let retriesLeft = 3
      const baseDelayMs = 2000

      while (true) {
        try {
          embeddings = await embeddingService.generateEmbeddings(contents)
          break // Success!
        } catch (err: any) {
          const isRateLimit = err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED')
          if (isRateLimit && retriesLeft > 0) {
            retriesLeft--

            let waitTimeMs = baseDelayMs
            const retryMatch = err.message.match(/Please retry in ([\d.]+)s/i)
            if (retryMatch && retryMatch[1]) {
              const seconds = parseFloat(retryMatch[1])
              if (!isNaN(seconds)) {
                // Add a small buffer of 500ms to be safe
                waitTimeMs = Math.ceil(seconds * 1000) + 500
              }
            } else {
              waitTimeMs = baseDelayMs * (3 - retriesLeft)
            }

            console.warn(
              `⚠️ ${provider} Embeddings API rate limited (429). Retrying in ${waitTimeMs}ms... (${retriesLeft} retries left)`
            )
            await new Promise((r) => setTimeout(r, waitTimeMs))
            continue
          }

          throw err
        }
      }

      // Zip chunks with embeddings
      const chunksWithEmbeddings = batch.map((chunk, i) => ({
        ...chunk,
        embedding: embeddings[i],
      }))

      // Save to database
      await withRetry(() => bulkInsertChunks(chunksWithEmbeddings))
    }

    return provider
  } catch (error: any) {
    // If Gemini failed and we have a Jina key, fall back to Jina
    if (provider === 'GEMINI' && jinaApiKey) {
      console.warn(
        `⚠️ Gemini embeddings generation failed: ${error.message}. Discarding current chunks and falling back to Jina AI...`
      )
      
      // Update repository provider in DB so it stays consistent
      await withRetry(() =>
        prisma.repository.update({
          where: { id: repositoryId },
          data: { embeddingProvider: 'JINA' },
        })
      )

      // Restart execution entirely using JINA (re-entrant call)
      return await embedAndSaveChunks(repositoryId, chunks, 'JINA', jinaApiKey)
    }

    // Otherwise (Jina failed or no Jina key), throw error
    throw error
  }
}

/**
 * Process a repository indexing job.
 */
async function processIndexingJob(job: Job<IndexingJobData>): Promise<void> {
  const { repositoryId, userId } = job.data
  console.log(`Starting indexing for repository: ${repositoryId} by user: ${userId}`)

  // 1. Fetch Repository and user decrypted credentials
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: {
      workspace: {
        include: {
          user: true,
        },
      },
    },
  })

  if (!repository) {
    throw new Error(`Repository ${repositoryId} not found`)
  }

  const user = repository.workspace.user
  let githubToken = ''
  try {
    githubToken = decrypt(user.githubToken)
  } catch (err) {
    console.error('Failed to decrypt user GitHub token:', err)
  }

  // 2. Set repository status to INDEXING and reset provider
  await withRetry(() =>
    prisma.repository.update({
      where: { id: repositoryId },
      data: { 
        indexingStatus: IndexingStatus.INDEXING,
        indexingError: null,
        embeddingProvider: 'GEMINI'
      },
    })
  )

  const tempBaseDir = path.join(process.cwd(), 'tmp', 'repos')
  const cloneDir = path.join(tempBaseDir, repository.id)

  try {
    // Ensure clean tmp path
    if (fs.existsSync(cloneDir)) {
      fs.rmSync(cloneDir, { recursive: true, force: true })
    }
    fs.mkdirSync(cloneDir, { recursive: true })

    // 3. Clone Repository
    // Formulate authenticated clone URL if token is available
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`
      : repository.githubUrl

    console.log(`Cloning ${repository.owner}/${repository.name} into ${cloneDir}...`)
    const git = simpleGit()
    await git.clone(cloneUrl, cloneDir, [
      '--depth',
      '1',
      '--single-branch',
      '-b',
      repository.defaultBranch,
    ])

    // 4. Retrieve indexable files
    const indexableFiles = getIndexableFiles(cloneDir, cloneDir)
    console.log(`Found ${indexableFiles.length} files to index.`)

    // Truncate if files count exceeds the maximum limit
    const filesToProcess = indexableFiles.slice(0, MAX_INDEX_FILES)
    if (indexableFiles.length > MAX_INDEX_FILES) {
      console.warn(`⚠️ Repository file count exceeds MAX_INDEX_FILES (${MAX_INDEX_FILES}). Truncating list.`)
    }

    // 5. Generate chunks
    const allChunks: CodeChunkInput[] = []
    for (const filePath of filesToProcess) {
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        if (isBinaryFile(content)) {
          continue
        }
        
        const relativePath = path.relative(cloneDir, filePath)
        const fileChunks = chunkFile(relativePath, content, repository.id)
        allChunks.push(...fileChunks)
      } catch (err: any) {
        console.warn(`⚠️ Skipped file ${filePath} due to read error: ${err.message}`)
      }
    }

    console.log(`Generated ${allChunks.length} chunks from files.`)

    // 6. Generate embeddings and save chunks (supports fallback)
    const finalProvider = await embedAndSaveChunks(
      repository.id,
      allChunks,
      'GEMINI',
      env.JINA_API_KEY
    )
    console.log(`Saved chunks using provider: ${finalProvider}`)

    // 7. Update status to COMPLETED
    await withRetry(() =>
      prisma.repository.update({
        where: { id: repository.id },
        data: {
          indexingStatus: IndexingStatus.COMPLETED,
          lastIndexedAt: new Date(),
        },
      })
    )
    console.log(`Successfully completed indexing for ${repository.owner}/${repository.name}`)

  } catch (error) {
    console.error(`Indexing job failed for ${repository.id}:`, error)
    
    // Set repository status to FAILED and store the failure reason
    const errMsg = (error as Error).message || 'Unknown indexing error'
    await withRetry(() =>
      prisma.repository.update({
        where: { id: repository.id },
        data: { 
          indexingStatus: IndexingStatus.FAILED,
          indexingError: errMsg
        },
      })
    ).catch((dbErr) => console.error('Failed to update repository status to FAILED:', dbErr))

    throw error
  } finally {
    // 8. Clean up disk clone
    try {
      if (fs.existsSync(cloneDir)) {
        fs.rmSync(cloneDir, { recursive: true, force: true })
        console.log(`Cleaned up temporary clone dir: ${cloneDir}`)
      }
    } catch (cleanupError) {
      console.error('Failed to clean up cloned directory:', cleanupError)
    }
  }
}

// Instantiate and export the worker
const connection = getRedisConnection()

console.log(`[worker] Initializing indexing worker for queue: ${INDEX_QUEUE_NAME}`)

connection.on('connect', () => {
  console.log('✅ Worker Redis connection established')
})

connection.on('error', (err) => {
  console.error('❌ Worker Redis connection error:', err.message)
})

export const indexingWorker = new Worker(
  INDEX_QUEUE_NAME,
  async (job: Job<IndexingJobData>) => {
    console.log(`[worker] Processing job ${job.id} for repo: ${job.data?.repositoryId}`)
    await processIndexingJob(job)
  },
  {
    connection: connection as any,
    concurrency: 1, // Process one repo at a time to prevent CPU/IO spikes
  }
)

indexingWorker.on('failed', (job, err) => {
  console.error(`Job failed ${job?.id}: ${err.message}`)
})

indexingWorker.on('completed', (job) => {
  console.log(`Job completed ${job.id}`)
})
