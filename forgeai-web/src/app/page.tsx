'use client'

import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { getGitHubLoginUrl, discoverCatalog, discoverSearch, api, type DiscoveredRepo } from '@/lib/api'
import { GithubIcon } from '@/components/icons'
import { useAuth } from '@/hooks/use-auth'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Zap, GitBranch, Search, ArrowRight, Star, GitPullRequest,
  Clock, Cpu, Shield, AlertCircle, CheckCircle2, X
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Health badge
// ---------------------------------------------------------------------------
function HealthBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const color =
    pct >= 70 ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10' :
    pct >= 45 ? 'text-amber-400  border-amber-400/30  bg-amber-400/10'  :
                'text-rose-400   border-rose-400/30   bg-rose-400/10'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}>
      <Shield className="h-3 w-3" />
      {pct}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tag chip
// ---------------------------------------------------------------------------
function TagChip({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center rounded-md border border-border/50 bg-secondary/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Repo card
// ---------------------------------------------------------------------------
function RepoCard({
  repo,
  onImport,
  isImporting,
  onTagClick,
}: {
  repo: DiscoveredRepo
  onImport: (githubUrl: string) => void
  isImporting: boolean
  onTagClick: (tag: string) => void
}) {
  const allTags = [
    ...repo.domainTags.map(t => ({ t, kind: 'domain' })),
    ...repo.techTags.map(t => ({ t, kind: 'tech' })),
    ...repo.architectureTags.map(t => ({ t, kind: 'arch' })),
  ].slice(0, 8)

  const daysSince = Math.floor(
    (Date.now() - new Date(repo.lastPushedAt).getTime()) / (1000 * 60 * 60 * 24)
  )

  return (
    <div className="group relative flex flex-col rounded-xl border border-border/50 bg-card/40 p-5 backdrop-blur-sm transition-all hover:border-primary/30 hover:bg-card/70">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group/link flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-primary"
          >
            <span className="truncate">{repo.owner}/{repo.name}</span>
          </a>
          {repo.similarity !== undefined && (
            <span className="text-xs text-muted-foreground">
              {Math.round(repo.similarity * 100)}% match
            </span>
          )}
        </div>
        <HealthBadge score={repo.healthScore} />
      </div>

      {/* Description */}
      <p className="mb-3 line-clamp-2 flex-1 text-sm text-muted-foreground">
        {repo.description || 'No description available.'}
      </p>

      {/* Tags */}
      {allTags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {allTags.map(({ t }) => (
            <TagChip key={t} label={t} onClick={() => onTagClick(t)} />
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="mb-4 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3" />
          {repo.stars.toLocaleString()}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {daysSince === 0 ? 'today' : `${daysSince}d ago`}
        </span>
        {repo.openIssues > 0 && (
          <span className="flex items-center gap-1">
            <GitPullRequest className="h-3 w-3" />
            {repo.openIssues} issues
          </span>
        )}
      </div>

      {/* Import button */}
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-2 border-primary/20 hover:border-primary/60 hover:bg-primary/10"
        onClick={() => onImport(repo.githubUrl)}
        disabled={isImporting}
      >
        {isImporting ? (
          <><Cpu className="h-3.5 w-3.5 animate-spin" /> Importing…</>
        ) : (
          <><GitBranch className="h-3.5 w-3.5" /> Import to ForgeAI</>
        )}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Discovery section (below hero)
// ---------------------------------------------------------------------------
function DiscoverySection() {
  const { isAuthenticated } = useAuth()
  const queryClient = useQueryClient()

  const [searchQuery, setSearchQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | undefined>()
  const [minStars, setMinStars] = useState(0)
  const [importingUrl, setImportingUrl] = useState<string | null>(null)
  const [importFeedback, setImportFeedback] = useState<{ url: string; ok: boolean; msg: string } | null>(null)

  // Catalog query (initial load / filter)
  const catalogQuery = useQuery({
    queryKey: ['discover-catalog', activeTag, minStars],
    queryFn: () => discoverCatalog({ limit: 20, tag: activeTag, minStars }),
    staleTime: 60_000,
  })

  // Semantic search query
  const searchResultQuery = useQuery({
    queryKey: ['discover-search', activeQuery, minStars],
    queryFn: () => discoverSearch({ query: activeQuery, limit: 20, minStars }),
    enabled: activeQuery.length > 2,
    staleTime: 30_000,
  })

  const repos: DiscoveredRepo[] = activeQuery.length > 2
    ? (searchResultQuery.data?.results ?? [])
    : (catalogQuery.data?.repos ?? [])

  const isLoading = activeQuery.length > 2 ? searchResultQuery.isLoading : catalogQuery.isLoading

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setActiveQuery(searchQuery.trim())
  }, [searchQuery])

  const handleTagClick = useCallback((tag: string) => {
    setActiveTag(tag)
    setActiveQuery('')
    setSearchQuery('')
  }, [])

  const handleImport = useCallback(async (githubUrl: string) => {
    if (!isAuthenticated) {
      window.location.href = getGitHubLoginUrl()
      return
    }

    setImportingUrl(githubUrl)
    setImportFeedback(null)

    try {
      // Fetch user's first workspace
      const workspaces = await api<any[]>('/api/workspaces')
      const workspaceId = workspaces?.[0]?.id
      if (!workspaceId) {
        setImportFeedback({ url: githubUrl, ok: false, msg: 'No workspace found. Create one first.' })
        return
      }

      await api('/api/repositories/import', {
        method: 'POST',
        body: JSON.stringify({ githubUrl, workspaceId }),
      })

      setImportFeedback({ url: githubUrl, ok: true, msg: 'Import started! Check your dashboard.' })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    } catch (err: any) {
      setImportFeedback({ url: githubUrl, ok: false, msg: err.message ?? 'Import failed.' })
    } finally {
      setImportingUrl(null)
    }
  }, [isAuthenticated, queryClient])

  const clearFilters = () => {
    setActiveTag(undefined)
    setActiveQuery('')
    setSearchQuery('')
  }

  return (
    <section className="relative z-10 mx-auto w-full max-w-6xl px-6 py-16">
      <div className="mb-10 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border/50 bg-secondary/50 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
          <Cpu className="h-3 w-3" />
          GitBrain Lite — curated discovery engine
        </div>
        <h2 className="text-3xl font-bold tracking-tight">
          Explore Open Source
        </h2>
        <p className="mt-2 text-muted-foreground">
          Browse and semantically search a curated catalog of quality repos.
          Import any to ForgeAI with one click.
        </p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          ⚠ Tags are LLM-generated best-effort classification — not a trained classifier.
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search repos by description, e.g. 'async task queue in Python'..."
            className="w-full rounded-lg border border-border/50 bg-secondary/30 py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <Button type="submit" size="sm" className="gap-2 px-6">
          <Search className="h-4 w-4" />
          Search
        </Button>
      </form>

      {/* Active filters */}
      {(activeTag || activeQuery) && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtering by:</span>
          {activeTag && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-3 py-1 text-xs text-primary">
              tag: {activeTag}
              <button onClick={clearFilters}><X className="h-3 w-3" /></button>
            </span>
          )}
          {activeQuery && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-3 py-1 text-xs text-primary">
              "{activeQuery}"
              <button onClick={clearFilters}><X className="h-3 w-3" /></button>
            </span>
          )}
        </div>
      )}

      {/* Star filter */}
      <div className="mb-6 flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Min stars:</span>
        {[0, 200, 500, 1000, 5000].map(n => (
          <button
            key={n}
            onClick={() => setMinStars(n)}
            className={`rounded-md border px-3 py-1 text-xs transition-colors ${
              minStars === n
                ? 'border-primary/60 bg-primary/20 text-primary'
                : 'border-border/50 text-muted-foreground hover:border-border hover:text-foreground'
            }`}
          >
            {n === 0 ? 'Any' : `★${n.toLocaleString()}+`}
          </button>
        ))}
      </div>

      {/* Import feedback toast */}
      {importFeedback && (
        <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
          importFeedback.ok
            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400'
            : 'border-rose-400/30 bg-rose-400/10 text-rose-400'
        }`}>
          {importFeedback.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          {importFeedback.msg}
          <button className="ml-auto" onClick={() => setImportFeedback(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border/50 bg-card/40 p-5 space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16 rounded-md" />
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      ) : repos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
          <Search className="h-10 w-10 opacity-30" />
          <p className="text-sm">
            {catalogQuery.data?.total === 0
              ? 'No repos in catalog yet. Trigger a discovery run to populate it.'
              : 'No results found. Try a different search or remove filters.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map(repo => (
            <RepoCard
              key={repo.id}
              repo={repo}
              onImport={handleImport}
              isImporting={importingUrl === repo.githubUrl}
              onTagClick={handleTagClick}
            />
          ))}
        </div>
      )}

      {/* Total count */}
      {!isLoading && repos.length > 0 && catalogQuery.data && !activeQuery && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Showing {repos.length} of {catalogQuery.data.total} repos
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Main landing page
// ---------------------------------------------------------------------------
export default function LandingPage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-[40%] left-1/2 h-[80rem] w-[80rem] -translate-x-1/2 rounded-full bg-[oklch(0.35_0.15_260)] opacity-20 blur-[120px]" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[40rem] w-[40rem] rounded-full bg-[oklch(0.4_0.18_300)] opacity-10 blur-[100px]" />
      </div>

      {/* Nav */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 md:px-12">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/20">
            <Zap className="h-4 w-4 text-primary" />
          </div>
          <span className="text-lg font-semibold tracking-tight">ForgeAI</span>
        </div>
        <a href={getGitHubLoginUrl()}>
          <Button variant="outline" size="sm" className="gap-2">
            <GithubIcon className="h-4 w-4" />
            Sign in
          </Button>
        </a>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex flex-col items-center px-6 pt-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/50 bg-secondary/50 px-4 py-1.5 text-sm text-muted-foreground backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          AI-powered code understanding
        </div>

        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
          Understand any codebase{' '}
          <span className="bg-gradient-to-r from-[oklch(0.7_0.2_260)] to-[oklch(0.7_0.2_300)] bg-clip-text text-transparent">
            in minutes
          </span>
        </h1>

        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Import a GitHub repo, let ForgeAI index and understand the code, then
          ask questions and get precise, context-aware answers grounded in your
          actual codebase.
        </p>

        <div className="mt-10 flex flex-col gap-4 sm:flex-row">
          <a href={getGitHubLoginUrl()}>
            <Button size="lg" className="gap-2 px-8 text-base">
              <GithubIcon className="h-5 w-5" />
              Sign in with GitHub
              <ArrowRight className="h-4 w-4" />
            </Button>
          </a>
        </div>

        {/* Feature highlights */}
        <div className="mt-16 grid max-w-4xl gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<GitBranch className="h-5 w-5" />}
            title="Import Repos"
            description="Paste a GitHub URL and ForgeAI clones, indexes, and makes the entire codebase searchable."
          />
          <FeatureCard
            icon={<Search className="h-5 w-5" />}
            title="Semantic Search"
            description="Ask questions in plain English. ForgeAI finds the most relevant code using vector embeddings."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="AI Reasoning"
            description="Get precise answers grounded in your codebase — no hallucination, no guessing."
          />
        </div>
      </main>

      {/* Divider */}
      <div className="relative z-10 mx-auto my-8 w-full max-w-6xl px-6">
        <div className="h-px bg-gradient-to-r from-transparent via-border/60 to-transparent" />
      </div>

      {/* Discovery section */}
      <DiscoverySection />

      {/* Footer */}
      <footer className="relative z-10 py-8 text-center text-sm text-muted-foreground">
        Built with Next.js, Express, and pgvector
      </footer>
    </div>
  )
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="group rounded-xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm transition-all hover:border-primary/30 hover:bg-card/80">
      <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
        {icon}
      </div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
