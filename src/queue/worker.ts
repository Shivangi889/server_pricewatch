import { Worker, type Job } from 'bullmq'
import { getBullConnection } from './connection.js'
import { CHECK_QUEUE_NAME, enqueueProductCheck } from './checkQueue.js'
import { checkProductJob, type CheckJobData } from '../services/checkProduct.js'
import { prisma } from '../lib/prisma.js'
import { logActivity } from '../services/telegram.js'

type SweepData = { type: 'sweep' }

async function runSweep() {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (owner?.pauseTracking) {
    await logActivity('info', 'scheduler', 'Sweep skipped — global pause')
    return { enqueued: 0, skipped: 'pause' }
  }

  const intervalMin = owner?.checkIntervalMin || 30
  // Failed scrapes used to stay status=error forever — sweep only looked at
  // "tracking", so the UI sat on Error until a manual refresh. Retry errors
  // sooner (≤5 min) so Flipkart WOW/block flakes recover automatically.
  const errorRetryMin = Math.min(5, intervalMin)
  const trackingCutoff = new Date(Date.now() - intervalMin * 60_000)
  const errorCutoff = new Date(Date.now() - errorRetryMin * 60_000)

  const products = await prisma.product.findMany({
    where: {
      OR: [
        {
          status: 'tracking',
          OR: [{ lastChecked: null }, { lastChecked: { lt: trackingCutoff } }],
        },
        {
          status: 'error',
          OR: [{ lastChecked: null }, { lastChecked: { lt: errorCutoff } }],
        },
      ],
    },
    include: { store: true, pincodes: true },
  })

  let enqueued = 0
  for (const product of products) {
    // Error retries jump ahead of routine tracking checks (BullMQ: no
    // priority / 0 always beats any prioritized job) so a handful of
    // stuck "error" products can't get buried behind a big wave of
    // regular re-checks and miss their ≤5min retry window.
    const priority = product.status === 'error' ? undefined : 5
    if (product.store.requiresPincode) {
      for (const pin of product.pincodes) {
        await enqueueProductCheck({ productId: product.id, pincode: pin.pincode }, { priority })
        enqueued += 1
      }
      if (product.pincodes.length === 0) {
        await logActivity('warn', 'scheduler', `Skip ${product.title} — no pincodes`)
      }
    } else {
      await enqueueProductCheck({ productId: product.id }, { priority })
      enqueued += 1
    }
  }

  await logActivity('info', 'scheduler', `Sweep enqueued ${enqueued} check(s)`)
  return { enqueued }
}

export function startCheckWorker() {
  const worker = new Worker(
    CHECK_QUEUE_NAME,
    async (job: Job<CheckJobData | SweepData>) => {
      if (job.name === 'sweep' || ('type' in job.data && job.data.type === 'sweep')) {
        return runSweep()
      }
      return checkProductJob(job.data as CheckJobData)
    },
    {
      connection: getBullConnection(),
      concurrency: Number(process.env.WORKER_CONCURRENCY || 1),
    },
  )

  worker.on('completed', (job) => {
    if (job.name === 'sweep' || job.name?.startsWith('sweep')) {
      const r = job.returnvalue as { enqueued?: number; skipped?: string } | undefined
      console.log(
        `[worker] completed sweep ${job.id} enqueued=${r?.enqueued ?? '?'}`,
      )
      return
    }
    console.log(`[worker] completed ${job.name} ${job.id}`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[worker] failed ${job?.name} ${job?.id}:`, err.message)
  })

  console.log('[worker] check worker started')
  return worker
}
