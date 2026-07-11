import { Router, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { COOKIE_NAME, JWT_EXPIRY } from '../config/constants'
import { prisma, withRetry } from '../lib/prisma'
import { encrypt, generateState } from '../lib/crypto'
import { requireAuth } from '../middleware/auth'
import {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getGitHubUser,
} from '../services/github'

const router = Router()

/**
 * GET /api/auth/github
 * Redirects the user to GitHub's OAuth authorization page.
 * Sets a CSRF state token in a short-lived httpOnly cookie.
 */
router.get('/github', (_req: Request, res: Response) => {
  const state = generateState()

  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 10 minutes
    path: '/',
  })

  const authUrl = getAuthorizationUrl(state)
  res.redirect(authUrl)
})

/**
 * GET /api/auth/github/callback
 * Handles the OAuth callback from GitHub.
 * Validates state, exchanges code for token, upserts user, issues JWT.
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query
    const storedState = req.cookies?.oauth_state

    // Validate CSRF state
    if (!state || !storedState || state !== storedState) {
      res.status(403).json({ error: 'Invalid OAuth state — possible CSRF attack' })
      return
    }

    // Clear the state cookie
    res.clearCookie('oauth_state', { path: '/' })

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Missing authorization code' })
      return
    }

    // Exchange code for access token
    const accessToken = await exchangeCodeForToken(code)

    // Fetch GitHub user profile
    const ghUser = await getGitHubUser(accessToken)

    // Encrypt the GitHub access token for at-rest storage
    const encryptedToken = encrypt(accessToken)

    // Upsert the user (withRetry handles Neon cold-start connection drops)
    const user = await withRetry(() =>
      prisma.user.upsert({
        where: { githubId: ghUser.id },
        update: {
          username: ghUser.login,
          displayName: ghUser.name,
          avatarUrl: ghUser.avatar_url,
          email: ghUser.email,
          githubToken: encryptedToken,
        },
        create: {
          githubId: ghUser.id,
          username: ghUser.login,
          displayName: ghUser.name,
          avatarUrl: ghUser.avatar_url,
          email: ghUser.email,
          githubToken: encryptedToken,
        },
      })
    )

    // Issue JWT session token
    const token = jwt.sign(
      { sub: user.id, username: user.username },
      env.JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    )

    // Set session cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    })

    // Redirect to the frontend dashboard
    res.redirect(`${env.FRONTEND_URL}/dashboard`)
  } catch (error) {
    const code = (error as { code?: string }).code
    console.error(`OAuth callback error [${code ?? 'unknown'}]:`, (error as Error).message)
    res.redirect(`${env.FRONTEND_URL}/?error=auth_failed`)
  }
})

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's profile.
 * Requires a valid session cookie.
 */
router.get('/me', requireAuth, async (req: Request, res: Response) => {

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        email: true,
        createdAt: true,
      },
    })

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    res.json({ user })
  } catch (error) {
    console.error('Error fetching user:', (error as Error).message)
    res.status(500).json({ error: 'Failed to fetch user profile' })
  }
})

/**
 * POST /api/auth/logout
 * Clears the session cookie.
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  })

  res.json({ message: 'Logged out' })
})

export default router
