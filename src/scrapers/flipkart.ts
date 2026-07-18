import {
  extractJsonLd,
  fetchHtml,
  fetchHtmlBrowser,
  fetchPageSmart,
  parseMoney,
  pickMeta,
} from './fetchPage.js'
import { scrapeLimits } from './scrapeConfig.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

function normalizeFlipkartUrl(url: string) {
  let out = url.trim()
  if (out.includes('dl.flipkart.com/dl/')) {
    try {
      out = new URL(out.replace('dl.flipkart.com/dl/', 'www.flipkart.com/')).toString()
    } catch {
      out = out.replace('https://dl.flipkart.com/dl/', 'https://www.flipkart.com/')
    }
  }
  try {
    const u = new URL(out)
    if (!u.hostname.includes('dl.flipkart.com')) {
      u.search = ''
      u.hash = ''
    }
    return u.toString()
  } catch {
    return out
  }
}

/** "Buy at ₹38,949" — Flipkart WOW deal label (strongest signal). */
function extractBuyAtPrices(text: string): number[] {
  if (!text) return []
  const out: number[] = []
  const re = /Buy\s*(?:at|@)\s*(?:Rs\.?|INR)?\s*₹?\s*([\d,]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = parseMoney(m[1])
    if (n && n > 999) out.push(n)
  }
  return out
}

/**
 * Pair nepPrice + fsp from the SAME compact JSON object only.
 * Never mix EMI/exchange fsp blobs with another SKU's nep — that previously
 * let list price (₹27,999) look like WOW against a higher exchange fsp.
 */
function extractPpdPrices(text: string): { selling: number | null; wow: number | null } {
  let best: { selling: number; wow: number } | null = null

  const objRe = /\{[^{}]{0,600}\}/g
  let m: RegExpExecArray | null
  while ((m = objRe.exec(text)) !== null) {
    const obj = m[0]
    if (!/"nepPrice"\s*:/.test(obj)) continue
    if (!/"(?:fsp|finalPrice)"\s*:/.test(obj)) continue

    const nep = Number(obj.match(/"nepPrice"\s*:\s*(\d+)/i)?.[1] || 0)
    const fsp = Number(
      obj.match(/"fsp"\s*:\s*(\d+)/i)?.[1] ||
        obj.match(/"finalPrice"\s*:\s*(\d+)/i)?.[1] ||
        0,
    )
    if (!Number.isFinite(nep) || !Number.isFinite(fsp)) continue
    if (nep <= 0 || fsp <= 0 || nep >= fsp) continue

    // Prefer objects that look like the WOW deal card
    const wowMarked = /nepSubTitle|buyAtPrice|Lowest price|Apply offers/i.test(obj)
    if (!best) {
      best = { selling: fsp, wow: nep }
    } else if (wowMarked && nep <= best.wow) {
      best = { selling: fsp, wow: nep }
    } else if (!wowMarked && nep < best.wow) {
      best = { selling: fsp, wow: nep }
    }
  }

  return best ? { selling: best.selling, wow: best.wow } : { selling: null, wow: null }
}

function extractWowFromLowestLabel(
  $: ReturnType<typeof import('cheerio').load>,
): number | null {
  let found: number | null = null

  $('*').each((_, el) => {
    if (found) return
    const own = ($(el).clone().children().remove().end().text() || '').replace(/\s+/g, ' ').trim()
    if (!/^lowest price for you\.?$/i.test(own)) return

    const prevOwn = ($(el).prev().clone().children().remove().end().text() || '')
      .replace(/\s+/g, ' ')
      .trim()
    const n = parseMoney(prevOwn)
    if (n && n > 999 && prevOwn.length < 24) {
      found = n
      return
    }

    const block = ($(el).parent().text() || '').replace(/\s+/g, ' ')
    const idx = block.search(/lowest price for you/i)
    if (idx > 0) {
      const before = block.slice(Math.max(0, idx - 28), idx)
      if (!/emi|exchange|up\s*to|month|pay\s*₹/i.test(before)) {
        const all = [...before.matchAll(/₹\s*([\d,]+)/g)]
        const last = all.length ? parseMoney(all[all.length - 1][1]) : null
        if (last && last > 999) found = last
      }
    }
  })

  return found
}

function parseFlipkartDom($: ReturnType<typeof import('cheerio').load>) {
  const ld = extractJsonLd($)

  let embeddedSelling: number | null = null
  let embeddedWow: number | null = null
  let embeddedTitle: string | undefined
  let embeddedImage: string | undefined
  const buyAt: number[] = []

  $('script').each((_, el) => {
    const text = $(el).html() || ''
    if (text.length < 50) return

    const ppd = extractPpdPrices(text)
    // Keep the primary SKU pair (lowest real WOW), do not min() unrelated fsps
    if (ppd.wow && ppd.selling) {
      if (!embeddedWow || ppd.wow < embeddedWow) {
        embeddedWow = ppd.wow
        embeddedSelling = ppd.selling
      }
    }

    buyAt.push(...extractBuyAtPrices(text))

    const titleMatch = text.match(/"title"\s*:\s*"([^"]{5,120})"/)
    if (titleMatch && !embeddedTitle) embeddedTitle = titleMatch[1]

    const imgMatch =
      text.match(/"imageUrl"\s*:\s*"(https?:[^"]+)"/i) ||
      text.match(/"image"\s*:\s*"(https?:[^"]+)"/)
    if (imgMatch && !embeddedImage) embeddedImage = imgMatch[1].replace(/\\u002F/g, '/')
  })

  const bodyText = $('body').text() || ''
  buyAt.push(...extractBuyAtPrices(bodyText))

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

  const domSelling =
    parseMoney($('div._30jeq3._16Jk6d').first().text()) ||
    parseMoney($('div._30jeq3').first().text()) ||
    parseMoney($('[class*="Nx9bqj"]').first().text()) ||
    null

  const labelWow = extractWowFromLowestLabel($)
  const buyAtWow = buyAt.length ? Math.min(...buyAt.filter((n) => n > 999)) : null

  // List / selling price: prefer paired fsp from the WOW object; DOM as fallback
  const sellingPrice = embeddedSelling || domSelling || null

  /**
   * MANDATORY: accept WOW only from explicit UI markers (Buy at / Lowest price for you).
   * Bare nepPrice alone previously let list price slip through against a higher EMI fsp.
   */
  const explicitWow = [buyAtWow, labelWow].filter(
    (n): n is number => typeof n === 'number' && n > 999,
  )
  if (!explicitWow.length) {
    return { title, image, available: true, sellingPrice, wowPrice: null as number | null }
  }

  let wowPrice: number | null = Math.min(...explicitWow)

  // If nep agrees (or is lower but still below list), allow the lower confirmed WOW
  if (embeddedWow && sellingPrice && embeddedWow < sellingPrice) {
    if (explicitWow.some((e) => e === embeddedWow) || embeddedWow < wowPrice) {
      wowPrice = Math.min(wowPrice, embeddedWow)
    }
  }

  if (!sellingPrice || (wowPrice != null && wowPrice >= sellingPrice)) {
    wowPrice = null
  }

  const soldOutBanner = $('div._16FRp0').text().toLowerCase()
  const available =
    ld?.available ?? (soldOutBanner.includes('sold out') ? false : true)

  return {
    title,
    image,
    available,
    sellingPrice,
    wowPrice,
    buyAtWow,
    labelWow,
  }
}

function wowResult(
  parsed: ReturnType<typeof parseFlipkartDom>,
  rawNote: string,
): ScrapeResult | null {
  if (!parsed.wowPrice || !parsed.sellingPrice) return null
  if (parsed.wowPrice >= parsed.sellingPrice) return null
  // Must have come from Buy at / Lowest label path (enforced in parseFlipkartDom)
  if (!parsed.buyAtWow && !parsed.labelWow) return null

  return {
    title: parsed.title || undefined,
    image: parsed.image,
    price: parsed.wowPrice,
    oldPrice: parsed.wowPrice,
    discount: 0,
    available: parsed.available,
    source: 'live',
    rawNote: `${rawNote} wow=${parsed.wowPrice} sell=${parsed.sellingPrice} buyAt=${parsed.buyAtWow ?? '-'} label=${parsed.labelWow ?? '-'}`,
  }
}

async function scrapeFlipkart(ctx: ScrapeContext): Promise<ScrapeResult> {
  const url = normalizeFlipkartUrl(ctx.url)
  const limits = scrapeLimits()

  try {
    const $ = await fetchHtml(url)
    const hit = wowResult(parseFlipkartDom($), 'http-wow')
    if (hit) return hit
  } catch {
    /* fall through */
  }

  try {
    const $ = limits.httpOnly
      ? await fetchPageSmart(url, {
          preferBrowser: false,
          waitSelector: 'h1, div._30jeq3, [class*="Nx9bqj"]',
          waitText: /WOW|Lowest price for you|Buy at/i,
          navigationTimeoutMs: Math.max(limits.navigationTimeoutMs, 30_000),
          httpRender: Boolean(process.env.SCRAPERAPI_KEY),
        })
      : await fetchHtmlBrowser(url, {
          waitSelector: 'h1, div._30jeq3, [class*="Nx9bqj"]',
          waitText: /WOW|Lowest price for you|Buy at/i,
          waitMs: Math.max(limits.settleMs, 1500),
          navigationTimeoutMs: Math.max(limits.navigationTimeoutMs, 30_000),
        })

    const hit = wowResult(parseFlipkartDom($), 'browser-wow')
    if (hit) return hit

    throw new Error(
      'Flipkart WOW price not found (need Buy at / Lowest price for you — not list price)',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /timeout|disabled/i.test(msg)
        ? `Flipkart timed out looking for WOW price. Add SCRAPERAPI_KEY or retry. (${msg})`
        : msg,
    )
  }
}

export const flipkartScraper: StoreScraper = {
  slug: 'flipkart',
  scrape: scrapeFlipkart,
}
