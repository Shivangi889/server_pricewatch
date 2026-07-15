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

function normalizeFlipkartUrl(url: string) {
  let out = url
  if (out.includes('dl.flipkart.com')) {
    try {
      out = new URL(out.replace('dl.flipkart.com/dl/', 'www.flipkart.com/')).toString()
    } catch {
      out = out.replace('https://dl.flipkart.com/dl/', 'https://www.flipkart.com/')
    }
  }
  // Drop tracking query noise
  try {
    const u = new URL(out)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return out
  }
}

function parseFlipkartDom($: ReturnType<typeof import('cheerio').load>) {
  const ld = extractJsonLd($)

  let embeddedPrice: number | null = null
  let embeddedOld: number | null = null
  let embeddedTitle: string | undefined
  let embeddedImage: string | undefined
  let embeddedAvailable: boolean | undefined

  $('script').each((_, el) => {
    const text = $(el).html() || ''
    if (!text.includes('price') || text.length < 50) return

    const finalMatch =
      text.match(/"final_price"\s*:\s*(\d+)/i) || text.match(/"finalPrice"\s*:\s*(\d+)/)
    const priceMatch = text.match(/"price"\s*:\s*(\d+)/)
    const mrpMatch = text.match(/"mrp"\s*:\s*(\d+)/i) || text.match(/"strikePrice"\s*:\s*(\d+)/)
    if (finalMatch) embeddedPrice = Number(finalMatch[1])
    else if (priceMatch && !embeddedPrice) embeddedPrice = Number(priceMatch[1])
    if (mrpMatch) embeddedOld = Number(mrpMatch[1])

    const titleMatch = text.match(/"title"\s*:\s*"([^"]{5,120})"/)
    if (titleMatch && !embeddedTitle) embeddedTitle = titleMatch[1]

    const imgMatch =
      text.match(/"imageUrl"\s*:\s*"(https?:[^"]+)"/i) ||
      text.match(/"image"\s*:\s*"(https?:[^"]+)"/)
    if (imgMatch && !embeddedImage) embeddedImage = imgMatch[1].replace(/\\u002F/g, '/')
  })

  const title =
    pickMeta($, ['span.B_NuCI', 'h1 span', 'h1', 'meta[property="og:title"]']) ||
    embeddedTitle ||
    ld?.title ||
    undefined

  const image =
    $('img._396cs4').attr('src') ||
    $('img[src*="flixcart.com/image"]').first().attr('src') ||
    $('meta[property="og:image"]').attr('content') ||
    embeddedImage ||
    ld?.image

  const price =
    parseMoney($('div._30jeq3._16Jk6d').first().text()) ||
    parseMoney($('div._30jeq3').first().text()) ||
    parseMoney($('[class*="Nx9bqj"]').first().text()) ||
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
    embeddedPrice ||
    ld?.price ||
    null

  const oldPrice =
    parseMoney($('div._3I9_wc').first().text()) ||
    parseMoney($('[class*="yRaY8j"]').first().text()) ||
    embeddedOld ||
    undefined

  const soldOutBanner = $('div._16FRp0').text().toLowerCase()
  const available =
    embeddedAvailable ??
    ld?.available ??
    (soldOutBanner.includes('sold out') ? false : true)

  return { title, image, price, oldPrice, available }
}

async function scrapeFlipkart(ctx: ScrapeContext): Promise<ScrapeResult> {
  const url = normalizeFlipkartUrl(ctx.url)
  const limits = scrapeLimits()

  // 1) HTTP first — Flipkart often embeds price in scripts without a full browser
  try {
    const $ = await fetchHtml(url)
    const parsed = parseFlipkartDom($)
    if (parsed.price) {
      return {
        title: parsed.title || undefined,
        image: parsed.image,
        price: parsed.price,
        oldPrice: parsed.oldPrice || undefined,
        discount: discountFrom(parsed.oldPrice, parsed.price),
        available: parsed.available,
        source: 'live',
        rawNote: 'http',
      }
    }
  } catch {
    /* fall through */
  }

  // 2) Smart fetch (HTTP again / short browser / ScraperAPI)
  try {
    const $ = await fetchPageSmart(url, {
      preferBrowser: !limits.httpOnly,
      waitSelector: 'div._30jeq3, [class*="Nx9bqj"], h1',
      navigationTimeoutMs: limits.navigationTimeoutMs,
      httpRender: Boolean(process.env.SCRAPERAPI_KEY),
    })
    const parsed = parseFlipkartDom($)
    if (!parsed.price) {
      throw new Error('Flipkart: price not found (blocked or invalid URL)')
    }
    return {
      title: parsed.title || undefined,
      image: parsed.image,
      price: parsed.price,
      oldPrice: parsed.oldPrice || undefined,
      discount: discountFrom(parsed.oldPrice, parsed.price),
      available: parsed.available,
      source: 'live',
      rawNote: limits.httpOnly ? 'http-proxy' : 'smart',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /timeout|disabled/i.test(msg)
        ? `Flipkart timed out on this server. Add SCRAPERAPI_KEY or retry. (${msg})`
        : msg,
    )
  }
}

export const flipkartScraper: StoreScraper = {
  slug: 'flipkart',
  scrape: scrapeFlipkart,
}
