import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'

export const jobsRouter = Router()

jobsRouter.use(requireAuth)

jobsRouter.post('/sweep', async (_req, res, next) => {
  try {
    try {
      const { pingRedis } = await import('../queue/connection.js')
      const { enqueueSweep } = await import('../queue/checkQueue.js')
      await pingRedis()
      const job = await enqueueSweep()
      return res.json({ ok: true, mode: 'queue', jobId: job.id })
    } catch {
      const { sweepInline } = await import('../queue/inProcess.js')
      const result = await sweepInline()
      return res.json({ ok: true, mode: 'inline', ...result })
    }
  } catch (err) {
    next(err)
  }
})

jobsRouter.get('/stats', async (_req, res, next) => {
  try {
    try {
      const { pingRedis } = await import('../queue/connection.js')
      const { getCheckQueue } = await import('../queue/checkQueue.js')
      await pingRedis()
      const q = getCheckQueue()
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
        q.getDelayedCount(),
      ])
      return res.json({
        mode: 'queue',
        queue: 'pricewatch-checks',
        waiting,
        active,
        completed,
        failed,
        delayed,
      })
    } catch {
      return res.json({
        mode: 'inline',
        queue: null,
        note: 'Redis unavailable — using in-process checker',
      })
    }
  } catch (err) {
    next(err)
  }
})
