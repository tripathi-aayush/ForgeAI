'use client'

import { useAuth } from '@/hooks/use-auth'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Navbar } from '@/components/navbar'
import { useWorkspaceStore, type Repository } from '@/lib/store'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { GitBranch, Plus, Search, Terminal, AlertTriangle, CheckCircle, RefreshCw, ExternalLink } from 'lucide-react'

// Fetch workspaces with repos
const fetchWorkspaces = async () => {
  return api<any[]>('/api/workspaces')
}

// Import repo mutation
const useImportRepository = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { githubUrl: string; workspaceId: string }) =>
      api<Repository>('/api/repositories/import', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
  })
}

export default function DashboardPage() {
  const { user, isLoading: authLoading, isAuthenticated } = useAuth()
  const router = useRouter()
  const queryClient = useQueryClient()

  const {
    workspaces,
    activeWorkspaceId,
    setWorkspaces,
    setActiveWorkspaceId,
    setActiveRepositoryId,
  } = useWorkspaceStore()

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [githubUrlInput, setGithubUrlInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  // Load workspaces using react-query
  const { data: workspacesData, isLoading: workspacesLoading, refetch } = useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
    enabled: isAuthenticated,
    staleTime: 10000,
  })

  // Load recent skill runs using react-query
  const { data: skillRuns = [] } = useQuery<any[]>({
    queryKey: ['skillRuns', activeWorkspaceId],
    queryFn: () => api<any[]>(`/api/workspaces/${activeWorkspaceId}/skill-runs`),
    enabled: isAuthenticated && !!activeWorkspaceId,
    refetchInterval: 10000,
  })

  // Sync react-query cache with Zustand store
  useEffect(() => {
    if (workspacesData) {
      setWorkspaces(workspacesData)
      if (workspacesData.length > 0 && !activeWorkspaceId) {
        setActiveWorkspaceId(workspacesData[0].id)
      }
    }
  }, [workspacesData, setWorkspaces, activeWorkspaceId, setActiveWorkspaceId])

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/')
    }
  }, [authLoading, isAuthenticated, router])

  // Import mutation hook
  const importMutation = useImportRepository()

  // Polling for indexing status if any repo is currently indexing
  useEffect(() => {
    const hasIndexingRepos = workspaces
      .flatMap((w) => w.repositories)
      .some((r) => r.indexingStatus === 'PENDING' || r.indexingStatus === 'INDEXING')

    if (hasIndexingRepos) {
      const interval = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      }, 4000)
      return () => clearInterval(interval)
    }
  }, [workspaces, queryClient])

  if (authLoading || workspacesLoading) {
    return (
      <div className="flex min-h-screen flex-col">
        <Navbar />
        <div className="flex flex-1 gap-6 p-6">
          <div className="w-64 shrink-0 rounded-xl border border-border/50 bg-card/20 p-4">
            <Skeleton className="h-6 w-32 mb-4" />
            <Skeleton className="h-10 w-full mb-2" />
            <Skeleton className="h-10 w-full mb-2" />
            <Skeleton className="h-10 w-full mb-2" />
          </div>
          <div className="flex-1 space-y-6">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-10 w-36" />
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!user || workspaces.length === 0) return null

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0]
  const repositories = activeWorkspace.repositories || []

  const handleOpenImportModal = (prefillUrl?: string) => {
    if (prefillUrl) {
      setGithubUrlInput(prefillUrl)
    } else {
      setGithubUrlInput('')
    }
    setImportError(null)
    setIsModalOpen(true)
  }

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setImportError(null)

    if (!githubUrlInput.trim()) {
      setImportError('Please enter a GitHub repository URL')
      return
    }

    importMutation.mutate(
      {
        githubUrl: githubUrlInput,
        workspaceId: activeWorkspace.id,
      },
      {
        onSuccess: (newRepo) => {
          setIsModalOpen(false)
          setGithubUrlInput('')
          // Invalidate cache for this repo's status to avoid showing cached COMPLETED state
          queryClient.invalidateQueries({ queryKey: ['repository', newRepo.id] })
          // Automatically redirect to the repo view
          setActiveRepositoryId(newRepo.id)
          router.push(`/repository/${newRepo.id}`)
        },
        onError: (err: any) => {
          setImportError(err.message || 'Failed to import repository')
        },
      }
    )
  }

  const renderStatusBadge = (status: Repository['indexingStatus']) => {
    switch (status) {
      case 'PENDING':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2 py-1 text-xs font-medium text-yellow-500">
            <RefreshCw className="h-3 w-3 animate-spin" /> Pending
          </span>
        )
      case 'INDEXING':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-400">
            <RefreshCw className="h-3 w-3 animate-spin" /> Indexing
          </span>
        )
      case 'COMPLETED':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400">
            <CheckCircle className="h-3 w-3" /> Ready
          </span>
        )
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-400">
            <AlertTriangle className="h-3 w-3" /> Failed
          </span>
        )
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[oklch(0.08_0.02_260)] text-foreground">
      <Navbar />

      <div className="flex flex-1 flex-col gap-6 p-6 md:flex-row max-w-7xl mx-auto w-full">
        {/* Sidebar */}
        <aside className="w-full shrink-0 md:w-64 flex flex-col gap-4">
          <div className="rounded-xl border border-border/40 bg-card/20 p-4 backdrop-blur-md">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold tracking-tight text-muted-foreground uppercase">
                Active Workspace
              </span>
            </div>
            
            {/* Simple Workspace Dropdown (Static for default) */}
            <div className="w-full rounded-lg bg-secondary/30 px-3 py-2 text-sm font-medium border border-border/50">
              {activeWorkspace.name}
            </div>
          </div>

          <div className="flex-1 rounded-xl border border-border/40 bg-card/20 p-4 backdrop-blur-md flex flex-col min-h-[300px]">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold tracking-tight text-muted-foreground uppercase">
                Repositories ({repositories.length})
              </span>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => handleOpenImportModal()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto max-h-[400px] md:max-h-none pr-1">
              {repositories.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center p-4 text-xs text-muted-foreground">
                  <GitBranch className="h-8 w-8 text-muted-foreground/30 mb-2" />
                  No repos imported yet.
                </div>
              ) : (
                repositories.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => {
                      setActiveRepositoryId(repo.id)
                      router.push(`/repository/${repo.id}`)
                    }}
                    className="w-full flex flex-col text-left gap-1.5 p-3 rounded-lg border border-border/40 bg-card/10 hover:bg-card/40 hover:border-primary/30 transition-all group"
                  >
                    <span className="font-medium text-sm group-hover:text-primary transition-colors truncate">
                      {repo.name}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {repo.owner}/{repo.name}
                    </span>
                    <div className="mt-1 flex items-center justify-between w-full">
                      {renderStatusBadge(repo.indexingStatus)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 flex flex-col gap-6">
          {/* Welcome Dashboard / Header */}
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 rounded-xl border border-border/40 bg-card/20 p-6 backdrop-blur-md">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Welcome, {user.displayName || user.username}!
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Import codebases, search code semantically, and reason with context.
              </p>
            </div>
            <Button size="lg" className="gap-2 px-6 shadow-lg shadow-primary/20" onClick={() => handleOpenImportModal()}>
              <Plus className="h-5 w-5" />
              Import Repository
            </Button>
          </div>

          {/* Curated Repository Discovery Seed Cards */}
          <div>
            <h2 className="text-lg font-semibold mb-4 tracking-tight">
              Get Started with Curated Repositories
            </h2>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <CuratedCard
                title="Spoon-Knife"
                owner="octocat"
                description="The classic GitHub training repository containing simple index.html pages."
                url="https://github.com/octocat/Spoon-Knife"
                onImport={() => handleOpenImportModal('https://github.com/octocat/Spoon-Knife')}
              />
              <CuratedCard
                title="CORS Middleware"
                owner="expressjs"
                description="Node.js CORS middleware. A clean package to inspect CORS header handling."
                url="https://github.com/expressjs/cors"
                onImport={() => handleOpenImportModal('https://github.com/expressjs/cors')}
              />
              <CuratedCard
                title="Flux"
                owner="facebook"
                description="Small application architecture pattern implementation by Facebook."
                url="https://github.com/facebook/flux"
                onImport={() => handleOpenImportModal('https://github.com/facebook/flux')}
              />
            </div>
          </div>

          {/* Recent Bug Fixes History */}
          {skillRuns.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
                <Terminal className="h-5 w-5 text-primary" />
                Recent Bug Fix Attempts
              </h2>
              <div className="grid gap-3">
                {skillRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-border/40 bg-card/10 hover:bg-card/25 backdrop-blur-md transition-all"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground">
                          {run.repository?.name || 'Repository'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          ({run.repository?.owner})
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono line-clamp-1 max-w-xl">
                        Error: {run.input}
                      </p>
                      <span className="text-[10px] text-muted-foreground/60 block">
                        Attempted {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider ${
                          run.status === 'APPROVED'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : run.status === 'REJECTED'
                            ? 'bg-rose-500/10 text-rose-400'
                            : 'bg-yellow-500/10 text-yellow-500'
                        }`}
                      >
                        {run.status.toLowerCase()}
                      </span>

                      {run.prUrl && (
                        <a
                          href={run.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-secondary/80 hover:bg-secondary px-3 py-1.5 text-xs font-semibold text-primary border border-border transition-all"
                        >
                          View PR
                          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Custom Modal overlay */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in-0 duration-200">
          <div className="relative w-full max-w-lg rounded-xl border border-border/60 bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <h2 className="text-lg font-bold tracking-tight mb-2">Import Repository</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Enter the GitHub URL of the repository you want to import. We will download, chunk, and index the codebase.
            </p>

            <form onSubmit={handleImportSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  GitHub Repository URL
                </label>
                <input
                  type="text"
                  placeholder="https://github.com/owner/repository"
                  value={githubUrlInput}
                  onChange={(e) => setGithubUrlInput(e.target.value)}
                  disabled={importMutation.isPending}
                  className="w-full rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-sm focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50"
                />
              </div>

              {importError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400 flex gap-2 items-start">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{importError}</span>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsModalOpen(false)}
                  disabled={importMutation.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={importMutation.isPending} className="gap-2">
                  {importMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" /> Importing...
                    </>
                  ) : (
                    'Import & Index'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function CuratedCard({
  title,
  owner,
  description,
  url,
  onImport,
}: {
  title: string
  owner: string
  description: string
  url: string
  onImport: () => void
}) {
  return (
    <Card className="border border-border/40 bg-card/25 hover:border-primary/30 hover:bg-card/45 backdrop-blur-md transition-all flex flex-col h-full group">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5 text-xs text-primary mb-1">
          <Terminal className="h-3.5 w-3.5" /> {owner}
        </div>
        <CardTitle className="text-base group-hover:text-primary transition-colors">
          {title}
        </CardTitle>
        <CardDescription className="text-xs line-clamp-2 mt-1">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2 mt-auto flex justify-between items-center gap-2 border-t border-border/30">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline truncate max-w-[120px]"
        >
          {owner}/{title}
        </a>
        <Button size="sm" variant="secondary" className="text-xs h-7 gap-1" onClick={onImport}>
          <Plus className="h-3 w-3" /> Select
        </Button>
      </CardContent>
    </Card>
  )
}
