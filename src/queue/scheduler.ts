import { getCheckQueue, enqueueSweep } from './checkQueue.js'
import { logActivity } from '../services/telegram.js'

/** Registers a repeatable sweep every minute; interval filtering is inside sweep. */
export async function startScheduler() {
  const queue = getCheckQueue()

  // Clear old repeatables with same key to avoid duplicates on hot reload
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    if (job.name === 'sweep') {
      await queue.removeRepeatableByKey(job.key)
    }
  }

  await queue.add(
    'sweep',
    { type: 'sweep' },
    {
      repeat: { every: 60_000 },
      jobId: 'pricewatch-sweep',
    },
  )

  // Kick once on boot
  await enqueueSweep()
  await logActivity('info', 'scheduler', 'Scheduler started (sweep every 60s)')
  console.log('[scheduler] repeatable sweep every 60s')
}
