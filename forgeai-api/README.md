# ForgeAI API

Express + TypeScript backend for ForgeAI — an AI engineering workspace.

## Tech Stack

- **Runtime**: Node.js + Express 5
- **Language**: TypeScript
- **ORM**: Prisma (PostgreSQL + pgvector)
- **Queue**: BullMQ + Redis (Upstash-compatible)
- **Auth**: GitHub OAuth + JWT sessions (httpOnly cookies)

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# → Edit .env with your real values (see SETUP.md in repo root)

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Start development server
npm run dev
```

The server starts at `http://localhost:4000`.

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Build for production (tsup) |
| `npm start` | Run production build |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:push` | Push schema changes (no migration) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:studio` | Open Prisma Studio |

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | No | Health check |
| `GET` | `/api/auth/github` | No | Initiate GitHub OAuth |
| `GET` | `/api/auth/github/callback` | No | OAuth callback |
| `GET` | `/api/auth/me` | Yes | Get current user |
| `POST` | `/api/auth/logout` | No | Clear session |

## Project Structure

```
src/
├── index.ts           # Express app entry point
├── config/            # Environment validation + constants
├── routes/            # Express route handlers
├── middleware/         # Auth + error handling middleware
├── services/          # Business logic (GitHub OAuth, etc.)
└── lib/               # Shared utilities (Prisma, Redis, crypto)
```
