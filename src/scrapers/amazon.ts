import {
  discountFrom,
  extractAsin,
  extractJsonLd,
  fetchHtml,
  fetchPageSmart,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import { scrapeLimits } from './scrapeConfig.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

function amazonCanonicalUrl(url: string, asin: string | null) {
  if (asin) return `https://www.amazon.in/dp/${asin}`
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

async function scrapeAmazonAod(asin: string): Promise<Partial<ScrapeResult> | null> {
  const url = `https://www.amazon.in/gp/aod/ajax/ref=dp_aod_NEW_mbc?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`
  try {
    const $ = await fetchHtml(url, {
      Referer: `https://www.amazon.in/dp/${asin}`,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html,*/*',
    })
    const price =
      parseMoney($('#aod-price-1 .a-offscreen').first().text()) ||
      parseMoney($('#aod-offer-price .a-offscreen').first().text()) ||
      parseMoney($('.aod-landing-page-price .a-offscreen').first().text()) ||
      parseMoney($('.a-price .a-offscreen').first().text())

    if (!price) return null

    const oldPrice =
      parseMoney($('#aod-price-1 .aok-offscreen').first().text()) ||
      parseMoney($('.a-text-price .a-offscreen').first().text()) ||
      undefined

    const pinned = $('#aod-pinned-offer').text().toLowerCase()
    const available = !pinned.includes('unavailable')

    return {
      price,
      oldPrice,
      discount: discountFrom(oldPrice, price),
      available,
      source: 'live',
      rawNote: `aod:${asin}`,
    }
  } catch {
    return null
  }
}

async function enrichFromHttp(url: string) {
  try {
    const $ = await fetchHtml(url)
    const ld = extractJsonLd($)
    const title =
      pickMeta($, ['#productTitle', 'meta[property="og:title"]', 'title']) || ld?.title
    const image =
      $('#landingImage').attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      ld?.image
    return { title: title || undefined, image: image || undefined }
  } catch {
    return { title: undefined, image: undefined }
  }
}

function parsePdp($: ReturnType<typeof import('cheerio').load>, ld: ReturnType<typeof extractJsonLd>) {
  const title =
    pickMeta($, ['#productTitle', 'meta[property="og:title"]']) || ld?.title || undefined
  const image =
    $('#landingImage').attr('src') ||
    $('#imgTagWrapperId img').attr('src') ||
    $('meta[property="og:image"]').attr('content') ||
    ld?.image

  const price =
    parseMoney($('.a-price .a-offscreen').first().text()) ||
    parseMoney($('#corePrice_feature_div .a-offscreen').first().text()) ||
    parseMoney($('#corePriceDisplay_desktop_feature_div .a-offscreen').first().text()) ||
    parseMoney($('#priceblock_ourprice').text()) ||
    parseMoney($('#priceblock_dealprice').text()) ||
    parseMoney(
      $('span.a-price-whole').first().text() + $('span.a-price-fraction').first().text(),
    ) ||
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
    ld?.price ||
    null

  const oldPrice =
    parseMoney($('.a-price.a-text-price .a-offscreen').first().text()) ||
    parseMoney($('#listPrice').text()) ||
    parseMoney($('.a-text-price .a-offscreen').first().text()) ||
    undefined

  const availText = $('#availability').text().toLowerCase()
  const available =
    ld?.available ??
    (!availText.includes('unavailable') && !availText.includes('currently unavailable'))

  return { title, image, price, oldPrice, available }
}

async function scrapeAmazon(ctx: ScrapeContext): Promise<ScrapeResult> {
  const asin = extractAsin(ctx.url)
  const url = amazonCanonicalUrl(ctx.url, asin)
  const limits = scrapeLimits()

  // 1) AOD — light, no browser
  if (asin) {
    const aod = await scrapeAmazonAod(asin)
    if (aod?.price) {
      const meta = await enrichFromHttp(url)
      return {
        title: meta.title,
        image: meta.image,
        price: aod.price,
        oldPrice: aod.oldPrice,
        discount: aod.discount ?? 0,
        available: aod.available ?? true,
        source: 'live',
        rawNote: aod.rawNote,
      }
    }
  }

  // 2) HTTP PDP
  try {
    const $ = await fetchHtml(url)
    const ld = extractJsonLd($)
    const parsed = parsePdp($, ld)
    if (parsed.price) {
      return {
        title: parsed.title,
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
    /* continue */
  }

  // 3) Browser last (skipped on free Render without SCRAPERAPI_KEY)
  try {
    const $ = await fetchPageSmart(url, {
      preferBrowser: !limits.httpOnly,
      waitSelector: '#productTitle, .a-price .a-offscreen',
      navigationTimeoutMs: limits.navigationTimeoutMs,
      httpRender: Boolean(process.env.SCRAPERAPI_KEY),
    })
    const ld = extractJsonLd($)
    if (/robot|captcha|sorry/i.test($('title').text() + $('body').text().slice(0, 400))) {
      throw new Error('Amazon bot protection')
    }
    const parsed = parsePdp($, ld)
    if (!parsed.price) {
      throw new Error('Amazon: price not found. Use https://www.amazon.in/dp/ASIN')
    }
    return {
      title: parsed.title,
      image: parsed.image,
      price: parsed.price,
      oldPrice: parsed.oldPrice || undefined,
      discount: discountFrom(parsed.oldPrice, parsed.price),
      available: parsed.available,
      source: 'live',
      rawNote: limits.httpOnly ? 'http-proxy' : 'browser',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /timeout|disabled|bot/i.test(msg)
        ? `Amazon blocked/timed out on this server. Add SCRAPERAPI_KEY in Render env. (${msg})`
        : `Amazon scrape failed: ${msg}`,
    )
  }
}

export const amazonScraper: StoreScraper = {
  slug: 'amazon',
  scrape: scrapeAmazon,
}
