import { AlertType, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { scrapeProduct } from '../scrapers/index.js'
import { withScrapeGate } from '../scrapers/scrapeGate.js'
import { logActivity, sendTelegram } from './telegram.js'
import {
  discountChangeAlert,
  newOfferAlert,
  pincodeAvailableAlert,
  priceDropAlert,
  priceUpAlert,
  type AlertCopy,
} from './alertMessage.js'

export type CheckJobData = {
  productId: string
  pincode?: string
}

function money(n: number) {
  return new Prisma.Decimal(n)
}

function formatInr(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n)
}

/** Prefer nickname → live scrape title → DB title (skip placeholder "Product"). */
function displayName(
  product: { nickname: string | null; title: string },
  scrapeTitle?: string | null,
) {
  const nick = product.nickname?.trim()
  if (nick) return nick

  const clean = (raw?: string | null) => {
    const t = raw?.trim()
    if (!t) return null
    if (/^https?:\/\//i.test(t)) return null
    if (t.toLowerCase() === 'product') return null
    return t
  }

  return clean(scrapeTitle) || clean(product.title) || 'Tracked item'
}

async function shouldAlert(type: AlertType) {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!owner) return false
  if (owner.pauseTracking) return false
  switch (type) {
    case 'price_decrease':
      return owner.alertPriceDecrease
    case 'price_increase':
      return owner.alertPriceIncrease
    case 'discount_change':
      return owner.alertDiscountChange
    case 'new_offer':
      return owner.alertNewOffer
    case 'pincode_available':
      return owner.alertPincodeAvailable
    default:
      return true
  }
}

async function createAlert(opts: {
  productId: string
  type: AlertType
  copy: AlertCopy
  oldPrice?: number
  newPrice?: number
  pincode?: string
  telegramEnabled: boolean
}) {
  if (!(await shouldAlert(opts.type))) return null

  const notification = await prisma.notification.create({
    data: {
      productId: opts.productId,
      type: opts.type,
      message: opts.copy.dashboard,
      oldPrice: opts.oldPrice != null ? money(opts.oldPrice) : undefined,
      newPrice: opts.newPrice != null ? money(opts.newPrice) : undefined,
      pincode: opts.pincode,
    },
  })

  if (opts.telegramEnabled) {
    await sendTelegram(opts.copy.telegram, { html: true })
  }

  return notification
}

export async function checkProductJob(data: CheckJobData) {
  const product = await prisma.product.findUnique({
    where: { id: data.productId },
    include: { store: true, pincodes: true },
  })

  if (!product) {
    await logActivity('warn', 'worker', `Product missing: ${data.productId}`)
    return { ok: false, reason: 'not_found' }
  }

  if (product.status === 'paused') {
    return { ok: false, reason: 'paused' }
  }

  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (owner?.pauseTracking) {
    return { ok: false, reason: 'global_pause' }
  }

  const pinRow = data.pincode
    ? product.pincodes.find((p) => p.pincode === data.pincode)
    : undefined

  if (product.store.requiresPincode && !data.pincode) {
    await logActivity('warn', 'worker', `Pincode required for ${product.title}`)
    return { ok: false, reason: 'pincode_required' }
  }

  const previousPrice = Number(product.currentPrice)
  const previousDiscount = product.discount
  const previousAvailable = pinRow?.lastAvailable ?? null

  let scrape
  try {
    scrape = await withScrapeGate(() =>
      scrapeProduct({
        url: product.url,
        storeSlug: product.store.slug,
        pincode: data.pincode,
        previousPrice,
        previousAvailable,
      }),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'scrape failed'
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'error', lastChecked: new Date() },
    })
    await logActivity('error', product.store.slug, `${product.title}: ${msg}`)
    throw err
  }

  const alerts: string[] = []
  const name = displayName(product, scrape.title)
  const base = {
    name,
    storeName: product.store.name,
    url: product.url,
    pincode: data.pincode,
    price: scrape.price,
  }

  if (data.pincode && pinRow) {
    if (previousAvailable === false && scrape.available === true) {
      await createAlert({
        productId: product.id,
        type: 'pincode_available',
        copy: pincodeAvailableAlert({ ...base, price: scrape.price }),
        newPrice: scrape.price,
        pincode: data.pincode,
        telegramEnabled: product.telegramEnabled,
      })
      alerts.push('pincode_available')
    }

    await prisma.productPincode.update({
      where: { id: pinRow.id },
      data: {
        lastAvailable: scrape.available,
        lastCheckedAt: new Date(),
      },
    })
  }

  const canPriceAlert = !data.pincode || scrape.available

  if (canPriceAlert && previousPrice > 0 && scrape.price < previousPrice) {
    await createAlert({
      productId: product.id,
      type: 'price_decrease',
      copy: priceDropAlert({
        ...base,
        oldPrice: previousPrice,
        newPrice: scrape.price,
      }),
      oldPrice: previousPrice,
      newPrice: scrape.price,
      pincode: data.pincode,
      telegramEnabled: product.telegramEnabled,
    })
    alerts.push('price_decrease')
  } else if (canPriceAlert && previousPrice > 0 && scrape.price > previousPrice) {
    await createAlert({
      productId: product.id,
      type: 'price_increase',
      copy: priceUpAlert({
        ...base,
        oldPrice: previousPrice,
        newPrice: scrape.price,
      }),
      oldPrice: previousPrice,
      newPrice: scrape.price,
      pincode: data.pincode,
      telegramEnabled: product.telegramEnabled,
    })
    alerts.push('price_increase')
  }

  const newDiscount = scrape.discount ?? 0
  if (canPriceAlert && previousDiscount !== newDiscount && previousPrice > 0) {
    await createAlert({
      productId: product.id,
      type: 'discount_change',
      copy: discountChangeAlert({
        ...base,
        oldDiscount: previousDiscount,
        newDiscount,
      }),
      oldPrice: previousPrice,
      newPrice: scrape.price,
      pincode: data.pincode,
      telegramEnabled: product.telegramEnabled,
    })
    alerts.push('discount_change')
  }

  if (scrape.offerText) {
    await createAlert({
      productId: product.id,
      type: 'new_offer',
      copy: newOfferAlert({ ...base, offerText: scrape.offerText }),
      pincode: data.pincode,
      telegramEnabled: product.telegramEnabled,
    })
    alerts.push('new_offer')
  }

  await prisma.priceHistory.create({
    data: {
      productId: product.id,
      price: money(scrape.price),
      discount: newDiscount,
      pincode: data.pincode,
    },
  })

  await prisma.product.update({
    where: { id: product.id },
    data: {
      status: 'tracking',
      lastChecked: new Date(),
      currentPrice: money(scrape.price),
      oldPrice: money(scrape.oldPrice || previousPrice || scrape.price),
      discount: newDiscount,
      title: name === 'Tracked item' ? product.title : name,
      image: scrape.image || product.image,
      availability: scrape.available ? 'in_stock' : 'out_of_stock',
    },
  })

  await logActivity(
    'info',
    'tracker',
    `Checked ${name}${data.pincode ? ` @${data.pincode}` : ''} → ${formatInr(scrape.price)} (${scrape.source})${alerts.length ? ` alerts=${alerts.join(',')}` : ''}`,
  )

  return {
    ok: true,
    source: scrape.source,
    price: scrape.price,
    available: scrape.available,
    alerts,
  }
}
