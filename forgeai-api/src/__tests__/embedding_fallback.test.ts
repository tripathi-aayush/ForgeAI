import { embedAndSaveChunks } from '../workers/indexing'
import { prisma } from '../lib/prisma'
import { env } from '../config/env'
import { IndexingStatus } from '@prisma/client'
import { getEmbeddingService } from '../services/embeddings'

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
