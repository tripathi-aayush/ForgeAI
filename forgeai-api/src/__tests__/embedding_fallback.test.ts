import { embedAndSaveChunks } from '../workers/indexing'
import { prisma } from '../lib/prisma'
import { env } from '../config/env'
import { IndexingStatus } from '@prisma/client'
import { getEmbeddingService } from '../services/embeddings'
import express from 'express'
import http from 'http'
import repositoriesRoutes from '../routes/repositories'

/**
 * Unit/integration test for Jina AI embedding provider fallback.
 * Intercepts Gemini API calls to return 429, triggers rollback,
 * and asserts Jina fallback execution runs successfully with zero-padded vectors.
 *
 * Run with: npx tsx src/__tests__/embedding_fallback.test.ts
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = []

function testAsync(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn })
}

async function setupTestRepository() {
  let workspace = await prisma.workspace.findFirst({
    include: { user: true }
  })
  
  if (!workspace) {
    const user = await prisma.user.create({
      data: {
        githubId: Math.floor(Math.random() * 1000000),
        username: 'dummy-username-' + Math.random(),
        githubToken: 'encrypted-token'
      }
    })
    
    workspace = await prisma.workspace.create({
      data: {
        name: 'test-workspace',
        userId: user.id
      },
      include: { user: true }
    })
  }
  
  const repository = await prisma.repository.create({
    data: {
      name: 'fallback-test-repo',
      owner: 'test-owner',
      githubUrl: 'https://github.com/test-owner/fallback-test-repo-' + Math.random() + '.git',
      defaultBranch: 'main',
      workspaceId: workspace.id,
      indexingStatus: IndexingStatus.PENDING,
      embeddingProvider: 'GEMINI'
    }
  })
  
  return repository
}

async function cleanupTestRepository(repoId: string) {
  await prisma.codeChunk.deleteMany({
    where: { repositoryId: repoId }
  })
  await prisma.repository.delete({
    where: { id: repoId }
  })
}

testAsync('Gemini 429 quota triggers one-directional Jina fallback, deletes dirty chunks, updates DB provider, and zero-pads vector to 1536', async () => {
  const originalJinaApiKey = env.JINA_API_KEY
  const originalGeminiApiKey = env.GEMINI_API_KEY
  const originalFetch = global.fetch

  env.JINA_API_KEY = 'mock-jina-api-key'
  env.GEMINI_API_KEY = 'mock-gemini-api-key'

  // Mock fetch calls
  global.fetch = (async (url: string, init?: any) => {
    const urlString = url.toString()
    if (urlString.includes('generativelanguage.googleapis.com')) {
      // Mock Gemini 429 Daily Limit failure
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-2\nPlease retry in 0.1s.',
            status: 'RESOURCE_EXHAUSTED'
          }
        })
      } as any
    }
    
    if (urlString.includes('api.jina.ai')) {
      // Mock Jina response with 1024-dimensional embeddings (to be zero-padded to 1536)
      const body = JSON.parse(init.body)
      const mockEmbeddings = body.input.map((text: string, idx: number) => ({
        object: 'embedding',
        index: idx,
        embedding: new Array(1024).fill(0.123)
      }))
      
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'jina-embeddings-v3',
          object: 'list',
          data: mockEmbeddings
        })
      } as any
    }
    
    return originalFetch(url, init)
  }) as any

  const repo = await setupTestRepository()

  try {
    const chunks = [
      {
        id: 'chunk-1-' + Math.random(),
        repositoryId: repo.id,
        filePath: 'test.py',
        content: 'print("hello")',
        startLine: 1,
        endLine: 1
      },
      {
        id: 'chunk-2-' + Math.random(),
        repositoryId: repo.id,
        filePath: 'utils.py',
        content: 'def add(a, b): return a + b',
        startLine: 1,
        endLine: 2
      }
    ]

    console.log('Running test fallback run...')
    const finalProvider = await embedAndSaveChunks(
      repo.id,
      chunks as any,
      'GEMINI',
      env.JINA_API_KEY
    )

    assert(finalProvider === 'JINA', 'Should have successfully transitioned and run under JINA')

    // Confirm DB Repository record updated
    const dbRepo = await prisma.repository.findUnique({
      where: { id: repo.id }
    })
    assert(dbRepo?.embeddingProvider === 'JINA', 'DB Repository record should have JINA as provider')

    // Verify chunks saved and vector size
    const dbChunks = await prisma.codeChunk.findMany({
      where: { repositoryId: repo.id }
    })
    assert(dbChunks.length === 2, 'Should have 2 chunks in DB')

    // Query raw database values to ensure they are 1536 dimensions and correctly padded
    const rawChunk = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "embedding"::text FROM "code_chunks" WHERE "repositoryId" = $1 LIMIT 1`,
      repo.id
    )
    assert(rawChunk.length > 0, 'Should find raw db chunk vector')
    const embeddingStr = rawChunk[0].embedding
    const arr = JSON.parse(embeddingStr)
    assert(arr.length === 1536, 'Vector should be padded to 1536 dimensions')
    assert(arr[0] === 0.123, 'First element should match Jina model value')
    assert(arr[1023] === 0.123, '1024th element should match Jina model value')
    assert(arr[1024] === 0, '1025th element (padded) should be zero')
    assert(arr[1535] === 0, '1536th element (padded) should be zero')

    console.log('  ✅ Database vector length and values correctly zero-padded')

  } finally {
    await cleanupTestRepository(repo.id)

    // Restore original globals
    env.JINA_API_KEY = originalJinaApiKey
    env.GEMINI_API_KEY = originalGeminiApiKey
    global.fetch = originalFetch
  }
})

testAsync('RAG query routing correctly uses repository.embeddingProvider to generate question embedding', async () => {
  const originalJinaApiKey = env.JINA_API_KEY
  const originalGeminiApiKey = env.GEMINI_API_KEY
  const originalFetch = global.fetch

  env.JINA_API_KEY = 'mock-jina-api-key'
  env.GEMINI_API_KEY = 'mock-gemini-api-key'

  const repo = await setupTestRepository()
  // Explicitly set provider to JINA
  await prisma.repository.update({
    where: { id: repo.id },
    data: { embeddingProvider: 'JINA' }
  })

  const spies: { jinaCalled: boolean; geminiCalled: boolean } = {
    jinaCalled: false,
    geminiCalled: false
  }

  global.fetch = (async (url: string, init?: any) => {
    const urlString = url.toString()
    if (urlString.includes('generativelanguage.googleapis.com')) {
      spies.geminiCalled = true
      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: new Array(1536).fill(0.789) }]
        })
      } as any
    }
    
    if (urlString.includes('api.jina.ai')) {
      spies.jinaCalled = true
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'jina-embeddings-v3',
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: new Array(1024).fill(0.123) }]
        })
      } as any
    }
    
    return originalFetch(url, init)
  }) as any

  try {
    // 1. Correct query routing flow
    const refreshedRepo = await prisma.repository.findUnique({ where: { id: repo.id } })
    assert(refreshedRepo !== null, 'Repo should exist')
    assert(refreshedRepo!.embeddingProvider === 'JINA', 'Should have JINA provider')

    const embeddingService = getEmbeddingService(refreshedRepo!.embeddingProvider)
    const embedding = await embeddingService.generateEmbedding('What is fallback?')

    assert((spies.jinaCalled as any) === true, 'Jina API should have been called')
    assert((spies.geminiCalled as any) === false, 'Gemini API should NOT have been called')
    assert(embedding.length === 1536, 'Vector should be 1536 dimensions')
    assert(embedding[0] === 0.123, 'Jina vector values should be 0.123')

    // Reset spies
    spies.jinaCalled = false
    spies.geminiCalled = false

    // 2. Constructed wrong routing flow (e.g. defaulting to GEMINI for JINA repo)
    const wrongEmbeddingService = getEmbeddingService('GEMINI')
    const wrongEmbedding = await wrongEmbeddingService.generateEmbedding('What is fallback?')

    assert((spies.geminiCalled as any) === true, 'Gemini API should have been called in wrong routing')
    assert((spies.jinaCalled as any) === false, 'Jina API should NOT have been called in wrong routing')
    assert(wrongEmbedding[0] !== 0.123, 'Gemini embedding values must not match Jina values')
    assert(wrongEmbedding[0] === 0.789, 'Wrong routing should return Gemini values (0.789)')

    console.log('  ✅ Query routing end-to-end verified. Mismatched routing successfully detected!')

  } finally {
    await cleanupTestRepository(repo.id)

    // Restore original globals
    env.JINA_API_KEY = originalJinaApiKey
    env.GEMINI_API_KEY = originalGeminiApiKey
    global.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// Test 3: /ask route handler integration — verifies the route's own DB read
// drives provider selection, not a hardcoded default or cached value.
// ---------------------------------------------------------------------------
testAsync('/ask route handler reads embeddingProvider from DB and routes to Jina (not Gemini) for JINA repo', async () => {
  const originalJinaApiKey = env.JINA_API_KEY
  const originalGeminiApiKey = env.GEMINI_API_KEY
  const originalFetch = global.fetch

  env.JINA_API_KEY = 'mock-jina-api-key'
  env.GEMINI_API_KEY = 'mock-gemini-api-key'

  // 1. Seed: create repo with embeddingProvider = JINA and one chunk
  const repo = await setupTestRepository()

  // Read the real workspace userId that the route will compare against.
  // The route checks: repository.workspace.userId !== userId (from req.user.sub).
  // We must inject the ACTUAL db userId — a hardcoded string would fail the check.
  const repoWithWorkspace = await prisma.repository.findUnique({
    where: { id: repo.id },
    include: { workspace: true },
  }) as any
  const actualUserId = repoWithWorkspace.workspace.userId

  await prisma.repository.update({
    where: { id: repo.id },
    data: {
      embeddingProvider: 'JINA',
      indexingStatus: IndexingStatus.COMPLETED,  // route requires COMPLETED
    }
  })

  // Insert a real code chunk so the vector query has something to return.
  // The embedding must be 1536-dimensional — we use zeros since this is a
  // content test, not a similarity precision test.
  const zeroPaddedVector = `[${new Array(1536).fill(0).join(',')}]`
  await prisma.$executeRawUnsafe(
    `INSERT INTO "code_chunks" ("id", "repositoryId", "filePath", "content", "startLine", "endLine", "embedding", "updatedAt")
     VALUES ($1, $2, 'test.py', 'print("hello")', 1, 1, $3::vector, NOW())`,
    'route-test-chunk-' + Math.random(),
    repo.id,
    zeroPaddedVector
  )

  // 2. Spy: track which embedding API the route actually calls
  const spies: { jinaCalled: boolean; geminiEmbedCalled: boolean } = {
    jinaCalled: false,
    geminiEmbedCalled: false,
  }

  global.fetch = (async (url: string, init?: any) => {
    const urlString = url.toString()

    if (urlString.includes('api.jina.ai')) {
      spies.jinaCalled = true
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'jina-embeddings-v3',
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: new Array(1024).fill(0.5) }],
        }),
      } as any
    }

    // Intercept Gemini EMBEDDING calls specifically (batchEmbedContents)
    if (urlString.includes('generativelanguage.googleapis.com') && urlString.includes('batchEmbedContents')) {
      spies.geminiEmbedCalled = true
      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: new Array(1536).fill(0.9) }],
        }),
      } as any
    }

    // Intercept Gemini/Groq LLM calls (generateContent) — return a mock answer
    if (urlString.includes('generativelanguage.googleapis.com') && urlString.includes('generateContent')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Mock LLM answer' }] } }],
        }),
      } as any
    }

    if (urlString.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Mock Groq answer' } }],
        }),
      } as any
    }

    if (urlString.includes('api.openai.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Mock OpenAI answer' } }],
        }),
      } as any
    }

    return originalFetch(url, init)
  }) as any

  // 3. Spin up a minimal Express app with the REAL repositories router.
  //    Inject req.user via a pre-middleware so the auth check inside the route
  //    (req.user?.sub) is satisfied without a real JWT.
  //    IMPORTANT: inject the ACTUAL db user id so workspace.userId === req.user.sub.
  const testApp = express()
  testApp.use(express.json())
  testApp.use((_req: any, _res: any, next: any) => {
    ;(_req as any).user = { sub: actualUserId }
    next()
  })
  testApp.use('/api/repositories', repositoriesRoutes)

  const server = http.createServer(testApp)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as any).port

  try {
    // 4. POST /api/repositories/:id/ask — this goes through the REAL handler
    //    which does its own prisma.repository.findUnique → reads embeddingProvider
    const body = JSON.stringify({ question: 'What does this code do?' })
    const responseData = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/api/repositories/${repo.id}/ask`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk) => { raw += chunk })
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
          })
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    // 5. Assert: route must have succeeded
    assert(
      responseData.status === 200,
      `Expected HTTP 200 from /ask, got ${responseData.status}: ${JSON.stringify(responseData.body)}`
    )

    // 6. Assert: Jina was called for the query embedding (not Gemini)
    //    This proves the route read embeddingProvider from the DB and used it.
    assert(
      spies.jinaCalled === true,
      'Route handler must have called Jina for query embedding (embeddingProvider = JINA in DB)'
    )
    assert(
      spies.geminiEmbedCalled === false,
      'Route handler must NOT have called Gemini embedding API for a JINA-indexed repo. ' +
      'If this fails, the route is ignoring repository.embeddingProvider from the DB.'
    )

    console.log('  ✅ /ask route handler reads embeddingProvider from DB correctly — Jina used, Gemini embedding skipped')

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await cleanupTestRepository(repo.id)
    env.JINA_API_KEY = originalJinaApiKey
    env.GEMINI_API_KEY = originalGeminiApiKey
    global.fetch = originalFetch
  }
})

async function runAll() {
  console.log('\n🧪 Running Jina Fallback & Query Routing Tests sequentially...\n')
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`  ✅ ${t.name}`)
    } catch (err: any) {
      console.error(`  ❌ ${t.name}:`, err.stack)
      process.exitCode = 1
    }
  }
}
runAll()
