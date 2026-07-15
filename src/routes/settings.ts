import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { getOwner, requireAuth } from '../middleware/auth.js'
import { sendTelegram, logActivity } from '../services/telegram.js'

export const settingsRouter = Router()

settingsRouter.use(requireAuth)

function serializeSettings(owner: {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  telegramChatId: string | null
  telegramBotToken: string | null
  telegramEnabled: boolean
  checkIntervalMin: number
  maxRetries: number
  pauseTracking: boolean
  alertPriceDecrease: boolean
  alertPriceIncrease: boolean
  alertDiscountChange: boolean
  alertNewOffer: boolean
  alertPincodeAvailable: boolean
}) {
  return {
    profile: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      avatarUrl: owner.avatarUrl || '',
    },
    telegram: {
      chatId: owner.telegramChatId || '',
      botToken: owner.telegramBotToken || '',
      connected: Boolean(owner.telegramChatId && owner.telegramBotToken),
      enabled: owner.telegramEnabled,
    },
    tracking: {
      checkIntervalMin: owner.checkIntervalMin,
      maxRetries: owner.maxRetries,
      pauseTracking: owner.pauseTracking,
    },
    prefs: {
      'price-decrease': owner.alertPriceDecrease,
      'price-increase': owner.alertPriceIncrease,
      'discount-change': owner.alertDiscountChange,
      'new-offer': owner.alertNewOffer,
      'pincode-available': owner.alertPincodeAvailable,
      telegramEnabled: owner.telegramEnabled,
    },
  }
}

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const owner = await getOwner()
    res.json({ settings: serializeSettings(owner) })
  } catch (err) {
    next(err)
  }
})

const avatarUrlSchema = z
  .string()
  .max(1_500_000)
  .nullable()
  .refine(
    (v) =>
      v === null ||
      v === '' ||
      v.startsWith('data:image/') ||
      v.startsWith('https://api.dicebear.com/') ||
      /^https:\/\/.+\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i.test(v) ||
      /^https:\/\/images\.unsplash\.com\//i.test(v),
    { message: 'Invalid avatar URL' },
  )

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  avatarUrl: avatarUrlSchema.optional(),
  telegramChatId: z.string().nullable().optional(),
  telegramBotToken: z.string().nullable().optional(),
  checkIntervalMin: z.number().int().min(5).max(1440).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  pauseTracking: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  alertPriceDecrease: z.boolean().optional(),
  alertPriceIncrease: z.boolean().optional(),
  alertDiscountChange: z.boolean().optional(),
  alertNewOffer: z.boolean().optional(),
  alertPincodeAvailable: z.boolean().optional(),
})

settingsRouter.patch('/', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body)
    const owner = await getOwner()

    const data: Record<string, unknown> = { ...body }
    if (body.avatarUrl !== undefined) {
      data.avatarUrl = body.avatarUrl === '' ? null : body.avatarUrl
    }

    const updated = await prisma.owner.update({
      where: { id: owner.id },
      data,
    })

    res.json({ ok: true, settings: serializeSettings(updated) })
  } catch (err) {
    next(err)
  }
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

settingsRouter.post('/password', async (req, res, next) => {
  try {
    const body = passwordSchema.parse(req.body)
    const owner = await getOwner()
    const ok = await bcrypt.compare(body.currentPassword, owner.passwordHash)
    if (!ok) {
      return res.status(400).json({ error: 'Current password is incorrect' })
    }
    const passwordHash = await bcrypt.hash(body.newPassword, 10)
    await prisma.owner.update({
      where: { id: owner.id },
      data: { passwordHash },
    })
    await logActivity('info', 'settings', 'Password changed')
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

settingsRouter.post('/telegram/test', async (_req, res, next) => {
  try {
    const result = await sendTelegram(
      '✅ PriceWatch test message\nYour Telegram alerts are connected and working.',
    )
    if (!result.sent) {
      return res.status(400).json({
        error:
          result.reason === 'telegram_not_configured'
            ? 'Save bot token and chat ID first, and enable Telegram'
            : 'Telegram API rejected the message — check token / chat ID',
        reason: result.reason,
      })
    }
    res.json({ ok: true, sent: true })
  } catch (err) {
    next(err)
  }
})

/** Wipe tracking data — keeps owner account + built-in stores */
settingsRouter.post('/reset', async (req, res, next) => {
  try {
    const confirm = String(req.body?.confirm || '')
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm reset' })
    }

    await prisma.$transaction([
      prisma.notification.deleteMany({}),
      prisma.priceHistory.deleteMany({}),
      prisma.productPincode.deleteMany({}),
      prisma.product.deleteMany({}),
      prisma.activityLog.deleteMany({}),
      prisma.store.deleteMany({ where: { builtIn: false } }),
    ])

    await logActivity('warn', 'settings', 'All tracking data was reset')
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
