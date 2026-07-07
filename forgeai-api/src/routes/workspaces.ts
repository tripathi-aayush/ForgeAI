import { Router, Request, Response } from 'express'
import { prisma, withRetry } from '../lib/prisma'

const router = Router()

/**
 * GET /api/workspaces
 * Returns all workspaces for the logged-in user, including their repositories.
 * If no workspaces exist, dynamically creates a "Default Workspace" on the fly.
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    let workspaces = await withRetry(() =>
      prisma.workspace.findMany({
        where: { userId },
        include: {
          repositories: {
            orderBy: { createdAt: 'desc' },
          },
        },
      })
    )

    // If user has no workspaces (e.g. first login), create a default one
    if (workspaces.length === 0) {
      console.log(`Creating default workspace for user ${userId}`)
      const defaultWorkspace = await withRetry(() =>
        prisma.workspace.create({
          data: {
            name: 'Default Workspace',
            userId,
          },
          include: {
            repositories: true,
          },
        })
      )
      workspaces = [defaultWorkspace]
    }

    res.json(workspaces)
  } catch (error: any) {
    console.error('Failed to retrieve workspaces:', error)
    res.status(500).json({ error: `Failed to retrieve workspaces: ${error.message}` })
  }
})

export default router
