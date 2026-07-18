/**
 * Phase 6: GitBrain Lite — Discovery API routes
 *
 * GET  /api/discover          — paginated catalog browse (public, no auth required)
 * POST /api/discover/search   — semantic search over discovered repos (public, rate-limited)
 * POST /api/discover/trigger  — admin-only: manually trigger a discovery run
 *
 * NOTE: Tags on discovered repos are LLM-generated best-effort classification,
 * not a trained classifier. They should be presented as such in the UI.
 */

import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import { getEmbeddingService } from '../services/embeddings'
import { discoveryQueue } from '../lib/queue'
import { rateLimit } from '../middleware/rateLimit'
import { env } from '../config/env'
import { requireAuth } from '../middleware/auth'
import {
  DISCOVERY_TRIGGER_WINDOW_MS,
  DISCOVERY_TRIGGER_MAX,
} from '../config/constants'

const router = Router()

// Rate limits
const searchRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: 'Too many search requests. Please wait before trying again.',
})

const triggerRateLimit = rateLimit({
  windowMs: DISCOVERY_TRIGGER_WINDOW_MS, // 1 hour
  max: DISCOVERY_TRIGGER_MAX,            // 1 per hour
  message: 'Discovery trigger is rate-limited to once per hour.',
})

// ---------------------------------------------------------------------------
// GET /api/discover
// Returns paginated catalog. Public — no auth required.
// Query params: tag?, minStars?, limit=20, offset=0
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response) => {
  const limit  = Math.min(parseInt(req.query.limit  as string ?? '20', 10), 50)
  const offset = parseInt(req.query.offset as string ?? '0', 10)
  const tag    = req.query.tag as string | undefined
  const minStars = parseInt(req.query.minStars as string ?? '0', 10)

  try {
    // Build dynamic WHERE clause for tag filtering
    // Tags are stored as text arrays in Postgres — use the @> (contains) operator
    let whereClause = `WHERE stars >= $1`
    const params: any[] = [minStars]
    let paramIdx = 2

    if (tag) {
      whereClause += ` AND ($${paramIdx} = ANY("domainTags") OR $${paramIdx} = ANY("techTags") OR $${paramIdx} = ANY("architectureTags"))`
      params.push(tag)
      paramIdx++
    }

    const repos = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, "githubUrl", owner, name, description, stars, "openIssues",
             "lastPushedAt", "domainTags", "techTags", "architectureTags",
             "healthScore", "embeddingProvider", "lastRefreshedAt"
      FROM discovered_repos
      ${whereClause}
      ORDER BY "healthScore" DESC, stars DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, ...params, limit, offset)

    const totalResult = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
      `SELECT COUNT(*)::text as count FROM discovered_repos ${whereClause}`,
      ...params
    )
    const total = parseInt(totalResult[0].count, 10)

    res.json({ repos, total, limit, offset })
  } catch (err: any) {
    console.error('Discovery catalog fetch failed:', err)
    res.status(500).json({ error: `Failed to fetch catalog: ${err.message}` })
  }
})

// ---------------------------------------------------------------------------
// POST /api/discover/search
// Semantic search via pgvector. Public, rate-limited.
// Body: { query: string, limit?: number, minStars?: number }
// ---------------------------------------------------------------------------
router.post('/search', searchRateLimit, async (req: Request, res: Response) => {
  const { query, limit = 10, minStars = 0 } = req.body

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    res.status(400).json({ error: 'Missing or empty query' })
    return
  }

  const safeLimit = Math.min(parseInt(String(limit), 10), 30)
  const safeMinStars = parseInt(String(minStars), 10)

  try {
    // Determine which provider the catalog is using (most common provider among rows)
    // to ensure query embedding matches the indexed vectors.
    const providerResult = await prisma.$queryRawUnsafe<Array<{ provider: string; cnt: string }>>(
      `SELECT "embeddingProvider" as provider, COUNT(*)::text as cnt
       FROM discovered_repos
       WHERE embedding IS NOT NULL
       GROUP BY "embeddingProvider"
       ORDER BY cnt DESC
       LIMIT 1`
    )

    // If catalog is empty or all rows lack embeddings, return empty gracefully
    if (providerResult.length === 0) {
      res.json({ results: [], note: 'Discovery catalog is empty. Run a discovery job first.' })
      return
    }

    const catalogProvider = providerResult[0].provider
    const embeddingService = getEmbeddingService(catalogProvider)
    const queryEmbedding = await embeddingService.generateEmbedding(query.trim())
    const queryVectorStr = `[${queryEmbedding.join(',')}]`

    const results = await prisma.$queryRawUnsafe<any[]>(`
      SELECT id, "githubUrl", owner, name, description, stars, "openIssues",
             "lastPushedAt", "domainTags", "techTags", "architectureTags",
             "healthScore", "embeddingProvider",
             1 - (embedding <=> $1::vector) as similarity
      FROM discovered_repos
      WHERE embedding IS NOT NULL
        AND "embeddingProvider" = $2
        AND stars >= $3
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `, queryVectorStr, catalogProvider, safeMinStars, safeLimit)

    res.json({
      results,
      provider: catalogProvider,
      note: 'Tags are LLM-generated best-effort classification, not a trained classifier.',
    })
  } catch (err: any) {
    console.error('Discovery search failed:', err)
    res.status(500).json({ error: `Search failed: ${err.message}` })
  }
})

// ---------------------------------------------------------------------------
// POST /api/discover/trigger
// Admin-only: manually trigger one discovery run. Requires:
//   - Valid JWT session (req.user.sub set by requireAuth middleware)
//   - req.user.sub must match ADMIN_USER_ID env var
//   - Max 1 call per hour
// ---------------------------------------------------------------------------
router.post('/trigger', requireAuth, triggerRateLimit, async (req: Request, res: Response) => {
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  if (!env.ADMIN_USER_ID) {
    res.status(503).json({ error: 'Trigger endpoint is disabled: ADMIN_USER_ID is not configured.' })
    return
  }

  if (userId !== env.ADMIN_USER_ID) {
    res.status(403).json({ error: 'Forbidden: discovery trigger is restricted to admin users.' })
    return
  }

  try {
    const job = await discoveryQueue.add('discover_repos', {
      triggeredBy: 'admin',
      triggeredAt: new Date().toISOString(),
      triggeredByUser: userId,
    })

    res.json({
      message: 'Discovery job queued successfully.',
      jobId: job.id,
      note: 'The job runs asynchronously. Check server logs for progress.',
    })
  } catch (err: any) {
    console.error('Failed to queue discovery job:', err)
    res.status(500).json({ error: `Failed to queue job: ${err.message}` })
  }
})

export default router
