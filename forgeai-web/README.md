# ForgeAI Web

Next.js frontend for ForgeAI — an AI engineering workspace.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **State**: Zustand + TanStack Query
- **Editor**: Monaco Editor (Phase 1)
- **Icons**: Lucide React

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Start development server
npm run dev
```

The app starts at `http://localhost:3000`.

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Serve production build |
| `npm run lint` | Run ESLint |

## API Proxy

In development, `/api/*` requests are automatically proxied to the backend
(`NEXT_PUBLIC_API_URL`, default `http://localhost:4000`). This avoids CORS
issues with httpOnly session cookies.

## Project Structure

```
src/
├── app/              # Next.js App Router pages
│   ├── layout.tsx    # Root layout (providers, fonts, metadata)
│   ├── page.tsx      # Landing page
│   └── dashboard/    # Protected dashboard
├── components/
│   ├── ui/           # shadcn/ui components
│   ├── navbar.tsx    # Top navigation bar
│   └── providers.tsx # React Query provider
├── hooks/
│   └── use-auth.ts   # Authentication hook
└── lib/
    ├── api.ts        # API client
    ├── store.ts      # Zustand stores
    └── utils.ts      # shadcn/ui utilities
```
