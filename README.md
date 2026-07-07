# ForgeAI

> AI-powered engineering workspace — import a GitHub repo, index it for
> retrieval-augmented reasoning, and let AI propose reviewed, git-safe fixes.

## Architecture

```
┌─────────────────────┐      ┌─────────────────────────────┐
│   forgeai-web       │      │   forgeai-api               │
│   Next.js 16        │──────│   Express 5 + TypeScript    │
│   Tailwind + shadcn │ API  │                             │
│   Zustand + TQ      │      │   ┌──────────┐ ┌────────┐  │
│   Monaco Editor     │      │   │ Prisma   │ │ BullMQ │  │
└─────────────────────┘      │   │ (PG +    │ │ (Redis)│  │
         │                   │   │ pgvector)│ └────────┘  │
    Vercel (prod)            │   └──────────┘             │
                             └─────────────────────────────┘
                                        │
                                   Render (prod)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS v4, shadcn/ui |
| State | Zustand + TanStack Query |
| Code Editor | Monaco Editor via @monaco-editor/react |
| Backend | Node.js, Express 5, TypeScript |
| ORM | Prisma |
| Database | PostgreSQL + pgvector |
| Queue | BullMQ + Redis (Upstash) |
| Auth | GitHub OAuth + JWT (httpOnly cookies) |
| Git Ops | Octokit + simple-git |
| Embeddings | Abstracted client (Voyage AI / OpenAI) |
| Object Storage | Cloudflare R2 (S3-compatible) |
| Hosting | Vercel (frontend) + Render (backend) |

## Project Structure

```
ForgeAI/
├── forgeai-web/        # Next.js frontend
├── forgeai-api/        # Express backend
├── README.md           # This file
└── SETUP.md            # Environment variable reference
```

## Running Locally

### Prerequisites
- Node.js 20+
- A PostgreSQL database with pgvector extension enabled
- A Redis instance (or Upstash account)
- A GitHub OAuth App

### 1. Backend

```bash
cd forgeai-api
cp .env.example .env
# Edit .env with your real values (see SETUP.md)

npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Backend starts at `http://localhost:4000`

### 2. Frontend

```bash
cd forgeai-web
cp .env.example .env.local

npm install
npm run dev
```

Frontend starts at `http://localhost:3000`

### 3. Test the flow

1. Visit `http://localhost:3000`
2. Click "Sign in with GitHub"
3. Authorize the OAuth app
4. You should be redirected to `/dashboard`

## Build Status

| Project | Phase | Status |
|---|---|---|
| Phase 0 | Setup & Scaffolding | ✅ Complete |
| Phase 1 | Foundation (import, indexing, RAG) | 🔲 Not started |
| Phase 2 | Bug Fix Skill | 🔲 Future |
