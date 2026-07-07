'use client'

import { useAuth } from '@/hooks/use-auth'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { logout } from '@/lib/api'
import { useAuthStore } from '@/lib/store'
import { Zap, LogOut, User } from 'lucide-react'
import { useRouter } from 'next/navigation'

export function Navbar() {
  const { user } = useAuth()
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const router = useRouter()

  const handleLogout = async () => {
    await logout()
    clearAuth()
    router.push('/')
  }

  return (
    <header className="flex items-center justify-between border-b border-border/50 bg-card/30 px-6 py-3 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/20">
          <Zap className="h-4 w-4 text-primary" />
        </div>
        <span className="text-lg font-semibold tracking-tight">ForgeAI</span>
      </div>

      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className="relative flex h-9 w-9 items-center justify-center rounded-full hover:opacity-80 transition-opacity focus:outline-none"
            id="user-menu-trigger"
          >
            <Avatar className="h-8 w-8">
              <AvatarImage
                src={user.avatarUrl || undefined}
                alt={user.username}
              />
              <AvatarFallback className="bg-primary/20 text-sm">
                {user.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="h-8 w-8">
                <AvatarImage
                  src={user.avatarUrl || undefined}
                  alt={user.username}
                />
                <AvatarFallback className="bg-primary/20 text-sm">
                  {user.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {user.displayName || user.username}
                </span>
                <span className="text-xs text-muted-foreground">
                  @{user.username}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2">
              <User className="h-4 w-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 text-destructive focus:text-destructive"
              onClick={handleLogout}
              id="logout-button"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  )
}
