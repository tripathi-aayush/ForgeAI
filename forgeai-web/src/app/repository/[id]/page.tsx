'use client'

import { use, useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/use-auth'
import { Navbar } from '@/components/navbar'
import { api } from '@/lib/api'
import { useWorkspaceStore } from '@/lib/store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import ReactMarkdown from 'react-markdown'
import {
  ArrowLeft,
  AlertTriangle,
  Folder,
  FileCode,
  Send,
  Loader2,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Sparkles,
  ExternalLink,
  BookOpen,
  CheckCircle,
  GitPullRequest,
  FileText,
} from 'lucide-react'

// Tree node definition
interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

// Chat message definition
interface Message {
  id: string
  sender: 'user' | 'ai'
  text: string
  citations?: Array<{
    filePath: string
    startLine: number
    endLine: number
  }>
}

// Review comment from API
interface ReviewComment {
  filePath: string
  line: number
  severity: 'info' | 'warning' | 'critical'
  comment: string
}

/**
 * Convert flat array of file paths into a nested tree structure.
 */
function buildFileTree(files: Array<{ path: string }>): FileNode[] {
  const root: FileNode[] = []

  files.forEach((file) => {
    const parts = file.path.split('/')
    let currentLevel = root

    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1
      const currentPath = parts.slice(0, i + 1).join('/')

      let existingNode = currentLevel.find((node) => node.name === part)

      if (!existingNode) {
        existingNode = {
          name: part,
          path: currentPath,
          type: isLast ? 'file' : 'directory',
          children: isLast ? undefined : [],
        }
        currentLevel.push(existingNode)
      }

      if (!isLast && existingNode.children) {
        currentLevel = existingNode.children
      }
    })
  })

  // Sort: directories first, then alphabetically
  const sortTree = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((node) => {
      if (node.children) {
        sortTree(node.children)
      }
    })
  }

  sortTree(root)
  return root
}

/**
 * Detect language ID for Monaco editor from file path extension.
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'py':
      return 'python'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'cpp':
    case 'cc':
    case 'c':
    case 'h':
      return 'cpp'
    case 'cs':
      return 'csharp'
    case 'rs':
      return 'rust'
    case 'html':
      return 'html'
    case 'css':
      return 'css'
    case 'json':
      return 'json'
    case 'sh':
      return 'shell'
    case 'md':
      return 'markdown'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'toml':
      return 'toml'
    default:
      return 'plaintext'
  }
}

/**
 * Severity badge for review comments.
 */
function SeverityBadge({ severity }: { severity: ReviewComment['severity'] }) {
  const styles = {
    info: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    critical: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${styles[severity]}`}
    >
      {severity}
    </span>
  )
}

export default function RepositoryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: repoId } = use(params)
  const { user, isLoading: authLoading, isAuthenticated } = useAuth()
  const router = useRouter()
  const queryClient = useQueryClient()

  // Zustand selections
  const {
    activeFilePath,
    activeFileContent,
    setActiveFilePath,
    setActiveFileContent,
    activeBugfix,
    setActiveBugfix,
  } = useWorkspaceStore()

  // Component local states
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [chatMessages, setChatMessages] = useState<Message[]>([])
  const [questionInput, setQuestionInput] = useState('')
  const [isFileLoading, setIsFileLoading] = useState(false)
  const [isAsking, setIsAsking] = useState(false)

  // Drawer mode: ask | bugfix | review | docs
  const [drawerMode, setDrawerMode] = useState<'ask' | 'bugfix' | 'review' | 'docs'>('ask')

  // Bugfix mode states
  const [bugfixInput, setBugfixInput] = useState('')
  const [isDiagnosing, setIsDiagnosing] = useState(false)
  const [isEditingFix, setIsEditingFix] = useState(false)
  const [isApprovingOrRejecting, setIsApprovingOrRejecting] = useState(false)
  const [editedCode, setEditedCode] = useState<string | null>(null)

  // Code execution states (Phase 4)
  const [executionStatus, setExecutionStatus] = useState<'NOT_STARTED' | 'QUEUED' | 'RUNNING' | 'DONE'>('NOT_STARTED')
  const [executionResult, setExecutionResult] = useState<any>(null)
  const [executionAttempts, setExecutionAttempts] = useState(0)
  const [isPollingExecution, setIsPollingExecution] = useState(false)


  // Review mode states
  const [reviewInput, setReviewInput] = useState('')
  const [reviewInputType, setReviewInputType] = useState<'diff' | 'url'>('diff')
  const [isReviewing, setIsReviewing] = useState(false)
  const [reviewComments, setReviewComments] = useState<ReviewComment[] | null>(null)

  // Docs mode states
  const [isGeneratingDocs, setIsGeneratingDocs] = useState(false)
  const [docsRunId, setDocsRunId] = useState<string | null>(null)
  const [docsDraft, setDocsDraft] = useState<string | null>(null)
  const [isEditingDocs, setIsEditingDocs] = useState(false)
  const [editedDocs, setEditedDocs] = useState<string>('')
  const [isCommittingDocs, setIsCommittingDocs] = useState(false)
  const [docsPrUrl, setDocsPrUrl] = useState<string | null>(null)

  // Inline error/success notification state (replaces alert())
  const [skillError, setSkillError] = useState<string | null>(null)
  const [prSuccessUrl, setPrSuccessUrl] = useState<string | null>(null)

  const editorRef = useRef<any>(null)
  const diffEditorRef = useRef<any>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // ── Bugfix handlers ──────────────────────────────────────────────────────────

  const handleBugfixSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!bugfixInput.trim() || isDiagnosing) return

    setIsDiagnosing(true)
    try {
      const data = await api<any>(`/api/repositories/${repoId}/bugfix`, {
        method: 'POST',
        body: JSON.stringify({ errorMessage: bugfixInput.trim() }),
      })
      setActiveBugfix({
        id: data.id,
        confidence: data.confidence,
        diagnosis: data.diagnosis,
      })
      setEditedCode(null)
      setIsEditingFix(false)
      // Reset execution states
      setExecutionStatus('NOT_STARTED')
      setExecutionResult(null)
      setExecutionAttempts(0)
    } catch (err: any) {
      console.error('Bugfix diagnosis failed:', err)
      setSkillError(`Diagnosis failed: ${err.message}`)
    } finally {
      setIsDiagnosing(false)
    }
  }

  const handleApproveFix = async () => {
    if (!activeBugfix) return
    setIsApprovingOrRejecting(true)
    try {
      let finalCode = activeBugfix.diagnosis.proposedCode
      if (diffEditorRef.current) {
        finalCode = diffEditorRef.current.getModifiedEditor().getValue()
      }

      const res = await api<{ status: string; prUrl: string }>(
        `/api/repositories/${repoId}/bugfix/${activeBugfix.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ editedCode: finalCode }),
        }
      )

      setPrSuccessUrl(res.prUrl)
      setActiveBugfix(null)
      setBugfixInput('')
      setDrawerMode('ask')
      // Reset execution states
      setExecutionStatus('NOT_STARTED')
      setExecutionResult(null)
      setExecutionAttempts(0)
      queryClient.invalidateQueries({ queryKey: ['repository', repoId] })
    } catch (err: any) {
      console.error('Approval failed:', err)
      setSkillError(`Approval failed: ${err.message}`)
    } finally {
      setIsApprovingOrRejecting(false)
    }
  }

  const handleRejectFix = async () => {
    if (!activeBugfix) return
    setIsApprovingOrRejecting(true)
    try {
      await api(`/api/repositories/${repoId}/bugfix/${activeBugfix.id}/reject`, {
        method: 'POST',
      })
      setActiveBugfix(null)
      setEditedCode(null)
      setIsEditingFix(false)
      // Reset execution states
      setExecutionStatus('NOT_STARTED')
      setExecutionResult(null)
      setExecutionAttempts(0)
    } catch (err: any) {
      console.error('Rejection failed:', err)
      setSkillError(`Rejection failed: ${err.message}`)
    } finally {
      setIsApprovingOrRejecting(false)
    }
  }

  const handleTestFix = async () => {
    if (!activeBugfix || isPollingExecution) return
    setIsPollingExecution(true)
    setExecutionStatus('QUEUED')
    setExecutionResult(null)

    try {
      const data = await api<{ status: string; jobId?: string; reason?: string }>(
        `/api/repositories/${repoId}/bugfix/${activeBugfix.id}/execute`,
        { method: 'POST' }
      )

      if (data.status === 'skipped') {
        setExecutionStatus('DONE')
        setExecutionResult({
          passed: false,
          stdout: null,
          stderr: data.reason || 'Execution sandbox not configured',
          exitCode: null,
          status: 'Skipped',
        })
        setIsPollingExecution(false)
        return
      }

      // Start polling loop every 2 seconds
      let pollCount = 0
      // No hard client timeout — the backend guarantees DONE eventually.
      // A soft warning is shown at 45s (see inside interval).

      const interval = setInterval(async () => {
        pollCount++
        // ── Soft slow-warning: keep polling until backend confirms DONE ──────
        // The backend worst-case (Judge0 25s + Piston fallback ~10s + BullMQ
        // overhead) can exceed the old 40s hard client cap. Instead of
        // fabricating a "Timeout" failure, surface a warning after 45s and
        // keep polling — the backend is guaranteed to write DONE eventually.
        const SLOW_WARNING_AFTER_MS = 45_000
        const POLL_INTERVAL_MS = 2000
        if (pollCount * POLL_INTERVAL_MS >= SLOW_WARNING_AFTER_MS && !executionResult) {
          setSkillError(
            'Still processing \u2014 this is taking longer than usual. The backend is still running; please wait.'
          )
        }

        try {
          const statusRes = await api<{
            executionStatus: 'NOT_STARTED' | 'QUEUED' | 'RUNNING' | 'DONE'
            executionResult: any
            attemptCount: number
            proposedDiff?: any
          }>(`/api/repositories/${repoId}/bugfix/${activeBugfix.id}/execution-status`)

          setExecutionStatus(statusRes.executionStatus)
          setExecutionAttempts(statusRes.attemptCount)

          // If a re-diagnosis happened (proposedDiff updated on backend), sync it to editor/UI
          if (statusRes.proposedDiff) {
            setActiveBugfix({
              id: activeBugfix.id,
              confidence: activeBugfix.confidence,
              diagnosis: statusRes.proposedDiff,
            })
          }

          if (statusRes.executionStatus === 'DONE') {
            clearInterval(interval)
            setExecutionResult(statusRes.executionResult)
            setIsPollingExecution(false)
          }
        } catch (pollErr) {
          console.error('Error polling execution status:', pollErr)
        }
      }, 2000)
    } catch (err: any) {
      console.error('Failed to trigger execution:', err)
      setSkillError(`Failed to trigger execution: ${err.message}`)
      setExecutionStatus('NOT_STARTED')
      setIsPollingExecution(false)
    }
  }


  // ── Review handlers ──────────────────────────────────────────────────────────

  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reviewInput.trim() || isReviewing) return

    setIsReviewing(true)
    setReviewComments(null)
    try {
      const body =
        reviewInputType === 'url'
          ? { prUrl: reviewInput.trim() }
          : { diff: reviewInput.trim() }

      const data = await api<{ id: string; comments: ReviewComment[]; commentCount: number }>(
        `/api/repositories/${repoId}/review`,
        { method: 'POST', body: JSON.stringify(body) }
      )
      setReviewComments(data.comments)
    } catch (err: any) {
      console.error('Review failed:', err)
      setSkillError(`Review failed: ${err.message}`)
    } finally {
      setIsReviewing(false)
    }
  }

  // ── Docs handlers ────────────────────────────────────────────────────────────

  const handleGenerateDocs = async () => {
    if (isGeneratingDocs) return
    setIsGeneratingDocs(true)
    setDocsDraft(null)
    setDocsRunId(null)
    setDocsPrUrl(null)
    setIsEditingDocs(false)
    try {
      const data = await api<{ id: string; draft: string }>(
        `/api/repositories/${repoId}/docs`,
        { method: 'POST', body: JSON.stringify({}) }
      )
      setDocsRunId(data.id)
      setDocsDraft(data.draft)
      setEditedDocs(data.draft)
    } catch (err: any) {
      console.error('Docs generation failed:', err)
      setSkillError(`Documentation generation failed: ${err.message}`)
    } finally {
      setIsGeneratingDocs(false)
    }
  }

  const handleCommitDocs = async () => {
    if (!docsRunId || isCommittingDocs) return
    setIsCommittingDocs(true)
    try {
      const contentToCommit = isEditingDocs ? editedDocs : (docsDraft || '')
      const data = await api<{ status: string; prUrl: string; branchName: string }>(
        `/api/repositories/${repoId}/docs/${docsRunId}/commit`,
        { method: 'POST', body: JSON.stringify({ editedContent: contentToCommit }) }
      )
      setDocsPrUrl(data.prUrl)
    } catch (err: any) {
      console.error('Docs commit failed:', err)
      setSkillError(`Commit failed: ${err.message}`)
    } finally {
      setIsCommittingDocs(false)
    }
  }

  // ── Shared queries ────────────────────────────────────────────────────────────

  // Fetch repository metadata
  const { data: repo, isLoading: repoLoading } = useQuery({
    queryKey: ['repository', repoId],
    queryFn: () => api<any>(`/api/repositories/${repoId}/status`),
    enabled: isAuthenticated,
    refetchInterval: (query) => {
      const data = query.state.data as any
      if (data && (data.indexingStatus === 'INDEXING' || data.indexingStatus === 'PENDING')) {
        return 3000
      }
      return false
    },
  })

  // Fetch repository file tree list
  const { data: files = [], isLoading: filesLoading } = useQuery({
    queryKey: ['repository', repoId, 'files'],
    queryFn: () => api<any[]>(`/api/repositories/${repoId}/files`),
    enabled: isAuthenticated && repo?.indexingStatus !== 'FAILED',
  })

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, isAsking])

  // Redirect if unauthorized
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/')
    }
  }, [authLoading, isAuthenticated, router])

  // Toggle folder collapse state
  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }))
  }

  // Load file content when file node is clicked
  const handleFileClick = async (filePath: string) => {
    setIsFileLoading(true)
    setActiveFilePath(filePath)
    setActiveFileContent(null)

    try {
      const data = await api<{ content: string }>(
        `/api/repositories/${repoId}/files/content?path=${encodeURIComponent(filePath)}`
      )
      setActiveFileContent(data.content)
    } catch (err: any) {
      console.error('Failed to load file content:', err)
      setActiveFileContent(`// Error loading file: ${err.message}`)
    } finally {
      setIsFileLoading(false)
    }
  }

  // Handle RAG Ask query
  const handleAskSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!questionInput.trim() || isAsking) return

    const question = questionInput.trim()
    setQuestionInput('')

    const userMsgId = `user_${Date.now()}`
    const userMsg: Message = { id: userMsgId, sender: 'user', text: question }
    setChatMessages((prev) => [...prev, userMsg])

    setIsAsking(true)

    try {
      const data = await api<{ answer: string; citations: any[] }>(
        `/api/repositories/${repoId}/ask`,
        {
          method: 'POST',
          body: JSON.stringify({ question }),
        }
      )

      const aiMsg: Message = {
        id: `ai_${Date.now()}`,
        sender: 'ai',
        text: data.answer,
        citations: data.citations,
      }
      setChatMessages((prev) => [...prev, aiMsg])
    } catch (error: any) {
      console.error('RAG request failed:', error)
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          sender: 'ai',
          text: `⚠️ Query failed: ${error.message}. Please verify the indexing status and try again.`,
        },
      ])
    } finally {
      setIsAsking(false)
    }
  }

  // Helper to open citation file and highlight lines
  const handleCitationClick = async (filePath: string, startLine: number, endLine: number) => {
    await handleFileClick(filePath)

    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.revealLineInCenter(startLine)
        editorRef.current.setSelection({
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: endLine,
          endColumn: 100,
        })
      }
    }, 600)
  }

  // File tree rendering helper (Recursive)
  const renderTree = (nodes: FileNode[]) => {
    return nodes.map((node) => {
      const isCollapsed = collapsedFolders[node.path]
      const isSelected = activeFilePath === node.path

      if (node.type === 'directory') {
        return (
          <div key={node.path} className="select-none">
            <button
              onClick={() => toggleFolder(node.path)}
              className="w-full flex items-center gap-1.5 py-1 px-2 hover:bg-secondary/30 text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0" />
              )}
              <Folder className="h-4 w-4 shrink-0 text-sky-400" />
              <span className="truncate">{node.name}</span>
            </button>
            {!isCollapsed && node.children && (
              <div className="pl-4 border-l border-border/20 ml-3">
                {renderTree(node.children)}
              </div>
            )}
          </div>
        )
      } else {
        return (
          <button
            key={node.path}
            onClick={() => handleFileClick(node.path)}
            className={`w-full flex items-center gap-2 py-1.5 px-3 text-xs border-l-2 hover:bg-secondary/40 text-left transition-all ${
              isSelected
                ? 'border-primary bg-primary/10 text-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileCode className={`h-4 w-4 shrink-0 ${isSelected ? 'text-primary' : 'text-muted-foreground/60'}`} />
            <span className="truncate">{node.name}</span>
          </button>
        )
      }
    })
  }

  const fileTree = buildFileTree(files)

  // Group review comments by filePath
  const groupedComments =
    reviewComments?.reduce<Record<string, ReviewComment[]>>((acc, c) => {
      if (!acc[c.filePath]) acc[c.filePath] = []
      acc[c.filePath].push(c)
      return acc
    }, {}) ?? {}

  if (authLoading || repoLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-[oklch(0.08_0.02_260)]">
        <Navbar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Loading workspace details...</span>
          </div>
        </div>
      </div>
    )
  }

  if (!repo) return null

  const isIndexing = repo.indexingStatus === 'PENDING' || repo.indexingStatus === 'INDEXING'

  return (
    <div className="flex min-h-screen flex-col bg-[oklch(0.08_0.02_260)] text-foreground">
      {/* Workspace Header */}
      <header className="flex h-14 items-center justify-between border-b border-border/40 bg-card/25 px-6 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => router.push('/dashboard')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm md:text-base">{repo.name}</span>
            <span className="text-xs text-muted-foreground hidden md:inline">({repo.owner})</span>
          </div>
          {isIndexing ? (
            <div className="flex items-center gap-2 rounded-full bg-blue-500/10 px-2.5 py-1 text-xs text-blue-400 font-medium">
              <Loader2 className="h-3 w-3 animate-spin" /> Indexing codebase...
            </div>
          ) : repo.indexingStatus === 'FAILED' ? (
            <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-xs text-rose-400 font-medium">
              Indexing Failed
            </span>
          ) : (
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400 font-medium flex items-center gap-1">
              <CheckCircle className="h-3 w-3" /> Indexed &amp; Ready
            </span>
          )}
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden h-[calc(100vh-3.5rem)]">
        {/* Left Sidebar - File Tree */}
        <aside className="w-64 border-r border-border/40 bg-card/10 flex flex-col shrink-0">
          <div className="p-3 border-b border-border/30 flex items-center justify-between bg-card/5">
            <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Files Explorer
            </span>
          </div>
          <div className="flex-1 overflow-y-auto py-2 pr-1 font-mono">
            {filesLoading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : files.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground text-center">
                No files found or indexing not complete.
              </div>
            ) : (
              renderTree(fileTree)
            )}
          </div>
        </aside>

        {/* Center Panel - Monaco Editor */}
        <main className="flex-1 border-r border-border/40 flex flex-col bg-zinc-950/20 overflow-hidden relative">
          <div className="h-9 border-b border-border/30 bg-card/15 px-4 flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono truncate">
              {activeBugfix !== null ? `Diff: ${activeBugfix.diagnosis.filePath}` : (activeFilePath || 'Select a file to view code')}
            </span>
          </div>

          <div className="flex-1 relative">
            {activeBugfix !== null ? (
              <DiffEditor
                height="100%"
                theme="vs-dark"
                original={activeBugfix.diagnosis.originalCode}
                modified={activeBugfix.diagnosis.proposedCode}
                language={getLanguageFromPath(activeBugfix.diagnosis.filePath)}
                options={{
                  readOnly: !isEditingFix,
                  fontSize: 13,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  padding: { top: 12 },
                }}
                onMount={(editor) => {
                  diffEditorRef.current = editor
                }}
              />
            ) : isFileLoading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/40 z-10">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : activeFileContent === null ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground bg-zinc-950/25 p-6 text-center">
                <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <h3 className="font-semibold text-sm">No File Selected</h3>
                <p className="text-xs text-muted-foreground/80 mt-1 max-w-xs">
                  Choose a file from the explorer sidebar to view its code content in the Monaco editor.
                </p>
              </div>
            ) : (
              <Editor
                height="100%"
                theme="vs-dark"
                path={activeFilePath || ''}
                language={activeFilePath ? getLanguageFromPath(activeFilePath) : 'plaintext'}
                value={activeFileContent}
                options={{
                  readOnly: true,
                  fontSize: 13,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  padding: { top: 12 },
                }}
                onMount={(editor) => {
                  editorRef.current = editor
                }}
              />
            )}
          </div>
        </main>

        {/* Right Panel - Multi-mode Skill Drawer */}
        <aside className="w-[380px] flex flex-col bg-card/10 shrink-0">
          <div className="p-3 border-b border-border/30 flex flex-col gap-2 bg-card/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary animate-pulse" />
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {activeBugfix !== null
                    ? 'Fix Proposal'
                    : drawerMode === 'ask'
                    ? 'Ask ForgeAI'
                    : drawerMode === 'bugfix'
                    ? 'Fix a Bug'
                    : drawerMode === 'review'
                    ? 'Code Review'
                    : 'Generate Docs'}
                </span>
              </div>
            </div>
            {/* 4-tab mode toggle — hidden when a bugfix proposal is active */}
            {activeBugfix === null && (
              <div className="grid grid-cols-4 gap-0.5 bg-secondary/20 p-0.5 rounded-lg border border-border/40">
                {(['ask', 'bugfix', 'review', 'docs'] as const).map((mode) => {
                  const labels: Record<string, string> = {
                    ask: 'Ask',
                    bugfix: 'Fix Bug',
                    review: 'Review',
                    docs: 'Docs',
                  }
                  return (
                    <button
                      key={mode}
                      onClick={() => setDrawerMode(mode)}
                      className={`py-1 text-[9px] font-semibold uppercase tracking-wider rounded-md transition-all ${
                        drawerMode === mode
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {labels[mode]}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Inline error / success banners (replaces alert()) ─────────────── */}
          {skillError && (
            <div className="mx-3 mb-0 mt-2 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="flex-1 leading-relaxed">{skillError}</span>
              <button
                onClick={() => setSkillError(null)}
                className="ml-1 shrink-0 opacity-60 hover:opacity-100 transition-opacity text-rose-300"
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}
          {prSuccessUrl && (
            <div className="mx-3 mb-0 mt-2 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-400">
              <CheckCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="flex-1 leading-relaxed">
                Pull request opened successfully!{' '}
                <a
                  href={prSuccessUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 font-semibold hover:text-emerald-300"
                >
                  View PR →
                </a>
              </span>
              <button
                onClick={() => setPrSuccessUrl(null)}
                className="ml-1 shrink-0 opacity-60 hover:opacity-100 transition-opacity text-emerald-300"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}

          {/* ── Bugfix Proposal Active View ─────────────────────────────── */}
          {activeBugfix !== null ? (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="rounded-xl border border-border/40 bg-secondary/25 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                      Proposed Fix
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                        activeBugfix.confidence === 'verified'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-amber-500/10 text-amber-400'
                      }`}
                    >
                      {activeBugfix.confidence === 'verified' ? 'Verified Match' : 'Low Confidence Match'}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-foreground block truncate">
                      File: {activeBugfix.diagnosis.filePath}
                    </span>
                    <span className="text-[10px] text-muted-foreground block font-mono">
                      Lines {activeBugfix.diagnosis.startLine}–{activeBugfix.diagnosis.endLine}
                    </span>
                  </div>

                  <div className="pt-2 border-t border-border/20">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider block mb-1">
                      Explanation
                    </span>
                    <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                      {activeBugfix.diagnosis.explanation}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/40 bg-secondary/10 p-4 space-y-2">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider block">
                    Instructions
                  </span>
                  <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4 leading-relaxed">
                    <li>Review the original code vs proposed fix in the editor.</li>
                    <li>Click <strong>Edit Fix</strong> to modify the proposed code in the right pane of the diff editor.</li>
                    <li>Click <strong>Approve &amp; Open PR</strong> to commit the fix and open a branch on GitHub.</li>
                  </ul>
                </div>

                {/* ── Execution sandbox panel (Phase 4) ── */}
                <div className="rounded-xl border border-border/40 bg-secondary/15 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                      Sandbox Testing
                    </span>
                    {executionStatus === 'DONE' && (
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          executionResult?.passed
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}
                      >
                        {executionResult?.passed ? 'Passed' : 'Failed'}
                      </span>
                    )}
                  </div>

                  {executionStatus === 'NOT_STARTED' && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Test the proposed fix inside our isolated execution sandbox before committing.
                      </p>
                      <Button
                        onClick={handleTestFix}
                        className="w-full text-xs font-semibold bg-primary hover:bg-primary/95 text-primary-foreground"
                      >
                        Run Sandbox Test
                      </Button>
                    </div>
                  )}

                  {(executionStatus === 'QUEUED' || executionStatus === 'RUNNING') && (
                    <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      <span>
                        {executionStatus === 'QUEUED'
                          ? 'Enqueued in sandbox queue...'
                          : `Running test in sandbox (Attempt ${executionAttempts}/2)...`}
                      </span>
                    </div>
                  )}

                  {executionStatus === 'DONE' && (
                    <div className="space-y-3 text-xs">
                      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                        <span>Status: {executionResult?.status || 'Unknown'}</span>
                        <span>Exit Code: {executionResult?.exitCode ?? 'N/A'}</span>
                      </div>

                      {executionResult?.executedVia && (
                        <div className="text-[10px] text-muted-foreground font-mono">
                          Backend: <span className="uppercase text-primary font-semibold">{executionResult.executedVia}</span>
                        </div>
                      )}

                      {executionResult?.capReached && (
                        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2.5 text-[11px] text-amber-400 leading-normal">
                          ⚠️ {executionResult.note || 'Attempt cap reached.'}
                        </div>
                      )}

                      {executionResult?.stdout && (
                        <div className="space-y-1">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">stdout</span>
                          <pre className="max-h-32 overflow-y-auto rounded bg-zinc-950 p-2 text-[10px] font-mono text-zinc-300 whitespace-pre-wrap">
                            {executionResult.stdout}
                          </pre>
                        </div>
                      )}

                      {executionResult?.stderr && (
                        <div className="space-y-1">
                          <span className="text-[10px] font-semibold text-rose-400 uppercase tracking-wider">stderr / compile output</span>
                          <pre className="max-h-32 overflow-y-auto rounded bg-rose-950/20 border border-rose-900/30 p-2 text-[10px] font-mono text-rose-300 whitespace-pre-wrap">
                            {executionResult.stderr}
                          </pre>
                        </div>
                      )}

                      {!executionResult?.stdout && !executionResult?.stderr && (
                        <p className="text-xs text-muted-foreground italic">No output returned.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>


              {/* Action Buttons */}
              <div className="p-3 border-t border-border/30 bg-card/5 space-y-2">
                {isApprovingOrRejecting ? (
                  <div className="flex items-center justify-center py-2 text-xs text-muted-foreground gap-2 font-medium">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    Executing Git operations...
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant={isEditingFix ? 'default' : 'secondary'}
                        onClick={() => setIsEditingFix(!isEditingFix)}
                        className="text-xs font-semibold"
                      >
                        {isEditingFix ? 'Lock Changes' : 'Edit Fix'}
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handleRejectFix}
                        className="text-xs font-semibold"
                      >
                        Reject
                      </Button>
                    </div>
                    <Button
                      onClick={handleApproveFix}
                      className="w-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      Approve &amp; Open PR
                    </Button>
                  </>
                )}
              </div>
            </div>

          /* ── Bug Fix Submission View ─────────────────────────────────── */
          ) : drawerMode === 'bugfix' ? (
            <div className="flex-1 flex flex-col justify-between p-4 space-y-4">
              <div className="flex-1 flex flex-col justify-center text-center text-muted-foreground space-y-4">
                <div className="flex justify-center">
                  <MessageSquare className="h-12 w-12 text-muted-foreground/20" />
                </div>
                <h3 className="font-semibold text-sm text-foreground/80">Automated Bug Fixer</h3>
                <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px] mx-auto">
                  Paste an error message, stack trace, or compiler warning. ForgeAI will search the codebase, locate the issue, and propose a validated single-file PR.
                </p>
              </div>
              <form onSubmit={handleBugfixSubmit} className="space-y-3">
                <textarea
                  placeholder="Paste error logs or describe the bug here..."
                  value={bugfixInput}
                  onChange={(e) => setBugfixInput(e.target.value)}
                  disabled={isDiagnosing}
                  rows={6}
                  className="w-full rounded-lg border border-border/60 bg-secondary/20 p-3 text-xs md:text-sm focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50 font-mono resize-none"
                />
                <Button
                  type="submit"
                  disabled={isDiagnosing || !bugfixInput.trim()}
                  className="w-full text-xs font-semibold"
                >
                  {isDiagnosing ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Diagnosing Codebase...
                    </>
                  ) : (
                    'Diagnose & Propose Fix'
                  )}
                </Button>
              </form>
            </div>

          /* ── Code Review Mode ────────────────────────────────────────── */
          ) : drawerMode === 'review' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {reviewComments === null ? (
                /* Review input form */
                <div className="flex-1 flex flex-col justify-between p-4 space-y-4">
                  <div className="flex-1 flex flex-col justify-center text-center text-muted-foreground space-y-4">
                    <div className="flex justify-center">
                      <GitPullRequest className="h-12 w-12 text-muted-foreground/20" />
                    </div>
                    <h3 className="font-semibold text-sm text-foreground/80">AI Code Review</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px] mx-auto">
                      Paste a Git diff or a GitHub PR URL. ForgeAI will analyze the changes in context and return structured feedback.
                    </p>
                  </div>
                  <form onSubmit={handleReviewSubmit} className="space-y-3">
                    {/* Input type toggle */}
                    <div className="grid grid-cols-2 gap-1 bg-secondary/20 p-0.5 rounded-lg border border-border/40">
                      {(['diff', 'url'] as const).map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => { setReviewInputType(type); setReviewInput('') }}
                          className={`py-1 text-[9px] font-semibold uppercase tracking-wider rounded-md transition-all ${
                            reviewInputType === type
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {type === 'diff' ? 'Paste Diff' : 'PR URL'}
                        </button>
                      ))}
                    </div>

                    {reviewInputType === 'diff' ? (
                      <textarea
                        placeholder="Paste git diff output here..."
                        value={reviewInput}
                        onChange={(e) => setReviewInput(e.target.value)}
                        disabled={isReviewing}
                        rows={7}
                        className="w-full rounded-lg border border-border/60 bg-secondary/20 p-3 text-xs focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50 font-mono resize-none"
                      />
                    ) : (
                      <input
                        type="url"
                        placeholder="https://github.com/owner/repo/pull/123"
                        value={reviewInput}
                        onChange={(e) => setReviewInput(e.target.value)}
                        disabled={isReviewing}
                        className="w-full rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50"
                      />
                    )}

                    <Button
                      type="submit"
                      disabled={isReviewing || !reviewInput.trim()}
                      className="w-full text-xs font-semibold"
                    >
                      {isReviewing ? (
                        <>
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          Analyzing Diff...
                        </>
                      ) : (
                        'Analyze Diff'
                      )}
                    </Button>
                  </form>
                </div>
              ) : (
                /* Review results */
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between px-4 pt-3 pb-2">
                    <span className="text-xs font-semibold text-foreground/80">
                      {reviewComments.length === 0
                        ? 'No issues found ✅'
                        : `${reviewComments.length} comment${reviewComments.length !== 1 ? 's' : ''}`}
                    </span>
                    <button
                      onClick={() => { setReviewComments(null); setReviewInput('') }}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      ← New review
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-4">
                    {reviewComments.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground text-xs">
                        LGTM! No issues detected in this diff.
                      </div>
                    ) : (
                      Object.entries(groupedComments).map(([filePath, comments]) => (
                        <div key={filePath} className="space-y-2">
                          <div className="text-[10px] font-mono font-semibold text-primary/80 truncate bg-primary/5 px-2 py-1 rounded border border-primary/10">
                            {filePath}
                          </div>
                          {comments.map((c, i) => (
                            <div
                              key={i}
                              className="rounded-lg border border-border/40 bg-secondary/15 p-3 space-y-1.5"
                            >
                              <div className="flex items-center justify-between">
                                <SeverityBadge severity={c.severity} />
                                <span className="text-[9px] font-mono text-muted-foreground">
                                  line {c.line}
                                </span>
                              </div>
                              <p className="text-xs text-foreground leading-relaxed">{c.comment}</p>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

          /* ── Documentation Mode ──────────────────────────────────────── */
          ) : drawerMode === 'docs' ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {docsDraft === null ? (
                /* Docs generation start */
                <div className="flex-1 flex flex-col justify-between p-4 space-y-4">
                  <div className="flex-1 flex flex-col justify-center text-center text-muted-foreground space-y-4">
                    <div className="flex justify-center">
                      <FileText className="h-12 w-12 text-muted-foreground/20" />
                    </div>
                    <h3 className="font-semibold text-sm text-foreground/80">Generate README</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px] mx-auto">
                      ForgeAI will analyze the repository structure, manifest file, and key source files to draft a professional README.md.
                    </p>
                  </div>
                  <Button
                    onClick={handleGenerateDocs}
                    disabled={isGeneratingDocs || isIndexing}
                    className="w-full text-xs font-semibold"
                  >
                    {isGeneratingDocs ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Generating README...
                      </>
                    ) : (
                      'Generate README'
                    )}
                  </Button>
                </div>
              ) : docsPrUrl ? (
                /* Docs committed — PR opened */
                <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
                  <CheckCircle className="h-12 w-12 text-emerald-400" />
                  <div className="space-y-1">
                    <h3 className="font-semibold text-sm text-foreground">Pull Request Opened!</h3>
                    <p className="text-xs text-muted-foreground">
                      README.md has been committed and a PR is ready for review.
                    </p>
                  </div>
                  <a
                    href={docsPrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    View Pull Request
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <button
                    onClick={() => {
                      setDocsDraft(null)
                      setDocsRunId(null)
                      setDocsPrUrl(null)
                      setIsEditingDocs(false)
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Generate another
                  </button>
                </div>
              ) : (
                /* Docs draft view with edit and commit */
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border/20">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {isEditingDocs ? 'Editing Draft' : 'README Preview'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (isEditingDocs) setDocsDraft(editedDocs)
                          setIsEditingDocs(!isEditingDocs)
                        }}
                        className="text-[10px] text-primary hover:text-primary/80 font-semibold transition-colors"
                      >
                        {isEditingDocs ? 'Preview' : 'Edit'}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto px-4 py-3">
                    {isEditingDocs ? (
                      <textarea
                        value={editedDocs}
                        onChange={(e) => setEditedDocs(e.target.value)}
                        className="w-full h-full min-h-[300px] rounded-lg border border-border/60 bg-secondary/20 p-3 text-xs font-mono focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all resize-none"
                      />
                    ) : (
                      <div className="prose prose-invert prose-sm max-w-none text-xs leading-relaxed [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-xs [&>code]:text-[10px] [&>pre]:text-[10px]">
                        <ReactMarkdown>{docsDraft || ''}</ReactMarkdown>
                      </div>
                    )}
                  </div>

                  <div className="p-3 border-t border-border/30 bg-card/5">
                    <Button
                      onClick={handleCommitDocs}
                      disabled={isCommittingDocs}
                      className="w-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      {isCommittingDocs ? (
                        <>
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          Committing to Repo...
                        </>
                      ) : (
                        'Commit to Repo & Open PR'
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

          ) : (
            /* ── Q&A Ask View ─────────────────────────────────────────── */
            <>
              {/* Messages list */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground p-6">
                    <MessageSquare className="h-12 w-12 text-muted-foreground/20 mb-3" />
                    <h3 className="font-semibold text-sm text-foreground/80">Semantic reasoning</h3>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
                      Type questions in plain English to search semantically and get answers compiled from files across the entire repository.
                    </p>
                  </div>
                ) : (
                  chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col gap-1.5 max-w-[85%] ${
                        msg.sender === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                      }`}
                    >
                      <span className="text-[10px] font-medium text-muted-foreground tracking-wider uppercase">
                        {msg.sender === 'user' ? 'You' : 'ForgeAI'}
                      </span>
                      <div
                        className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                          msg.sender === 'user'
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'bg-secondary/40 border border-border/40 text-foreground'
                        }`}
                      >
                        <div className="whitespace-pre-wrap font-sans text-xs md:text-sm">{msg.text}</div>

                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-border/40 space-y-1.5">
                            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider block">
                              Retrieved Context:
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {msg.citations.map((cite, i) => (
                                <button
                                  key={i}
                                  onClick={() =>
                                    handleCitationClick(
                                      cite.filePath,
                                      cite.startLine,
                                      cite.endLine
                                    )
                                  }
                                  className="inline-flex items-center gap-1 rounded bg-secondary/85 hover:bg-secondary px-2 py-0.5 text-[10px] font-mono text-primary border border-border hover:border-primary/30 transition-all"
                                >
                                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                                  {cite.filePath.split('/').pop()}:{cite.startLine}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                {isAsking && (
                  <div className="flex flex-col gap-1.5 mr-auto items-start max-w-[85%]">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      ForgeAI
                    </span>
                    <div className="rounded-xl px-3.5 py-2.5 text-sm bg-secondary/30 border border-border/40 text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      Generating context answers...
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Ask inputs */}
              <form
                onSubmit={handleAskSubmit}
                className="p-3 border-t border-border/30 bg-card/5 flex gap-2"
              >
                <input
                  type="text"
                  placeholder={isIndexing ? 'Indexing in progress...' : 'Ask about this repo...'}
                  value={questionInput}
                  onChange={(e) => setQuestionInput(e.target.value)}
                  disabled={isAsking || isIndexing}
                  className="flex-1 rounded-lg border border-border/60 bg-secondary/20 px-3 py-1.5 text-xs md:text-sm focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all disabled:opacity-50"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  disabled={isAsking || isIndexing || !questionInput.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
