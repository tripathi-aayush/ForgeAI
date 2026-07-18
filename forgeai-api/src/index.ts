import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { env } from './config/env'
import { requireAuth, errorHandler } from './middleware'
import authRoutes from './routes/auth'
import healthRoutes from './routes/health'
import repositoriesRoutes from './routes/repositories'
import workspacesRoutes from './routes/workspaces'
import bugfixRoutes from './routes/bugfix'
import reviewRoutes from './routes/review'
import docsRoutes from './routes/docs'
import skillRunsRoutes from './routes/skillRuns'
import discoverRoutes from './routes/discover'

// Import indexing worker to start listening to the BullMQ queue
import './workers/indexing'
import './workers/execution.worker'
import './workers/discovery.worker'

const app = express()

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(helmet())
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  })
)
app.use(express.json())
app.use(cookieParser())

// ---------------------------------------------------------------------------
// Public routes (no auth required)
// ---------------------------------------------------------------------------
app.use('/api/health', healthRoutes)
app.use('/api/auth', authRoutes)

// Phase 6: Discovery catalog browse and semantic search — public (no auth required).
// Only POST /api/discover/trigger requires auth (handled inside the route handler).
app.use('/api/discover', discoverRoutes)

// ---------------------------------------------------------------------------
// Protected routes (require valid JWT session)
// ---------------------------------------------------------------------------
// Apply auth middleware to all routes below this line
app.use('/api', requireAuth)

app.use('/api/repositories', repositoriesRoutes)
app.use('/api/repositories', bugfixRoutes)
app.use('/api/repositories', reviewRoutes)
app.use('/api/repositories', docsRoutes)
app.use('/api/workspaces', workspacesRoutes)
app.use('/api/workspaces', skillRunsRoutes)

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use(errorHandler)

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = env.PORT

app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   ForgeAI API running on port ${PORT}     ║
  ║   Environment: ${env.NODE_ENV.padEnd(22)}║
  ╚════════════════════════════════════════╝
  `)
})

export default app
