import { create } from 'zustand'

export interface User {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  email: string | null
  createdAt: string
}

interface AuthState {
  user: User | null
  isLoading: boolean
  setUser: (user: User | null) => void
  setLoading: (loading: boolean) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  setUser: (user) => set({ user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  clearAuth: () => set({ user: null, isLoading: false }),
}))

export interface Repository {
  id: string
  name: string
  owner: string
  githubUrl: string
  defaultBranch: string
  workspaceId: string
  indexingStatus: 'PENDING' | 'INDEXING' | 'COMPLETED' | 'FAILED'
  lastIndexedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Workspace {
  id: string
  name: string
  userId: string
  repositories: Repository[]
  createdAt: string
  updatedAt: string
}

export interface BugfixProposal {
  id: string
  confidence: 'verified' | 'low'
  diagnosis: {
    filePath: string
    startLine: number
    endLine: number
    originalCode: string
    proposedCode: string
    explanation: string
  }
}

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeRepositoryId: string | null
  activeFilePath: string | null
  activeFileContent: string | null
  activeBugfix: BugfixProposal | null
  setWorkspaces: (workspaces: Workspace[]) => void
  setActiveWorkspaceId: (id: string | null) => void
  setActiveRepositoryId: (id: string | null) => void
  setActiveFilePath: (path: string | null) => void
  setActiveFileContent: (content: string | null) => void
  setActiveBugfix: (bugfix: BugfixProposal | null) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  activeRepositoryId: null,
  activeFilePath: null,
  activeFileContent: null,
  activeBugfix: null,
  setWorkspaces: (workspaces) =>
    set((state) => {
      const activeId = state.activeWorkspaceId || workspaces[0]?.id || null
      return { workspaces, activeWorkspaceId: activeId }
    }),
  setActiveWorkspaceId: (activeWorkspaceId) => set({ activeWorkspaceId }),
  setActiveRepositoryId: (activeRepositoryId) =>
    set({ activeRepositoryId, activeFilePath: null, activeFileContent: null, activeBugfix: null }),
  setActiveFilePath: (activeFilePath) => set({ activeFilePath }),
  setActiveFileContent: (activeFileContent) => set({ activeFileContent }),
  setActiveBugfix: (activeBugfix) => set({ activeBugfix }),
}))

