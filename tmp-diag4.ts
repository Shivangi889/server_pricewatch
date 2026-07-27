import 'dotenv/config'
import { getCheckQueue } from './src/queue/checkQueue.js'
import { prisma } from './src/lib/prisma.js'

async function main() {
  const q = getCheckQueue()
  const counts = await q.getJobCounts()
  console.log('job counts', counts)

  const waiting = await q.getJobs(['waiting', 'delayed'], 0, 20)
  console.log('sample waiting/delayed jobs:', waiting.length)
  for (const j of waiting.slice(0, 10)) {
    console.log(j.id, j.name, j.data)
  }

  const totalProducts = await prisma.product.count()
  const trackingCount = await prisma.product.count({ where: { status: 'tracking' } })
  const errorCount = await prisma.product.count({ where: { status: 'error' } })
  console.log({ totalProducts, trackingCount, errorCount })
}

main().finally(() => prisma.$disconnect())
