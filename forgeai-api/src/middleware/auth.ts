import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { COOKIE_NAME } from '../config/constants'

export interface AuthPayload {
  sub: string
  username: string
}

// Extend Express Request to include user info
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload
  }
}

/**
 * JWT auth middleware.
 * Reads the session cookie, verifies the JWT, and attaches user info to req.user.
 * Returns 401 if no valid session is found.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME]

  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload
    req.user = payload
    next()
  } catch (err: any) {
    console.error(`[auth-middleware] Token verification failed for path ${req.path}:`, err.message)
    res.status(401).json({ error: 'Invalid or expired session' })
  }
}
