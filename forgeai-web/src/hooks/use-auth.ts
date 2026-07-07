'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuthStore, type User } from '@/lib/store'

interface MeResponse {
  user: User
}

export function useAuth() {
  const { user, isLoading, setUser, clearAuth } = useAuthStore()

  const { data, isLoading: queryLoading, error } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api<MeResponse>('/api/auth/me'),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (data?.user) {
      setUser(data.user)
    } else if (error) {
      clearAuth()
    }
  }, [data, error, setUser, clearAuth])

  return {
    user,
    isLoading: isLoading || queryLoading,
    isAuthenticated: !!user,
  }
}
