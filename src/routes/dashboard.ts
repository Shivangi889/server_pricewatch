import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { getOwner, requireAuth } from '../middleware/auth.js'

export const dashboardRouter = Router()

dashboardRouter.use(requireAuth)

function dayLabel(d: Date) {
  return d.toLocaleDateString('en-IN', { weekday: 'short' })
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

dashboardRouter.get('/stats', async (_req, res, next) => {
  try {
    const owner = await getOwner()
    const [tracked, paused, unreadAlerts, stores, priceDrops7d] = await Promise.all([
      prisma.product.count({ where: { status: 'tracking' } }),
      prisma.product.count({ where: { status: 'paused' } }),
      prisma.notification.count({ where: { isRead: false } }),
      prisma.store.count(),
      prisma.notification.count({
        where: {
          type: 'price_decrease',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ])

    const recentAlerts = await prisma.notification.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            nickname: true,
            url: true,
            store: { select: { slug: true, name: true, color: true } },
          },
        },
      },
    })

    // Last 7 calendar days — price drops + all alerts
    const since = startOfDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000))
    const notifications = await prisma.notification.findMany({
      where: { createdAt: { gte: since } },
      select: { type: true, createdAt: true },
    })

    const priceDropsChart = []
    const dailyAlertsChart = []
    for (let i = 6; i >= 0; i--) {
      const day = startOfDay(new Date(Date.now() - i * 24 * 60 * 60 * 1000))
      const next = new Date(day)
      next.setDate(next.getDate() + 1)
      const inDay = notifications.filter((n) => {
        const t = n.createdAt.getTime()
        return t >= day.getTime() && t < next.getTime()
      })
      const label = dayLabel(day)
      priceDropsChart.push({
        day: label,
        drops: inDay.filter((n) => n.type === 'price_decrease').length,
      })
      dailyAlertsChart.push({
        day: label,
        alerts: inDay.length,
      })
    }

    // Products per store
    const byStore = await prisma.product.groupBy({
      by: ['storeId'],
      _count: { _all: true },
    })
    const storeRows = await prisma.store.findMany({
      where: { id: { in: byStore.map((b) => b.storeId) } },
    })
    const storeMap = Object.fromEntries(storeRows.map((s) => [s.id, s]))
    const storeDistribution = byStore
      .map((b) => {
        const s = storeMap[b.storeId]
        return {
          name: s?.name || 'Store',
          slug: s?.slug || '',
          value: b._count._all,
          color: s?.color || '#10B981',
        }
      })
      .sort((a, b) => b.value - a.value)

    // Biggest discount among tracking products
    const topDiscount = await prisma.product.findFirst({
      where: { status: 'tracking', discount: { gt: 0 } },
      orderBy: { discount: 'desc' },
      select: { discount: true, title: true, nickname: true },
    })

    res.json({
      stats: {
        trackedProducts: tracked,
        pausedProducts: paused,
        unreadAlerts,
        stores,
        priceDrops7d,
        biggestDiscount: topDiscount?.discount ?? 0,
        telegramConnected: Boolean(
          owner?.telegramEnabled && owner.telegramChatId && owner.telegramBotToken,
        ),
        pauseTracking: owner?.pauseTracking ?? false,
      },
      recentAlerts,
      charts: {
        priceDrops: priceDropsChart,
        dailyAlerts: dailyAlertsChart,
        storeDistribution,
      },
    })
  } catch (err) {
    next(err)
  }
})
