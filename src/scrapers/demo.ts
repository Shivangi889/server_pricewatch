import type { ScrapeContext, ScrapeResult } from './types.js'

/** Deterministic-ish demo scrape so the worker pipeline is testable without live HTML. */
export function demoScrape(ctx: ScrapeContext): ScrapeResult {
  const base = ctx.previousPrice && ctx.previousPrice > 0 ? Number(ctx.previousPrice) : 999
  const roll = Math.random()

  let price = base
  let offerText: string | undefined
  let available = true

  if (roll < 0.25) {
    // price drop 1–8%
    price = Math.max(1, Math.round(base * (1 - (0.01 + Math.random() * 0.07))))
  } else if (roll < 0.4) {
    // price rise 1–5%
    price = Math.round(base * (1 + (0.01 + Math.random() * 0.04)))
  } else if (roll < 0.5) {
    offerText = 'Bank offer: 5% instant discount'
  }

  if (ctx.pincode) {
    // Flip availability for some pins to exercise pincode-available alerts
    if (ctx.previousAvailable === false && Math.random() < 0.45) {
      available = true
    } else if (ctx.previousAvailable === true && Math.random() < 0.15) {
      available = false
    } else if (ctx.previousAvailable == null) {
      available = Math.random() > 0.35
    } else {
      available = Boolean(ctx.previousAvailable)
    }
  }

  const oldPrice = Math.max(price, Math.round(price * 1.08))
  const discount = oldPrice > price ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0

  return {
    price,
    oldPrice,
    discount,
    available,
    offerText,
    source: 'demo',
    rawNote: ctx.pincode ? `demo pin ${ctx.pincode}` : 'demo ecommerce',
  }
}
