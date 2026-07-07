'use client'

import { Button } from '@/components/ui/button'
import { getGitHubLoginUrl } from '@/lib/api'
import { GithubIcon } from '@/components/icons'
import { Zap, GitBranch, Search, ArrowRight } from 'lucide-react'

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
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
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
        <div className="mt-20 grid max-w-4xl gap-6 sm:grid-cols-3">
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
