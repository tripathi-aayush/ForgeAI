# ForgeAI — Environment Variable Setup Guide

This document lists every environment variable used by ForgeAI, which service
it belongs to, and where to create the required account.

---

## Backend (`forgeai-api/.env`)

### Server Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `4000` | Express server port |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |

### PostgreSQL Database

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |

**Where to get it:**
- **Neon** (recommended free tier): [neon.tech](https://neon.tech)
  - Create a project → copy the connection string
  - Neon has pgvector enabled by default
- **Supabase**: [supabase.com](https://supabase.com)
  - Create a project → Settings → Database → Connection string
  - pgvector is pre-installed

### Redis

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | ✅ | Redis connection string (use `rediss://` for TLS) |

**Where to get it:**
- **Upstash** (recommended): [upstash.com](https://upstash.com)
  - Create a Redis database → copy the `rediss://` connection string
  - Use a **Fixed** plan for BullMQ workloads to avoid high command costs

### GitHub OAuth App

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | ✅ | OAuth App Client Secret |

**Where to get it:**
- Go to [github.com/settings/developers](https://github.com/settings/developers)
- Click "New OAuth App"
- Set:
  - **Homepage URL**: `http://localhost:3000` (dev) or your production URL
  - **Authorization callback URL**: `http://localhost:3000/api/auth/github/callback`
- After creation, copy the Client ID and generate a Client Secret

### Security

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Secret for signing JWT session tokens (min 32 chars) |
| `ENCRYPTION_KEY` | ✅ | 64 hex chars (32 bytes) for AES-256-GCM encryption |

**How to generate:**
```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Application

| Variable | Required | Description |
|---|---|---|
| `FRONTEND_URL` | ✅ | Frontend origin for CORS + OAuth redirects |

- Development: `http://localhost:3000`
- Production: Your Vercel deployment URL (e.g., `https://forgeai.vercel.app`)

### Indexing Guardrails (Optional)

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAX_INDEX_FILES` | No | `2000` | Max files to index per repo |
| `MAX_FILE_SIZE_KB` | No | `512` | Max file size (KB) to index |

---

## Frontend (`forgeai-web/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | No | `http://localhost:4000` | Backend API URL |
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:3000` | Frontend URL |

---

## Deployment Environment Variables

### Vercel (forgeai-web)

Set in: Vercel Dashboard → Project → Settings → Environment Variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | Your Render backend URL (e.g., `https://forgeai-api.onrender.com`) |
| `NEXT_PUBLIC_APP_URL` | Your Vercel URL (e.g., `https://forgeai.vercel.app`) |

### Render (forgeai-api)

Set in: Render Dashboard → Service → Environment

| Variable | Value |
|---|---|
| `PORT` | `4000` (or Render's default) |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Your Neon/Supabase connection string |
| `REDIS_URL` | Your Upstash Redis URL |
| `GITHUB_CLIENT_ID` | Your production GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | Your production GitHub OAuth App Client Secret |
| `JWT_SECRET` | A strong random secret (see generation command above) |
| `ENCRYPTION_KEY` | A 64-char hex key (see generation command above) |
| `FRONTEND_URL` | Your Vercel URL (e.g., `https://forgeai.vercel.app`) |

> **Important:** Create a **separate** GitHub OAuth App for production with
> the production callback URL: `https://forgeai.vercel.app/api/auth/github/callback`
