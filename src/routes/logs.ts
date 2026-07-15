import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

export const logsRouter = Router()

logsRouter.use(requireAuth)

logsRouter.get('/', async (req, res, next) => {
  try {
    const level = typeof req.query.level === 'string' ? req.query.level : undefined
    const logs = await prisma.activityLog.findMany({
      where:
        level === 'info' || level === 'warn' || level === 'error'
          ? { level }
          : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({ logs })
  } catch (err) {
    next(err)
  }
})
