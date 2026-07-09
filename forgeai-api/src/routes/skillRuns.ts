import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

/**
 * GET /api/workspaces/:workspaceId/skill-runs
 * Returns all skill runs for a workspace, ordered by most recent first.
 */
router.get('/:workspaceId/skill-runs', async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string
  const userId = req.user?.sub

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    // Verify workspace ownership
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    })

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found or unauthorized' })
      return
    }

    const skillRuns = await prisma.skillRun.findMany({
      where: { workspaceId },
      include: {
        repository: {
          select: {
            id: true,
            name: true,
            owner: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    res.json(skillRuns)
  } catch (error: any) {
    console.error('Failed to fetch skill runs:', error)
    res.status(500).json({ error: `Failed to fetch skill runs: ${error.message}` })
  }
})

export default router
