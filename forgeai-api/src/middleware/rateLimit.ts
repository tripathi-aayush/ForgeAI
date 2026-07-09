import { Request, Response, NextFunction } from 'express'

/**
 * In-memory rate limiter middleware.
 * Tracks request counts per user (req.user.sub) within a sliding window.
 */
interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Clean up stale entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key)
    }
  }
}, 60_000)

export function rateLimit(opts: { windowMs: number; max: number; message?: string }) {
  const { windowMs, max, message } = opts

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = req.user?.sub
    if (!userId) {
      // If no user context, let auth middleware handle it
      next()
      return
    }

    const key = `${userId}:${req.path}`
    const now = Date.now()
    const entry = store.get(key)

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    if (entry.count >= max) {
      res.status(429).json({
        error: message || 'Too many requests. Please try again later.',
      })
      return
    }

    entry.count++
    next()
  }
}
