import { Router, Request, Response } from 'express'

const router = Router()

/**
 * GET /api/health
 * Returns server health status, timestamp, and uptime.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

export default router
