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

/** Flipkart product id from query (?pid=) or iid (….MOBxxxx.SEARCH). */
export function extractFlipkartPid(url: string): string | null {
  try {
    const u = new URL(url)
    const pid = u.searchParams.get('pid')
    if (pid && /^MOB[A-Z0-9]+$/i.test(pid)) return pid.toUpperCase()

    const iid = u.searchParams.get('iid') || ''
    const fromIid = iid.match(/\.(MOB[A-Z0-9]+)\./i)
    if (fromIid) return fromIid[1].toUpperCase()

    // Path sometimes unused; lid embeds pid after LST
    const lid = u.searchParams.get('lid') || ''
    const fromLid = lid.match(/^LST(MOB[A-Z0-9]+)/i)
    if (fromLid) return fromLid[1].toUpperCase()

    return null
  } catch {
    return null
  }
}

/**
 * Keep pid/lid/marketplace so Flipkart serves THAT variant.
 * Stripping pid (old behavior) made every color/RAM link fall back to the
 * default swatch — e.g. 4/64 WOW shown for an 8/128 URL.
 */
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
    // Search result pages are not a single SKU — refuse later
    if (/\/search/i.test(u.pathname)) return u.toString()

    if (!u.hostname.includes('dl.flipkart.com')) {
      const pid = u.searchParams.get('pid')
      const lid = u.searchParams.get('lid')
      const marketplace = u.searchParams.get('marketplace') || 'FLIPKART'
      u.search = ''
      u.hash = ''
      if (pid) u.searchParams.set('pid', pid)
      if (lid) u.searchParams.set('lid', lid)
      u.searchParams.set('marketplace', marketplace)
    }
    return u.toString()
  } catch {
    return out
  }
}

function assertProductUrl(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('Flipkart: invalid product URL')
  }
  if (/\/search/i.test(u.pathname) || u.searchParams.has('q') && !/\/p\//i.test(u.pathname)) {
    throw new Error(
      'Flipkart: paste a product page URL (…/p/itm…?pid=MOB…), not a search results link',
    )
  }
  if (!/\/p\//i.test(u.pathname) && !u.hostname.includes('dl.flipkart.com')) {
    throw new Error('Flipkart: URL must be a product page (/p/…) or short share link')
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
 * Never mix EMI/exchange fsp blobs with another SKU's nep.
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

/** Storage/RAM hints from URL slug — used to reject wrong-variant titles. */
function variantHintsFromUrl(url: string): { storageGb?: number; ramGb?: number; slug: string } {
  try {
    const slug = new URL(url).pathname.toLowerCase()
    // Prefer the last "-N-gb" in the slug (storage); ignore earlier noise like 5g
    const allGb = [...slug.matchAll(/-(\d+)-gb(?:-|$)/gi)]
    const storageGb = allGb.length ? Number(allGb[allGb.length - 1][1]) : undefined
    const ram = slug.match(/-(\d+)-gb-ram(?:-|$)/i)
    const ramGb = ram ? Number(ram[1]) : undefined
    return { storageGb, ramGb, slug }
  } catch {
    return { slug: '' }
  }
}

/**
 * Only fail when the page title clearly names a *different* storage size.
 * If the title has no parseable storage, allow (some Flipkart titles omit it).
 */
function titleMatchesUrlVariant(title: string | undefined, url: string): boolean {
  if (!title) return true
  const hints = variantHintsFromUrl(url)
  if (!hints.storageGb) return true

  const storages = new Set<number>()
  for (const m of title.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1]
    const ramOnly = [...inner.matchAll(/\b(\d+)\s*GB\s*RAM\b/gi)].map((x) => Number(x[1]))
    for (const g of inner.matchAll(/\b(\d+)\s*GB\b/gi)) {
      const n = Number(g[1])
      if (!ramOnly.includes(n)) storages.add(n)
    }
  }
  for (const m of title.matchAll(/\b(\d+)\s*GB\s*Storage\b/gi)) {
    storages.add(Number(m[1]))
  }

  if (storages.size === 0) return true
  return storages.has(hints.storageGb!)
}

function parseFlipkartDom(
  $: ReturnType<typeof import('cheerio').load>,
  opts?: { pid?: string | null; url?: string },
) {
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
  // With pid kept in the request URL, Buy-at on the page is for THIS variant —
  // do NOT Math.min across leftover swatch noise; prefer the first/primary Buy at,
  // then the min only among values that sit below this page's selling price.
  const buyAtAll = buyAt.filter((n) => n > 999)
  const sellingPrice = embeddedSelling || domSelling || null
  let buyAtWow: number | null = null
  if (buyAtAll.length) {
    if (sellingPrice) {
      const below = buyAtAll.filter((n) => n < sellingPrice)
      buyAtWow = below.length ? Math.min(...below) : null
    } else {
      buyAtWow = buyAtAll[0]
    }
  }

  const explicitWow = [buyAtWow, labelWow].filter(
    (n): n is number => typeof n === 'number' && n > 999,
  )
  if (!explicitWow.length) {
    return {
      title,
      image,
      available: true,
      sellingPrice,
      wowPrice: null as number | null,
      buyAtWow,
      labelWow,
      variantOk: true,
    }
  }

  let wowPrice: number | null = Math.min(...explicitWow)

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

  const variantOk = opts?.url ? titleMatchesUrlVariant(title, opts.url) : true

  return {
    title,
    image,
    available,
    sellingPrice,
    wowPrice,
    buyAtWow,
    labelWow,
    variantOk,
    pid: opts?.pid || undefined,
  }
}

function wowResult(
  parsed: ReturnType<typeof parseFlipkartDom>,
  rawNote: string,
): ScrapeResult | null {
  if (!parsed.wowPrice || !parsed.sellingPrice) return null
  if (parsed.wowPrice >= parsed.sellingPrice) return null
  if (!parsed.buyAtWow && !parsed.labelWow) return null
  if (parsed.variantOk === false) return null

  return {
    title: parsed.title || undefined,
    image: parsed.image,
    price: parsed.wowPrice,
    oldPrice: parsed.wowPrice,
    discount: 0,
    available: parsed.available,
    source: 'live',
    rawNote:
      `${rawNote} wow=${parsed.wowPrice} sell=${parsed.sellingPrice} ` +
      `buyAt=${parsed.buyAtWow ?? '-'} label=${parsed.labelWow ?? '-'} ` +
      `pid=${parsed.pid ?? '-'}`,
  }
}

async function scrapeFlipkart(ctx: ScrapeContext): Promise<ScrapeResult> {
  assertProductUrl(ctx.url)
  const url = normalizeFlipkartUrl(ctx.url)
  assertProductUrl(url)
  const pid = extractFlipkartPid(url) || extractFlipkartPid(ctx.url)
  const limits = scrapeLimits()

  const tryParse = ($: ReturnType<typeof import('cheerio').load>, note: string) => {
    const parsed = parseFlipkartDom($, { pid, url: ctx.url })
    if (parsed.variantOk === false) {
      throw new Error(
        `Flipkart variant mismatch: page title "${parsed.title}" does not match URL variant ` +
          `(expected storage/RAM from link). Keep ?pid= in the product URL.`,
      )
    }
    return wowResult(parsed, note)
  }

  try {
    const $ = await fetchHtml(url)
    const hit = tryParse($, 'http-wow')
    if (hit) return hit
  } catch (err) {
    // Variant mismatch should not fall through silently to another variant
    if (err instanceof Error && /variant mismatch/i.test(err.message)) throw err
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

    const hit = tryParse($, 'browser-wow')
    if (hit) return hit

    throw new Error(
      'Flipkart WOW price not found (need Buy at / Lowest price for you — not list price)',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/variant mismatch/i.test(msg)) throw err
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
