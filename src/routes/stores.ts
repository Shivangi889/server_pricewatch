import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

export const storesRouter = Router()

storesRouter.use(requireAuth)

function serializeStore(store: {
  _count?: { products: number }
  productCount?: number
  [key: string]: unknown
}) {
  const { _count, ...rest } = store
  return {
    ...rest,
    productCount: _count?.products ?? store.productCount ?? 0,
  }
}

storesRouter.get('/', async (_req, res, next) => {
  try {
    const stores = await prisma.store.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    })
    res.json({ stores: stores.map(serializeStore) })
  } catch (err) {
    next(err)
  }
})

const createStoreSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  website: z.string().url().optional().or(z.literal('')),
  color: z.string().optional(),
  requiresPincode: z.boolean().optional(),
  category: z.enum(['ecommerce', 'quick_commerce']).optional(),
})

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `store-${Date.now()}`
  )
}

storesRouter.post('/', async (req, res, next) => {
  try {
    const body = createStoreSchema.parse(req.body)
    const cleanDomain = body.domain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]

    let slug = slugify(body.name)
    const existing = await prisma.store.findUnique({ where: { slug } })
    if (existing) slug = `${slug}-${Date.now().toString(36)}`

    const requiresPincode = body.requiresPincode ?? false
    const store = await prisma.store.create({
      data: {
        slug,
        name: body.name.trim(),
        domain: cleanDomain,
        website: body.website || `https://www.${cleanDomain}`,
        color: body.color || '#10B981',
        requiresPincode,
        category: body.category || (requiresPincode ? 'quick_commerce' : 'ecommerce'),
        builtIn: false,
      },
      include: { _count: { select: { products: true } } },
    })

    res.status(201).json({ store: serializeStore(store) })
  } catch (err) {
    next(err)
  }
})

storesRouter.delete('/:id', async (req, res, next) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: req.params.id } })
    if (!store) return res.status(404).json({ error: 'Store not found' })
    if (store.builtIn) {
      return res.status(400).json({ error: 'Built-in stores cannot be deleted' })
    }

    const productCount = await prisma.product.count({ where: { storeId: store.id } })
    if (productCount > 0) {
      return res.status(400).json({ error: 'Remove products for this store first' })
    }

    await prisma.store.delete({ where: { id: store.id } })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

const updateStoreSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  website: z.string().url().optional().or(z.literal('')),
  color: z.string().optional(),
  requiresPincode: z.boolean().optional(),
  category: z.enum(['ecommerce', 'quick_commerce']).optional(),
})

storesRouter.patch('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.store.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'Store not found' })
    if (existing.builtIn) {
      return res.status(400).json({ error: 'Built-in stores cannot be edited' })
    }

    const body = updateStoreSchema.parse(req.body)
    const data: Record<string, unknown> = {}

    if (body.name != null) data.name = body.name.trim()
    if (body.domain != null) {
      data.domain = body.domain
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
    }
    if (body.website != null) data.website = body.website || null
    if (body.color != null) data.color = body.color
    if (body.requiresPincode != null) {
      data.requiresPincode = body.requiresPincode
      data.category = body.requiresPincode ? 'quick_commerce' : 'ecommerce'
    }
    if (body.category != null) data.category = body.category

    const store = await prisma.store.update({
      where: { id: existing.id },
      data,
      include: { _count: { select: { products: true } } },
    })

    res.json({ store: serializeStore(store) })
  } catch (err) {
    next(err)
  }
})
