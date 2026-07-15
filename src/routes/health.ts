import { Router } from 'express'
import { prisma } from '../lib/prisma.js'

export const healthRouter = Router()

healthRouter.get('/', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({
      ok: true,
      service: 'pricewatch-api',
      db: 'up',
      time: new Date().toISOString(),
    })
  } catch {
    res.status(503).json({
      ok: false,
      service: 'pricewatch-api',
      db: 'down',
      time: new Date().toISOString(),
    })
  }
})
