import {
  discountFrom,
  extractAsin,
  extractJsonLd,
  fetchHtml,
  fetchPageSmart,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import { isCloudHost, scrapeLimits } from './scrapeConfig.js'
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

function looksBlocked($: ReturnType<typeof import('cheerio').load>) {
  const title = ($('title').text() || '').toLowerCase()
  const body = ($('body').text() || '').slice(0, 1200).toLowerCase()
  return /robot|captcha|sorry|opfcaptcha|validatecaptcha|enter the characters|api\.scraperapi|access denied|automated access/i.test(
    title + ' ' + body,
  )
}

/**
 * Amazon often embeds price in JS even when CSS price nodes are stripped / lazy.
 * Prefer values that look like INR product prices (not EMI monthly crumbs).
 */
function extractEmbeddedPrices(html: string): number[] {
  if (!html || html.length < 80) return []
  const out: number[] = []
  const push = (n: number | null) => {
    if (n && n >= 49 && n <= 2_000_000) out.push(Math.round(n))
  }

  for (const m of html.matchAll(/"priceAmount"\s*:\s*([\d.]+)/gi)) {
    push(Number(m[1]))
  }
  for (const m of html.matchAll(/"buyingPrice"\s*:\s*"?([\d.]+)"?/gi)) {
    push(Number(m[1]))
  }
  for (const m of html.matchAll(
    /"displayPrice"\s*:\s*"\\?u0?0?20[bB]?\s*([\d,.]+)"|"displayPrice"\s*:\s*"₹\s*([\d,.]+)"/gi,
  )) {
    push(parseMoney(m[1] || m[2]))
  }
  for (const m of html.matchAll(/data-a-color-price="([\d,.]+)"/gi)) {
    push(parseMoney(m[1]))
  }
  for (const m of html.matchAll(
    /"amount"\s*:\s*([\d.]+)\s*,\s*"currencyCode"\s*:\s*"INR"/gi,
  )) {
    push(Number(m[1]))
  }
  for (const m of html.matchAll(
    /apexPriceToPay[\s\S]{0,240}?a-offscreen[^>]*>\s*₹?\s*([\d,.]+)/gi,
  )) {
    push(parseMoney(m[1]))
  }

  return [...new Set(out)]
}

function pickBestEmbedded(prices: number[]): number | null {
  if (!prices.length) return null
  // Prefer the most common value (PDP main price repeats); else median-ish mid
  const counts = new Map<number, number>()
  for (const p of prices) counts.set(p, (counts.get(p) || 0) + 1)
  let best = prices[0]
  let bestN = 0
  for (const [p, n] of counts) {
    if (n > bestN || (n === bestN && p < best)) {
      best = p
      bestN = n
    }
  }
  return best
}

async function scrapeAmazonAod(asin: string): Promise<Partial<ScrapeResult> | null> {
  const url = `https://www.amazon.in/gp/aod/ajax/ref=dp_aod_NEW_mbc?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`
  try {
    const $ = await fetchHtml(url, {
      Referer: `https://www.amazon.in/dp/${asin}`,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html,*/*',
    })
    if (looksBlocked($)) return null

    const price =
      parseMoney($('#aod-price-1 .a-offscreen').first().text()) ||
      parseMoney($('#aod-offer-price .a-offscreen').first().text()) ||
      parseMoney($('.aod-landing-page-price .a-offscreen').first().text()) ||
      parseMoney($('.a-price .a-offscreen').first().text()) ||
      pickBestEmbedded(extractEmbeddedPrices($.html()))

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
    if (looksBlocked($)) return { title: undefined, image: undefined }
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
    parseMoney($('#tp_price_block_total_price_ww .a-offscreen').first().text()) ||
    parseMoney($('.apexPriceToPay .a-offscreen').first().text()) ||
    parseMoney(
      $('span.a-price-whole').first().text() + $('span.a-price-fraction').first().text(),
    ) ||
    parseMoney($('meta[property="product:price:amount"]').attr('content')) ||
    ld?.price ||
    pickBestEmbedded(extractEmbeddedPrices($.html())) ||
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

function cloudBlockedError(detail: string) {
  const hasKey = Boolean(process.env.SCRAPERAPI_KEY?.trim())
  if (isCloudHost() && !hasKey) {
    return new Error(
      'Amazon blocks Railway/cloud server IPs (works on your PC). ' +
        'Add SCRAPERAPI_KEY in Railway Variables (https://www.scraperapi.com), redeploy, then refresh. ' +
        `(${detail})`,
    )
  }
  if (isCloudHost() && hasKey) {
    return new Error(
      'Amazon still blocked even with ScraperAPI. Check the key, enable “render” / residential if needed, then retry. ' +
        `(${detail})`,
    )
  }
  return new Error(`Amazon scrape failed: ${detail}`)
}

async function scrapeAmazon(ctx: ScrapeContext): Promise<ScrapeResult> {
  const asin = extractAsin(ctx.url)
  if (!asin) {
    throw new Error(
      'Amazon link needs a product ASIN. Open the product on Amazon.in and copy a URL like https://www.amazon.in/dp/B0XXXXXXXX',
    )
  }

  const url = amazonCanonicalUrl(ctx.url, asin)
  const mobileUrl = `https://www.amazon.in/gp/aw/d/${asin}`
  const limits = scrapeLimits()
  const cloud = isCloudHost()
  const hasProxy = Boolean(process.env.SCRAPERAPI_KEY?.trim())

  // On Railway/cloud: prefer ScraperAPI (with JS render) first — direct HTTP is almost always blocked
  if (cloud && hasProxy) {
    try {
      const $ = await fetchHtml(url, {}, { render: true })
      if (!looksBlocked($)) {
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
            rawNote: `scraperapi-render:${asin}`,
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 1) AOD — light, no browser
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

  // 2) HTTP PDP (+ mobile soft try)
  for (const tryUrl of [url, mobileUrl]) {
    try {
      const $ = await fetchHtml(tryUrl, {}, cloud && hasProxy ? { render: true } : undefined)
      if (looksBlocked($)) continue
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
          rawNote: tryUrl.includes('/gp/aw/') ? 'http-mobile' : 'http',
        }
      }
    } catch {
      /* continue */
    }
  }

  // 3) Browser / smart fetch (Playwright locally; ScraperAPI render on cloud)
  try {
    const $ = await fetchPageSmart(url, {
      preferBrowser: !limits.httpOnly && !cloud,
      waitSelector: '#productTitle, .a-price .a-offscreen, #corePrice_feature_div',
      navigationTimeoutMs: Math.max(limits.navigationTimeoutMs, cloud ? 25_000 : 35_000),
      httpRender: hasProxy,
    })
    if (looksBlocked($)) {
      throw cloudBlockedError('bot/captcha page')
    }
    const ld = extractJsonLd($)
    const parsed = parsePdp($, ld)
    if (!parsed.price) {
      throw cloudBlockedError('price not found on page')
    }
    return {
      title: parsed.title,
      image: parsed.image,
      price: parsed.price,
      oldPrice: parsed.oldPrice || undefined,
      discount: discountFrom(parsed.oldPrice, parsed.price),
      available: parsed.available,
      source: 'live',
      rawNote: cloud ? (hasProxy ? 'cloud-proxy' : 'cloud-http') : 'browser',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Amazon blocks Railway|Amazon still blocked|Amazon link needs/i.test(msg)) {
      throw err instanceof Error ? err : new Error(msg)
    }
    throw cloudBlockedError(msg)
  }
}

export const amazonScraper: StoreScraper = {
  slug: 'amazon',
  scrape: scrapeAmazon,
}
