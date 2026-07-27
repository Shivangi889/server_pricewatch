import { Queue } from 'bullmq'
import { getBullConnection } from './connection.js'
import type { CheckJobData } from '../services/checkProduct.js'

export const CHECK_QUEUE_NAME = 'pricewatch-checks'

let queue: Queue<CheckJobData | { type: 'sweep' }> | null = null

export function getCheckQueue() {
  if (!queue) {
    queue = new Queue(CHECK_QUEUE_NAME, {
      connection: getBullConnection(),
      defaultJobOptions: {
        // Must be removed immediately (not just capped) — job IDs below are
        // deterministic per product so the *next* sweep can reuse the same
        // ID. If a finished job were kept around (even capped), BullMQ
        // treats that ID as still occupied and silently no-ops future
        // `add()` calls with it, which would freeze retries forever after
        // the first check. Activity/error history already lives in
        // `activityLog`, so nothing is lost by not keeping job records.
        removeOnComplete: true,
        removeOnFail: true,
        attempts: Number(process.env.JOB_MAX_ATTEMPTS || 3),
        backoff: { type: 'exponential', delay: 5000 },
      },
    })
  }
  return queue
}

export async function enqueueProductCheck(data: CheckJobData, opts?: { priority?: number }) {
  const q = getCheckQueue()
  // Deterministic (no timestamp) so a product/pincode already waiting or
  // running in the queue is never duplicated by the next sweep tick. Without
  // this, every 60s sweep added a fresh job for every eligible product even
  // though the previous one hadn't been processed yet (concurrency=1), and
  // the backlog grew without bound — older "error" products got buried and
  // never actually got their promised ≤5min retry.
  const jobId = data.pincode
    ? `check-${data.productId}-${data.pincode}`
    : `check-${data.productId}`

  return q.add('check-product', data, {
    jobId,
    priority: opts?.priority,
  })
}

export async function enqueueSweep() {
  // Deterministic id: avoid piling up extra one-off sweep jobs alongside
  // the repeatable one when the server restarts frequently in dev.
  return getCheckQueue().add('sweep', { type: 'sweep' }, {
    jobId: 'sweep-boot',
  })
}
