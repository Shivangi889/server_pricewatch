import {
  discountFrom,
  extractJsonLd,
  fetchHtml,
  fetchPageSmart,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import { scrapeLimits } from './scrapeConfig.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

async function scrapeLivePage(
  ctx: ScrapeContext,
  label: string,
): Promise<ScrapeResult> {
  const limits = scrapeLimits()

  // HTTP/og:meta first — enough for many quick-commerce PDPs
  try {
    const $ = await fetchHtml(ctx.url, ctx.pincode ? { Cookie: `pincode=${ctx.pincode}` } : {})
    const ld = extractJsonLd($)
    const title =
      pickMeta($, ['meta[property="og:title"]', 'h1', 'title']) || ld?.title || undefined
    const image = $('meta[property="og:image"]').attr('content') || ld?.image
    const price =
      parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
      parseMoney($('[itemprop="price"]').attr('content')) ||
      parseMoney($('[class*="Price"]').first().text()) ||
      parseMoney($('[class*="price"]').first().text()) ||
      ld?.price ||
      null
    if (price) {
      const oldPrice =
        parseMoney($('[class*="mrp"]').first().text()) ||
        parseMoney($('[class*="strike"]').first().text()) ||
        parseMoney($('s').first().text()) ||
        undefined
      const bodyText = $('body').text().toLowerCase()
      const available =
        ld?.available ??
        (!bodyText.includes('out of stock') &&
          !bodyText.includes('unavailable') &&
          !bodyText.includes('not deliverable'))
      return {
        title: title || undefined,
        image,
        price,
        oldPrice: oldPrice || undefined,
        discount: discountFrom(oldPrice, price),
        available,
        source: 'live',
        rawNote: ctx.pincode ? `http pin ${ctx.pincode}` : 'http',
      }
    }
  } catch {
    /* fall through */
  }

  const $ = await fetchPageSmart(ctx.url, {
    pincode: ctx.pincode,
    preferBrowser: !limits.httpOnly,
    navigationTimeoutMs: limits.navigationTimeoutMs,
    httpRender: Boolean(process.env.SCRAPERAPI_KEY),
  })
  const ld = extractJsonLd($)

  const title =
    pickMeta($, ['meta[property="og:title"]', 'h1', 'title']) || ld?.title || undefined
  const image = $('meta[property="og:image"]').attr('content') || ld?.image

  const price =
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
    parseMoney($('[itemprop="price"]').attr('content')) ||
    parseMoney($('[class*="Price"]').first().text()) ||
    parseMoney($('[class*="price"]').first().text()) ||
    ld?.price ||
    null

  const oldPrice =
    parseMoney($('[class*="mrp"]').first().text()) ||
    parseMoney($('[class*="strike"]').first().text()) ||
    parseMoney($('s').first().text()) ||
    undefined

  if (!price) {
    throw new Error(
      `${label}: price not found. Use a direct product URL` +
        (ctx.pincode ? ` (pincode ${ctx.pincode})` : ''),
    )
  }

  const bodyText = $('body').text().toLowerCase()
  const available =
    ld?.available ??
    (!bodyText.includes('out of stock') &&
      !bodyText.includes('unavailable') &&
      !bodyText.includes('not deliverable') &&
      !bodyText.includes('currently unavailable'))

  return {
    title: title || undefined,
    image,
    price,
    oldPrice: oldPrice || undefined,
    discount: discountFrom(oldPrice, price),
    available,
    source: 'live',
    rawNote: ctx.pincode ? `pin ${ctx.pincode}` : undefined,
  }
}

export const meeshoScraper: StoreScraper = {
  slug: 'meesho',
  scrape: (ctx) => scrapeLivePage(ctx, 'Meesho'),
}

export const blinkitScraper: StoreScraper = {
  slug: 'blinkit',
  scrape: (ctx) => scrapeLivePage(ctx, 'Blinkit'),
}

export const zeptoScraper: StoreScraper = {
  slug: 'zepto',
  scrape: (ctx) => scrapeLivePage(ctx, 'Zepto'),
}

export const instamartScraper: StoreScraper = {
  slug: 'instamart',
  scrape: (ctx) => scrapeLivePage(ctx, 'Instamart'),
}

export const bigbasketScraper: StoreScraper = {
  slug: 'bigbasket',
  scrape: (ctx) => scrapeLivePage(ctx, 'BigBasket'),
}

export const relianceDigitalScraper: StoreScraper = {
  slug: 'reliance-digital',
  scrape: (ctx) => scrapeLivePage(ctx, 'Reliance Digital'),
}

export const jiomartScraper: StoreScraper = {
  slug: 'jiomart',
  scrape: (ctx) => scrapeLivePage(ctx, 'JioMart'),
}

export const cromaScraper: StoreScraper = {
  slug: 'croma',
  scrape: (ctx) => scrapeLivePage(ctx, 'Croma'),
}
