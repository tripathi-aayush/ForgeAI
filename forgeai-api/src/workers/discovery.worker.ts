/**
 * Phase 6: GitBrain Lite — Discovery Worker
 *
 * Scheduled weekly BullMQ worker that:
 * 1. Detects available embedding provider and rate limit for this run
 * 2. Re-embeds ALL existing DiscoveredRepo rows with the current provider
 *    (guarantees catalog-wide single-provider consistency after every cycle)
 * 3. For each query in discovery-queries.json, fetches GitHub Search results
 * 4. Skips tagging (README fetch + LLM) if pushed_at unchanged
 * 5. Computes health score, generates tags, embeds, upserts DiscoveredRepo
 * 6. Prunes oldest rows if catalog exceeds DISCOVERY_CATALOG_CAP
 *
 * Health Score Formula (documented here and in schema.prisma):
 *   raw = log10(stars + 1) * 10        // ~40 pts at 10k stars; log10(10001)*10 ≈ 40
 *       + max(0, 40 - daysSincePush/4) // 40 pts if pushed today, -1pt per 4 days
 *       + max(0, 20 - (openIssues / max(stars, 1)) * 100) // 20 pts if low issue ratio
 *   healthScore = clamp(raw, 0, 100) / 100  // normalize to [0, 1]
 *
 * Verified sample scores (stars term only for illustration):
 *   200 stars → log10(201)*10 ≈ 23.0
 *   500 stars → log10(501)*10 ≈ 27.0
 *   5000 stars → log10(5001)*10 ≈ 37.0
 *   10000 stars → log10(10001)*10 ≈ 40.0
 */

import { Worker, Job } from 'bullmq'
import { Octokit } from '@octokit/rest'
import { z } from 'zod'
import { getRedisConnection } from '../lib/redis'
import { prisma } from '../lib/prisma'
import { discoveryQueue, DISCOVERY_QUEUE_NAME } from '../lib/queue'
import { getEmbeddingService } from '../services/embeddings'
import { getLlmService } from '../services/llm'
import { env } from '../config/env'
import { DISCOVERY_CATALOG_CAP } from '../config/constants'
import discoveryQueries from '../config/discovery-queries.json'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveryQuery {
  q: string
  label: string
  perPage: number
}

interface GitHubRepoResult {
  full_name: string
  owner: { login: string }
  name: string
  description: string | null
  stargazers_count: number
  open_issues_count: number
  pushed_at: string
  html_url: string
  clone_url: string
}

// Zod schema for LLM-generated tags (structured JSON output)
const TagsSchema = z.object({
  domainTags: z.array(z.string()).max(5),
  techTags: z.array(z.string()).max(8),
  architectureTags: z.array(z.string()).max(5),
  readmeSummary: z.string().max(500),
})

type TagsOutput = z.infer<typeof TagsSchema>

// ---------------------------------------------------------------------------
// Health Score
// ---------------------------------------------------------------------------

/**
 * Compute health score for a discovered repo.
 * Formula is documented in schema.prisma and at the top of this file.
 * Returns a float in [0, 1].
 */
function computeHealthScore(stars: number, openIssues: number, lastPushedAt: Date): number {
  const daysSincePush = (Date.now() - lastPushedAt.getTime()) / (1000 * 60 * 60 * 24)
  const starTerm    = Math.log10(stars + 1) * 10
  const freshTerm   = Math.max(0, 40 - daysSincePush / 4)
  const issueTerm   = Math.max(0, 20 - (openIssues / Math.max(stars, 1)) * 100)
  const raw = starTerm + freshTerm + issueTerm
  return Math.min(1, Math.max(0, raw / 100))
}

// ---------------------------------------------------------------------------
// GitHub rate limit detection
// ---------------------------------------------------------------------------

/**
 * Makes one test Search API call to detect the actual rate limit in effect.
 * GitHub Search API: 10/min unauthenticated, 30/min for OAuth apps.
 * Returns query spacing in ms to stay safely under the detected limit.
 *
 * We check X-RateLimit-Limit header empirically rather than assuming the
 * OAuth app boost applies — there are reported cases of it being ignored.
 */
async function detectQuerySpacingMs(octokit: Octokit): Promise<number> {
  try {
    const response = await octokit.request('GET /search/repositories', {
      q: 'topic:test stars:>1',
      per_page: 1,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    })
    // @ts-ignore — headers are present but not typed on the response
    const limitHeader = response.headers?.['x-ratelimit-limit']
    const limit = limitHeader ? parseInt(String(limitHeader), 10) : 10
    if (limit >= 30) {
      console.log(`[discovery] GitHub Search rate limit: ${limit}/min — using 2s spacing`)
      return 2_000
    } else {
      console.log(`[discovery] GitHub Search rate limit: ${limit}/min — defaulting to safe 6s spacing`)
      return 6_000
    }
  } catch (err) {
    console.warn('[discovery] Rate limit detection failed, defaulting to 6s spacing:', err)
    return 6_000
  }
}

// ---------------------------------------------------------------------------
// README + manifest fetching (reusing existing Octokit pattern)
// ---------------------------------------------------------------------------

async function fetchReadmeContent(octokit: Octokit, owner: string, repo: string): Promise<string> {
  try {
    const { data } = await octokit.repos.getReadme({ owner, repo })
    if ('content' in data) {
      return Buffer.from(data.content, 'base64').toString('utf8').slice(0, 8000)
    }
  } catch {
    // README not found — not a hard error for discovery
  }
  return ''
}

async function fetchManifestContent(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const candidates = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle']
  for (const path of candidates) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path })
      if (!Array.isArray(data) && 'content' in data) {
        return Buffer.from(data.content, 'base64').toString('utf8').slice(0, 2000)
      }
    } catch {
      // not found — try next
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// LLM tagging (reusing existing structured JSON output pattern)
// ---------------------------------------------------------------------------

async function generateTags(
  llm: ReturnType<typeof getLlmService>,
  repoName: string,
  description: string,
  readmeContent: string,
  manifestContent: string
): Promise<TagsOutput> {
  const prompt = `Analyze this open-source repository and return a JSON object with these fields:
- domainTags: up to 5 short strings describing the problem domain (e.g. "machine-learning", "web-scraping", "database")
- techTags: up to 8 short strings for technologies/languages/frameworks used (e.g. "Python", "FastAPI", "PostgreSQL")
- architectureTags: up to 5 short strings for architectural patterns (e.g. "REST API", "microservices", "CLI tool")
- readmeSummary: a 1-2 sentence plain English summary of what this repo does (max 500 chars)

Repository: ${repoName}
Description: ${description || 'No description'}

README (truncated):
${readmeContent.slice(0, 3000) || 'Not available'}

Manifest/dependencies (truncated):
${manifestContent.slice(0, 1000) || 'Not available'}

Return ONLY valid JSON matching the schema. No markdown, no explanation.`

  const systemPrompt = `You are a code repository analyzer. Return only valid JSON.
IMPORTANT: Tags are best-effort LLM classification, not a trained classifier. Keep tags concise and lowercase-hyphenated.`

  try {
    const raw = await llm.generateStructuredAnswer(prompt, systemPrompt)
    const parsed = TagsSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch (e) {
    console.warn('[discovery] Tag parsing failed, using empty tags:', e)
  }

  // Safe fallback — empty tags, no crash
  return { domainTags: [], techTags: [], architectureTags: [], readmeSummary: description?.slice(0, 500) ?? '' }
}

// ---------------------------------------------------------------------------
// Full-catalog re-embed
// ---------------------------------------------------------------------------

/**
 * Re-embed ALL existing DiscoveredRepo rows using the current provider.
 * This guarantees catalog-wide single-provider consistency after every cycle.
 * At ≤300 rows this is cheap (1-3 batches).
 */
async function reEmbedAllExistingRows(
  embeddingService: ReturnType<typeof getEmbeddingService>,
  provider: string
): Promise<void> {
  console.log('[discovery] Re-embedding entire catalog for provider consistency...')

  const allRepos = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; description: string | null; readmeSummary: string | null }>>(
    `SELECT id, name, description, "readmeSummary" FROM discovered_repos`
  )

  if (allRepos.length === 0) {
    console.log('[discovery] Catalog empty — nothing to re-embed')
    return
  }

  const BATCH_SIZE = 50
  let reEmbedded = 0

  for (let i = 0; i < allRepos.length; i += BATCH_SIZE) {
    const batch = allRepos.slice(i, i + BATCH_SIZE)
    const texts = batch.map(r => `${r.name}: ${r.description ?? ''}\n${r.readmeSummary ?? ''}`.slice(0, 2000))

    try {
      const embeddings = await embeddingService.generateEmbeddings(texts)

      for (let j = 0; j < batch.length; j++) {
        const vectorStr = `[${embeddings[j].join(',')}]`
        await prisma.$executeRawUnsafe(
          `UPDATE discovered_repos SET embedding = $1::vector, "embeddingProvider" = $2, "updatedAt" = NOW() WHERE id = $3`,
          vectorStr, provider, batch[j].id
        )
      }
      reEmbedded += batch.length
      console.log(`[discovery] Re-embedded ${reEmbedded}/${allRepos.length} rows`)
    } catch (err) {
      console.error('[discovery] Batch re-embed failed:', err)
    }

    if (i + BATCH_SIZE < allRepos.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  console.log(`[discovery] Re-embed complete: ${reEmbedded}/${allRepos.length} rows updated to ${provider}`)
}

// ---------------------------------------------------------------------------
// Main job processor
// ---------------------------------------------------------------------------

async function runDiscovery(): Promise<void> {
  console.log('[discovery] Starting Phase 6 discovery run...')

  // Determine embedding provider for this entire run
  const embeddingService = getEmbeddingService()
  const provider = env.GEMINI_API_KEY ? 'GEMINI' : env.JINA_API_KEY ? 'JINA' : 'MOCK'
  console.log(`[discovery] Embedding provider for this run: ${provider}`)

  // Step 1: Re-embed ALL existing rows with current provider
  await reEmbedAllExistingRows(embeddingService, provider)

  // Step 2: Create Octokit for GitHub Search.
  // Note: GitHub OAuth App Basic auth (client_id:client_secret) requires passing as HTTP Basic
  // credentials, not a Bearer token. Octokit's `auth` string is treated as a token, which GitHub
  // rejects as bad credentials. Since our OAuth app auth approach doesn't work with Octokit's
  // simple string auth, we use unauthenticated requests (10/min). The empirical rate limit check
  // below will confirm this and use the safe 6s spacing. At 18 queries × 6s = ~108s total,
  // well within the weekly job window.
  const octokit = new Octokit()

  const querySpacingMs = await detectQuerySpacingMs(octokit)
  const llm = getLlmService()

  let totalDiscovered = 0
  let totalSkipped = 0
  let totalTagged = 0
  let totalErrors = 0

  // Step 3: Process each fixed query
  for (const query of discoveryQueries as DiscoveryQuery[]) {
    console.log(`[discovery] Processing query [${query.label}]: ${query.q}`)

    try {
      const { data } = await octokit.search.repos({
        q: query.q,
        sort: 'stars',
        order: 'desc',
        per_page: query.perPage,
      })

      for (const item of data.items as GitHubRepoResult[]) {
        try {
          const githubUrl = item.html_url
          const lastPushedAt = new Date(item.pushed_at)

          // Check if already exists and pushed_at unchanged
          const existing = await prisma.$queryRawUnsafe<Array<{ lastPushedAt: Date; readmeSummary: string | null }>>(
            `SELECT "lastPushedAt", "readmeSummary" FROM discovered_repos WHERE "githubUrl" = $1`,
            githubUrl
          )

          const pushUnchanged = existing.length > 0 &&
            existing[0].lastPushedAt.getTime() === lastPushedAt.getTime()

          let tags: TagsOutput
          let readmeContentForEmbed: string

          if (pushUnchanged && existing[0].readmeSummary) {
            // Skip expensive tagging — reuse stored summary
            totalSkipped++
            tags = {
              domainTags: [],
              techTags: [],
              architectureTags: [],
              readmeSummary: existing[0].readmeSummary,
            }
            // Pull existing tags from DB
            const existingFull = await prisma.$queryRawUnsafe<Array<{
              domainTags: string[]; techTags: string[]; architectureTags: string[]
            }>>(
              `SELECT "domainTags", "techTags", "architectureTags" FROM discovered_repos WHERE "githubUrl" = $1`,
              githubUrl
            )
            if (existingFull.length > 0) {
              tags.domainTags = existingFull[0].domainTags
              tags.techTags = existingFull[0].techTags
              tags.architectureTags = existingFull[0].architectureTags
            }
            readmeContentForEmbed = existing[0].readmeSummary
          } else {
            // Fetch README + manifest and generate tags
            const [readmeContent, manifestContent] = await Promise.all([
              fetchReadmeContent(octokit, item.owner.login, item.name),
              fetchManifestContent(octokit, item.owner.login, item.name),
            ])
            tags = await generateTags(llm, item.name, item.description ?? '', readmeContent, manifestContent)
            readmeContentForEmbed = tags.readmeSummary
            totalTagged++
          }

          // Compute health score
          const healthScore = computeHealthScore(item.stargazers_count, item.open_issues_count, lastPushedAt)

          // Embed this repo's description + README summary
          const embedText = `${item.name}: ${item.description ?? ''}\n${readmeContentForEmbed}`.slice(0, 2000)
          const embeddingVector = await embeddingService.generateEmbedding(embedText)
          const vectorStr = `[${embeddingVector.join(',')}]`

          // Upsert into discovered_repos
          await prisma.$executeRawUnsafe(`
            INSERT INTO discovered_repos (
              id, "githubUrl", owner, name, description, stars, "openIssues",
              "lastPushedAt", "domainTags", "techTags", "architectureTags",
              "healthScore", embedding, "embeddingProvider", "readmeSummary",
              "lastRefreshedAt", "createdAt", "updatedAt"
            ) VALUES (
              gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
              $7::timestamp, $8::text[], $9::text[], $10::text[],
              $11, $12::vector, $13, $14,
              NOW(), NOW(), NOW()
            )
            ON CONFLICT ("githubUrl") DO UPDATE SET
              owner = EXCLUDED.owner,
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              stars = EXCLUDED.stars,
              "openIssues" = EXCLUDED."openIssues",
              "lastPushedAt" = EXCLUDED."lastPushedAt",
              "domainTags" = EXCLUDED."domainTags",
              "techTags" = EXCLUDED."techTags",
              "architectureTags" = EXCLUDED."architectureTags",
              "healthScore" = EXCLUDED."healthScore",
              embedding = EXCLUDED.embedding,
              "embeddingProvider" = EXCLUDED."embeddingProvider",
              "readmeSummary" = EXCLUDED."readmeSummary",
              "lastRefreshedAt" = NOW(),
              "updatedAt" = NOW()
          `,
            githubUrl,
            item.owner.login,
            item.name,
            item.description,
            item.stargazers_count,
            item.open_issues_count,
            lastPushedAt.toISOString(),
            tags.domainTags,         // Prisma passes JS arrays as Postgres arrays when ::text[] cast is used
            tags.techTags,
            tags.architectureTags,
            healthScore,
            vectorStr,
            provider,
            tags.readmeSummary,
          )

          totalDiscovered++
          console.log(`[discovery]   ✓ ${item.full_name} | ★${item.stargazers_count} | health=${healthScore.toFixed(3)} | tags=${tags.domainTags.slice(0,3).join(',')}`)
        } catch (itemErr) {
          console.error(`[discovery]   ✗ ${item.full_name}:`, itemErr)
          totalErrors++
        }
      }
    } catch (queryErr) {
      console.error(`[discovery] Query [${query.label}] failed:`, queryErr)
      totalErrors++
    }

    // Respect GitHub Search API rate limit
    await new Promise(r => setTimeout(r, querySpacingMs))
  }

  // Step 4: Prune if over cap
  const totalRows = await prisma.$queryRawUnsafe<Array<{ count: string }>>(
    `SELECT COUNT(*)::text as count FROM discovered_repos`
  )
  const rowCount = parseInt(totalRows[0].count, 10)

  if (rowCount > DISCOVERY_CATALOG_CAP) {
    const excess = rowCount - DISCOVERY_CATALOG_CAP
    await prisma.$executeRawUnsafe(`
      DELETE FROM discovered_repos
      WHERE id IN (
        SELECT id FROM discovered_repos
        ORDER BY "lastRefreshedAt" ASC
        LIMIT $1
      )
    `, excess)
    console.log(`[discovery] Pruned ${excess} oldest rows (catalog was ${rowCount}, cap is ${DISCOVERY_CATALOG_CAP})`)
  }

  console.log(`[discovery] Run complete:`)
  console.log(`  Discovered/updated: ${totalDiscovered}`)
  console.log(`  Skipped (push unchanged): ${totalSkipped}`)
  console.log(`  Tagged (README+LLM): ${totalTagged}`)
  console.log(`  Errors: ${totalErrors}`)
}

// ---------------------------------------------------------------------------
// BullMQ Worker registration
// ---------------------------------------------------------------------------

const discoveryWorker = new Worker(
  DISCOVERY_QUEUE_NAME,
  async (job: Job) => {
    console.log(`[discovery] Job ${job.id} started (type: ${job.name})`)
    await runDiscovery()
    console.log(`[discovery] Job ${job.id} completed`)
  },
  {
    connection: getRedisConnection() as any,
    concurrency: 1, // Only one discovery run at a time
  }
)

discoveryWorker.on('failed', (job, err) => {
  console.error(`[discovery] Job ${job?.id} failed:`, err.message)
})

// Register the weekly repeatable job.
// BullMQ's repeat pattern: cron '0 2 * * 0' = every Sunday at 02:00 UTC.
// The job is idempotent and safe to run multiple times — upsert logic handles it.
discoveryQueue.upsertJobScheduler(
  'weekly-discovery',
  { pattern: '0 2 * * 0' },
  {
    name: 'discover_repos',
    data: { triggeredBy: 'schedule' },
    opts: { removeOnComplete: true, removeOnFail: false },
  }
).catch(err => {
  console.error('[discovery] Failed to register weekly job scheduler:', err.message)
})

console.log('[discovery] Worker registered. Weekly job scheduled: Sundays at 02:00 UTC.')

export { discoveryWorker, runDiscovery }
