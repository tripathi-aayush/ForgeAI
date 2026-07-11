# ForgeAI

> AI-powered engineering workspace — import a GitHub repository, index it for
> retrieval-augmented reasoning, and let AI propose reviewed, git-safe fixes.

## Architecture

```
┌──────────────────────────┐      ┌──────────────────────────────────────────┐
│  forgeai-web             │      │  forgeai-api                             │
│  Next.js (App Router)    │──────│  Express 5 + TypeScript                  │
│  TypeScript              │ /api │                                          │
│  Tailwind CSS v4         │proxy │  ┌──────────┐  ┌────────────────────┐   │
│  shadcn/ui               │      │  │ Prisma   │  │ BullMQ (Redis)     │   │
│  Zustand + TanStack Q.   │      │  │ PG +     │  │                    │   │
│  Monaco Editor           │      │  │ pgvector │  │ indexing.worker.ts │   │
└──────────────────────────┘      │  └──────────┘  │ execution.worker.ts│   │
         │                        │                 └────────────────────┘   │
    Vercel (prod)                 └──────────────────────────────────────────┘
                                                     │
                                               Render (prod)
                                                     │
                                       ┌─────────────┴────────────┐
                                       │  Execution Backends       │
                                       │  (tried in order)        │
                                       │  1. Judge0 (self-hosted) │
                                       │  2. Piston (public API)  │
                                       └──────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind CSS v4, shadcn/ui |
| State | Zustand + TanStack Query |
| Code Editor | Monaco Editor via @monaco-editor/react |
| Backend | Node.js, Express 5, TypeScript |
| ORM | Prisma |
| Database | PostgreSQL + pgvector (Neon free tier) |
| Queue | BullMQ + Redis (Upstash free tier) |
| Auth | GitHub OAuth + JWT (httpOnly cookies) |
| Git Ops | Octokit + simple-git |
| LLM | Google Gemini / OpenAI / Groq (swappable via env vars) |
| Embeddings | Google Gemini / Voyage AI / OpenAI (swappable via env vars) |
| Code Execution | Piston public API (primary) + Judge0 self-hosted (optional) |
| Hosting | Vercel (frontend) + Render (backend) |

## Project Structure

```
ForgeAI/
├── forgeai-web/        # Next.js frontend
├── forgeai-api/        # Express backend
├── README.md           # This file
└── SETUP.md            # Environment variable reference & setup guide
```

## V1 Scope (What's Built)

| Skill | Description |
|---|---|
| **Ask** | Semantic search + RAG over your codebase. Ask any question and get cited answers. |
| **Fix a Bug** | AI proposes a single-file diff, user approves, ForgeAI opens a PR on a fresh branch. |
| **Code Review** | Paste a unified diff or PR URL; AI returns structured comments with severity levels. |
| **Docs** | Generates or updates README.md for the repo; user edits inline, then commits to a PR. |

All git operations enforce the repository's real default branch — no writes to `main`/`master` are ever made directly.

## Running Locally

### Prerequisites
- Node.js 20+
- A PostgreSQL database with the pgvector extension enabled (Neon free tier works)
- A Redis instance (Upstash free tier works)
- A GitHub OAuth App

### 1. Backend

```bash
cd forgeai-api
cp .env.example .env
# Edit .env with your real values (see SETUP.md for all variables)

npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Backend starts at `http://localhost:4000`.

### 2. Frontend

```bash
cd forgeai-web
cp .env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:4000

npm install
npm run dev
```

Frontend starts at `http://localhost:3000`. The Next.js dev server proxies
all `/api/*` requests to the backend, so no CORS configuration is needed.

### 3. Test the flow

1. Visit `http://localhost:3000`
2. Click "Sign in with GitHub"
3. Authorize the OAuth app
4. You are redirected to `/dashboard`
5. Import a public GitHub repository (try `octocat/Spoon-Knife`)
6. Wait for indexing to complete (status badge turns green)
7. Click the repository → try Ask, Fix a Bug, Review, or Docs

## Build Status

| Phase | Description | Status |
|---|---|---|
| Phase 0 | Project scaffolding, monorepo structure | ✅ Complete |
| Phase 1 | GitHub import, RAG indexing (pgvector), Ask skill | ✅ Complete |
| Phase 2 | Bug Fix skill (Gemini JSON mode, Zod, Monaco diff, PR flow) | ✅ Complete |
| Phase 3 | Code Review skill, Documentation skill | ✅ Complete |
| Phase 4 | Code execution sandbox (Piston fallback, re-diagnosis loop) | ✅ Complete |
| Phase 5 | Polish & ship (error UX, resilience, security sweep, docs) | ✅ Complete |

## Known Limitations

- **Single-file fixes only**: The Bug Fix skill proposes changes to exactly one file per run. Multi-file refactors are not supported in V1.
- **No streaming**: LLM responses are returned as a complete JSON payload. Long-running prompts may feel slow on the first request after a Neon/Render cold start.
- **Execution sandbox language support**: Piston supports ~80 languages by version; Judge0 supports 60+. Uncommon runtimes or specific compiler versions may not be available.
- **Re-diagnosis cap**: The execution loop re-diagnoses a failed fix at most twice (`MAX_EXECUTION_ATTEMPTS = 2`). Stubborn bugs that require more than two iterations will surface a "cap reached" result and require manual follow-up.
- **Free-tier cold starts**: Both Neon (PostgreSQL) and Render (API server) can take 5–15 seconds to wake from idle. The frontend retries 502/503 responses automatically, and the backend retries connection errors with exponential backoff.
- **GitHub token scope**: Requires the `repo` OAuth scope to create branches and open pull requests. Read-only tokens are insufficient for the Bug Fix and Docs skills.

## Roadmap

- [ ] Multi-file diff support for complex bug fixes
- [ ] Streaming LLM responses (Server-Sent Events)
- [ ] Saved conversation history per repository
- [ ] Team workspaces (shared repo access across users)
- [ ] Direct IDE extension (VS Code)
