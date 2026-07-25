import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

export const productsRouter = Router()

productsRouter.use(requireAuth)

productsRouter.get('/', async (req, res, next) => {
  try {
    const storeSlug = typeof req.query.store === 'string' ? req.query.store : undefined
    const status = typeof req.query.status === 'string' ? req.query.status : undefined

    const products = await prisma.product.findMany({
      where: {
        ...(storeSlug ? { store: { slug: storeSlug } } : {}),
        ...(status === 'tracking' || status === 'paused' || status === 'error'
          ? { status }
          : {}),
      },
      include: {
        store: true,
        pincodes: { orderBy: { pincode: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ products })
  } catch (err) {
    next(err)
  }
})

productsRouter.get('/:id', async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        store: true,
        pincodes: { orderBy: { pincode: 'asc' } },
        history: { orderBy: { checkedAt: 'desc' }, take: 90 },
      },
    })
    if (!product) return res.status(404).json({ error: 'Product not found' })
    res.json({ product })
  } catch (err) {
    next(err)
  }
})

const pincodeSchema = z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits')

const createProductSchema = z.object({
  storeId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1).optional(),
  nickname: z.string().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  telegramEnabled: z.boolean().optional(),
  pincodes: z.array(pincodeSchema).optional(),
})

productsRouter.post('/', async (req, res, next) => {
  const t0 = Date.now()
  try {
    const body = createProductSchema.parse(req.body)
    const store = await prisma.store.findUnique({ where: { id: body.storeId } })
    if (!store) return res.status(400).json({ error: 'Invalid store' })

    const pins = [...new Set(body.pincodes || [])]
    if (store.requiresPincode && pins.length === 0) {
      return res.status(400).json({ error: 'At least one pincode is required for this store' })
    }

    const title =
      body.title?.trim() ||
      body.nickname?.trim() ||
      'Product'

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        url: body.url,
        title,
        nickname: body.nickname,
        targetPrice:
          body.targetPrice != null ? new Prisma.Decimal(body.targetPrice) : null,
        telegramEnabled: body.telegramEnabled ?? true,
        pincodes: {
          create: pins.map((pincode) => ({ pincode })),
        },
      },
      include: { store: true, pincodes: true },
    })

    await prisma.activityLog.create({
      data: {
        level: 'info',
        source: 'api',
        message: `Product added: ${product.title} (${store.name})`,
      },
    })

    // Auto-scrape once so name / image / price fill without a manual Refresh
    const pinList = store.requiresPincode ? pins : [undefined as string | undefined]
    const waitMs = Number(
      process.env.REFRESH_WAIT_MS ||
        (process.env.FREE_TIER === 'true' || process.env.RENDER === 'true' ? 25_000 : 20_000),
    )

    const { runImmediateCheck } = await import('../queue/inProcess.js')
    const work = (async () => {
      const results = []
      for (const pincode of pinList) {
        results.push(await runImmediateCheck(product.id, pincode))
      }
      return results
    })()

    const raced = await Promise.race([
      work
        .then((results) => ({ done: true as const, results, scrapeError: null as string | null }))
        .catch((err) => ({
          done: true as const,
          results: [] as unknown[],
          scrapeError: err instanceof Error ? err.message : String(err),
        })),
      new Promise<{ done: false; scrapeError: null }>((resolve) =>
        setTimeout(() => resolve({ done: false, scrapeError: null }), waitMs),
      ),
    ])

    if (!raced.done) {
      void work.catch((err) => {
        console.error('[add] background scrape failed', err)
      })
    } else if (raced.scrapeError) {
      // Don't leave an empty ₹0 product — remove it and return a clear client error
      await prisma.product.delete({ where: { id: product.id } }).catch(() => undefined)
      return res.status(400).json({ error: raced.scrapeError })
    }

    const updated = await prisma.product.findUnique({
      where: { id: product.id },
      include: { store: true, pincodes: true },
    })

    res.status(201).json({
      product: updated || product,
      scraped: raced.done,
      pending: !raced.done,
      durationMs: Date.now() - t0,
    })
  } catch (err) {
    next(err)
  }
})

const updateProductSchema = z.object({
  title: z.string().min(1).optional(),
  nickname: z.string().nullable().optional(),
  url: z.string().url().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  telegramEnabled: z.boolean().optional(),
  status: z.enum(['tracking', 'paused', 'error']).optional(),
  pincodes: z.array(pincodeSchema).optional(),
})

productsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateProductSchema.parse(req.body)
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { store: true },
    })
    if (!existing) return res.status(404).json({ error: 'Product not found' })

    if (body.pincodes) {
      const pins = [...new Set(body.pincodes)]
      if (existing.store.requiresPincode && pins.length === 0) {
        return res.status(400).json({ error: 'At least one pincode is required for this store' })
      }

      await prisma.$transaction([
        prisma.productPincode.deleteMany({ where: { productId: existing.id } }),
        prisma.productPincode.createMany({
          data: pins.map((pincode) => ({ productId: existing.id, pincode })),
        }),
      ])
    }

    const product = await prisma.product.update({
      where: { id: existing.id },
      data: {
        title: body.title,
        nickname: body.nickname === undefined ? undefined : body.nickname,
        url: body.url,
        telegramEnabled: body.telegramEnabled,
        status: body.status,
        targetPrice:
          body.targetPrice === undefined
            ? undefined
            : body.targetPrice == null
              ? null
              : new Prisma.Decimal(body.targetPrice),
      },
      include: { store: true, pincodes: true },
    })

    res.json({ product })
  } catch (err) {
    next(err)
  }
})

productsRouter.post('/:id/pause', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'Product not found' })

    const nextStatus = existing.status === 'paused' ? 'tracking' : 'paused'
    const product = await prisma.product.update({
      where: { id: existing.id },
      data: { status: nextStatus },
      include: { store: true, pincodes: true },
    })
    res.json({ product })
  } catch (err) {
    next(err)
  }
})

productsRouter.post('/:id/refresh', async (req, res, next) => {
  const t0 = Date.now()
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { store: true, pincodes: true },
    })
    if (!product) return res.status(404).json({ error: 'Product not found' })
    if (product.status === 'paused') {
      return res.status(400).json({ error: 'Resume tracking before refreshing' })
    }

    if (product.store.requiresPincode && !product.pincodes.length) {
      return res.status(400).json({ error: 'Add at least one pincode first' })
    }

    const pins = product.store.requiresPincode
      ? product.pincodes.map((p) => p.pincode)
      : [undefined as string | undefined]

    // User refresh: run INLINE (same as a fast local check).
    // Queueing on Render free made this feel like ~1–2 min (worker wait + cold Chromium).
    const waitMs = Number(
      process.env.REFRESH_WAIT_MS ||
        (process.env.FREE_TIER === 'true' || process.env.RENDER === 'true' ? 25_000 : 20_000),
    )

    const { runImmediateCheck } = await import('../queue/inProcess.js')

    const work = (async () => {
      const results = []
      for (const pincode of pins) {
        results.push(await runImmediateCheck(product.id, pincode))
      }
      return results
    })()

    const raced = await Promise.race([
      work
        .then((results) => ({ done: true as const, results, scrapeError: null as string | null }))
        .catch((err) => ({
          done: true as const,
          results: [] as unknown[],
          scrapeError: err instanceof Error ? err.message : String(err),
        })),
      new Promise<{ done: false; scrapeError: null }>((resolve) =>
        setTimeout(() => resolve({ done: false, scrapeError: null }), waitMs),
      ),
    ])

    if (!raced.done) {
      void work.catch((err) => {
        console.error('[refresh] background scrape failed', err)
      })
      const updated = await prisma.product.findUnique({
        where: { id: product.id },
        include: { store: true, pincodes: true },
      })
      return res.json({
        ok: true,
        mode: 'async',
        pending: true,
        durationMs: Date.now() - t0,
        product: updated,
      })
    }

    const updated = await prisma.product.findUnique({
      where: { id: product.id },
      include: { store: true, pincodes: true },
    })
    return res.json({
      ok: !raced.scrapeError,
      mode: 'inline',
      pending: false,
      scrapeWarning: raced.scrapeError,
      durationMs: Date.now() - t0,
      results: raced.results,
      product: updated,
    })
  } catch (err) {
    next(err)
  }
})

productsRouter.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'Product not found' })
    await prisma.product.delete({ where: { id: existing.id } })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
