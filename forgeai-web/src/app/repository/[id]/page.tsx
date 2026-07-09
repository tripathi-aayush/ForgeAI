'use client'

import { use, useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/use-auth'
import { Navbar } from '@/components/navbar'
import { api } from '@/lib/api'
import { useWorkspaceStore } from '@/lib/store'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ArrowLeft,
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
  
  // Bugfix mode states
  const [drawerMode, setDrawerMode] = useState<'ask' | 'bugfix'>('ask')
  const [bugfixInput, setBugfixInput] = useState('')
  const [isDiagnosing, setIsDiagnosing] = useState(false)
  const [isEditingFix, setIsEditingFix] = useState(false)
  const [isApprovingOrRejecting, setIsApprovingOrRejecting] = useState(false)
  const [editedCode, setEditedCode] = useState<string | null>(null)
  
  const editorRef = useRef<any>(null)
  const diffEditorRef = useRef<any>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

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
    } catch (err: any) {
      console.error('Bugfix diagnosis failed:', err)
      alert(`Diagnosis failed: ${err.message}`)
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

      alert(`Success! Pull request opened: ${res.prUrl}`)
      setActiveBugfix(null)
      setBugfixInput('')
      setDrawerMode('ask')
      queryClient.invalidateQueries({ queryKey: ['repository', repoId] })
    } catch (err: any) {
      console.error('Approval failed:', err)
      alert(`Approval failed: ${err.message}`)
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
    } catch (err: any) {
      console.error('Rejection failed:', err)
      alert(`Rejection failed: ${err.message}`)
    } finally {
      setIsApprovingOrRejecting(false)
    }
  }


  // Fetch repository metadata
  const { data: repo, isLoading: repoLoading } = useQuery({
    queryKey: ['repository', repoId],
    queryFn: () => api<any>(`/api/repositories/${repoId}/status`),
    enabled: isAuthenticated,
    refetchInterval: (query) => {
      // Poll faster if indexing is not completed yet
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

    // Append user message
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

      // Append AI response with citations
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
    
    // Attempt to select lines in Monaco Editor when loaded
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

  // Render headers loading states
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

        {/* Right Panel - RAG Q&A or Bug Fix Drawer */}
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
                    : 'Fix a Bug'}
                </span>
              </div>
            </div>
            {activeBugfix === null && (
              <div className="grid grid-cols-2 gap-1 bg-secondary/20 p-0.5 rounded-lg border border-border/40">
                <button
                  onClick={() => setDrawerMode('ask')}
                  className={`py-1 text-[10px] font-semibold uppercase tracking-wider rounded-md transition-all ${
                    drawerMode === 'ask'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Ask Q&A
                </button>
                <button
                  onClick={() => setDrawerMode('bugfix')}
                  className={`py-1 text-[10px] font-semibold uppercase tracking-wider rounded-md transition-all ${
                    drawerMode === 'bugfix'
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Fix a Bug
                </button>
              </div>
            )}
          </div>

          {activeBugfix !== null ? (
            /* Bugfix Proposal Active View */
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
          ) : drawerMode === 'bugfix' ? (
            /* Bugfix Submission View */
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
          ) : (
            /* Q&A Ask View */
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
                        {/* Render message body text */}
                        <div className="whitespace-pre-wrap font-sans text-xs md:text-sm">{msg.text}</div>

                        {/* Citations references */}
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

