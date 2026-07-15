import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

export const notificationsRouter = Router()

notificationsRouter.use(requireAuth)

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === 'true'
    const where = unreadOnly ? { isRead: false } : undefined
    const take = Math.min(
      Math.max(Number(req.query.limit) || 500, 1),
      1000,
    )

    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              title: true,
              nickname: true,
              url: true,
              store: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      prisma.notification.count(),
      prisma.notification.count({ where: { isRead: false } }),
    ])

    res.json({ notifications, total, unread })
  } catch (err) {
    next(err)
  }
})

notificationsRouter.post('/read-all', async (_req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const notification = await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    })
    res.json({ notification })
  } catch (err) {
    next(err)
  }
})

const createDemoSchema = z.object({
  productId: z.string().optional(),
  type: z.enum([
    'price_decrease',
    'price_increase',
    'discount_change',
    'new_offer',
    'pincode_available',
  ]),
  message: z.string().optional(),
  pincode: z.string().optional(),
  oldPrice: z.number().optional(),
  newPrice: z.number().optional(),
})

/** Dev helper — create a notification without scraper (remove later). */
notificationsRouter.post('/demo', async (req, res, next) => {
  try {
    const body = createDemoSchema.parse(req.body)
    const notification = await prisma.notification.create({
      data: {
        productId: body.productId,
        type: body.type,
        message: body.message,
        pincode: body.pincode,
        oldPrice: body.oldPrice,
        newPrice: body.newPrice,
      },
    })
    res.status(201).json({ notification })
  } catch (err) {
    next(err)
  }
})
