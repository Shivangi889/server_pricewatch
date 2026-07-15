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
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: Number(process.env.JOB_MAX_ATTEMPTS || 3),
        backoff: { type: 'exponential', delay: 5000 },
      },
    })
  }
  return queue
}

export async function enqueueProductCheck(data: CheckJobData, opts?: { priority?: number }) {
  const q = getCheckQueue()
  const jobId = data.pincode
    ? `check-${data.productId}-${data.pincode}-${Date.now()}`
    : `check-${data.productId}-${Date.now()}`

  return q.add('check-product', data, {
    jobId,
    priority: opts?.priority,
  })
}

export async function enqueueSweep() {
  return getCheckQueue().add('sweep', { type: 'sweep' }, {
    jobId: `sweep-${Date.now()}`,
  })
}
