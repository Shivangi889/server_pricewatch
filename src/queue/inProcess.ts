import { prisma } from '../lib/prisma.js'
import { checkProductJob } from '../services/checkProduct.js'
import { logActivity } from '../services/telegram.js'

let running = false
let timer: NodeJS.Timeout | null = null

export async function sweepInline() {
  if (running) return { checked: 0, skipped: 'busy' as const }
  running = true
  try {
    const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
    if (owner?.pauseTracking) {
      await logActivity('info', 'scheduler', 'In-process sweep skipped — global pause')
      return { checked: 0, skipped: 'pause' as const }
    }

    const intervalMin = owner?.checkIntervalMin || 30
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

    // Error retries first — this loop is fully sequential, so a big batch
    // of routine tracking checks could otherwise starve error products of
    // their ≤5min retry the same way the BullMQ queue could.
    products.sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0))

    let checked = 0
    for (const product of products) {
      if (product.store.requiresPincode) {
        for (const pin of product.pincodes) {
          await checkProductJob({ productId: product.id, pincode: pin.pincode })
          checked += 1
        }
      } else {
        await checkProductJob({ productId: product.id })
        checked += 1
      }
    }

    if (checked > 0) {
      await logActivity('info', 'scheduler', `In-process sweep checked ${checked} job(s)`)
    }
    return { checked }
  } catch (err) {
    console.error('[in-process] sweep error', err)
    throw err
  } finally {
    running = false
  }
}

export function startInProcessRunner() {
  console.log('[worker] Redis unavailable — using in-process checker (no BullMQ)')
  void sweepInline()
  timer = setInterval(() => {
    void sweepInline()
  }, 60_000)
  return () => {
    if (timer) clearInterval(timer)
  }
}

export async function runImmediateCheck(productId: string, pincode?: string) {
  return checkProductJob({ productId, pincode })
}
