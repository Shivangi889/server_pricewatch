import * as cheerio from 'cheerio'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Browser } from 'playwright'
import { isCloudHost, scrapeLimits } from './scrapeConfig.js'

chromium.use(StealthPlugin())

type CheerioRoot = ReturnType<typeof cheerio.load>

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
}

let browserPromise: Promise<Browser> | null = null

const LOW_MEM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--mute-audio',
]

async function getBrowser() {
  if (!browserPromise) {
    const launch = async () => {
      try {
        return await chromium.launch({
          channel: 'chrome',
          headless: true,
          args: LOW_MEM_ARGS,
        })
      } catch {
        return chromium.launch({
          headless: true,
          args: LOW_MEM_ARGS,
        })
      }
    }
    browserPromise = launch() as Promise<Browser>
  }
  return browserPromise
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise
    browserPromise = null
    await b.close()
  }
}

/**
 * HTTP-only path via ScraperAPI — only kicks in on cloud hosts (Railway/
 * Render/Fly), where direct requests get IP-blocked. On a local machine the
 * direct connection almost always works fine, so we skip the proxy there
 * even if SCRAPERAPI_KEY happens to be set (e.g. for testing prod issues) —
 * otherwise every single scrape gets routed through ScraperAPI locally too,
 * and any hiccup with that key (rate limit, plan restriction, wrong param)
 * takes down scraping entirely even though direct access works.
 * Pass `force: true` to deliberately exercise the proxy path locally.
 */
export function withScraperProxy(
  targetUrl: string,
  opts?: { render?: boolean; force?: boolean },
) {
  const key = process.env.SCRAPERAPI_KEY?.trim()
  if (!key) return targetUrl
  if (!opts?.force && !isCloudHost()) return targetUrl
  const params = new URLSearchParams({
    api_key: key,
    url: targetUrl,
    country_code: 'in',
    // JS render is slow/expensive — off by default; Amazon on cloud usually needs it
    render: opts?.render ? 'true' : 'false',
  })
  // Residential / premium IPs help Amazon (optional paid ScraperAPI feature)
  if ((process.env.SCRAPERAPI_PREMIUM || '').toLowerCase() === 'true') {
    params.set('premium', 'true')
  }
  return `https://api.scraperapi.com?${params.toString()}`
}

export async function fetchHtml(
  url: string,
  extraHeaders: Record<string, string> = {},
  opts?: { render?: boolean },
) {
  const limits = scrapeLimits()
  const finalUrl = withScraperProxy(url, opts)
  const res = await fetch(finalUrl, {
    headers: finalUrl.includes('scraperapi.com')
      ? { Accept: 'text/html' }
      : { ...DEFAULT_HEADERS, ...extraHeaders },
    redirect: 'follow',
    signal: AbortSignal.timeout(limits.httpTimeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return cheerio.load(await res.text())
}

export async function fetchHtmlBrowser(
  url: string,
  opts?: {
    pincode?: string
    waitMs?: number
    waitSelector?: string
    waitText?: string | RegExp
    navigationTimeoutMs?: number
  },
) {
  const limits = scrapeLimits()
  if (limits.httpOnly) {
    throw new Error(
      'Browser scraping disabled on this host (set SCRAPE_ALLOW_BROWSER=true or SCRAPERAPI_KEY).',
    )
  }

  const browser = await getBrowser()
  const navTimeout = opts?.navigationTimeoutMs ?? limits.navigationTimeoutMs
  const context = await browser.newContext({
    userAgent: DEFAULT_HEADERS['User-Agent'],
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1024, height: 720 },
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  })

  if (opts?.pincode) {
    const host = new URL(url).hostname
    await context.addCookies([
      {
        name: 'pincode',
        value: opts.pincode,
        domain: host.replace(/^www\./, ''),
        path: '/',
      },
    ])
  }

  const page = await context.newPage()
  // Block heavy assets — price is in HTML/JSON, not images
  await page.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      return route.abort()
    }
    return route.continue()
  })

  try {
    const gotoUrl = withScraperProxy(url, { render: false })
    try {
      await page.goto(gotoUrl, { waitUntil: 'commit', timeout: navTimeout })
      await page
        .waitForLoadState('domcontentloaded', { timeout: Math.min(10_000, navTimeout) })
        .catch(() => undefined)
    } catch {
      await page.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout })
    }

    const continueBtn = page.locator('text=Continue shopping').first()
    if (await continueBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      await continueBtn.click().catch(() => undefined)
    }

    if (opts?.waitSelector) {
      await page
        .waitForSelector(opts.waitSelector, {
          timeout: Math.min(limits.selectorTimeoutMs, navTimeout),
        })
        .catch(() => undefined)
    }

    // Flipkart WOW: "Buy at ₹…" often mounts after the main price
    if (opts?.waitText) {
      await page
        .getByText(opts.waitText, { exact: false })
        .first()
        .waitFor({ timeout: Math.min(8_000, navTimeout) })
        .catch(() => undefined)
    }

    await new Promise((r) => setTimeout(r, opts?.waitMs ?? limits.settleMs))
    const html = await page.content()
    return cheerio.load(html)
  } finally {
    await context.close()
  }
}

export async function fetchPageSmart(
  url: string,
  opts?: {
    pincode?: string
    preferBrowser?: boolean
    waitSelector?: string
    waitText?: string | RegExp
    waitMs?: number
    navigationTimeoutMs?: number
    /** Force ScraperAPI JS render on HTTP path */
    httpRender?: boolean
  },
) {
  const limits = scrapeLimits()

  // Always try cheap HTTP first unless caller insists on browser-only after HTTP fails
  if (!opts?.preferBrowser || limits.httpOnly) {
    try {
      const $ = await fetchHtml(
        url,
        opts?.pincode ? { Cookie: `pincode=${opts.pincode}` } : {},
        { render: opts?.httpRender },
      )
      const text = $('body').text()
      if (
        text.length > 400 &&
        !/robot|captcha|access denied|enter the characters|api\.scraperapi/i.test(text)
      ) {
        return $
      }
    } catch {
      /* fall through */
    }
    if (limits.httpOnly) {
      // Last try with ScraperAPI render if key exists
      if (process.env.SCRAPERAPI_KEY?.trim()) {
        return fetchHtml(
          url,
          opts?.pincode ? { Cookie: `pincode=${opts.pincode}` } : {},
          { render: true },
        )
      }
      throw new Error('HTTP scrape failed and browser is disabled on this host')
    }
  }

  try {
    return await fetchHtmlBrowser(url, {
      pincode: opts?.pincode,
      waitSelector: opts?.waitSelector,
      waitText: opts?.waitText,
      waitMs: opts?.waitMs,
      navigationTimeoutMs: opts?.navigationTimeoutMs ?? limits.navigationTimeoutMs,
    })
  } catch (browserErr) {
    try {
      return await fetchHtml(url, opts?.pincode ? { Cookie: `pincode=${opts.pincode}` } : {})
    } catch {
      throw browserErr
    }
  }
}

export function parseMoney(raw?: string | null): number | null {
  if (raw == null) return null
  const str = String(raw)
  const withSymbol = str.match(/₹\s*([\d,]+(?:\.\d+)?)/)
  if (withSymbol) {
    const n = Number(withSymbol[1].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const cleaned = str.replace(/[^\d.]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function pickMeta($: CheerioRoot, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = $(sel).first()
    const val = el.attr('content') || el.text()
    if (val?.trim()) return val.trim()
  }
  return undefined
}

type JsonLdOffer = {
  title?: string
  image?: string
  price?: number
  oldPrice?: number
  available?: boolean
  currency?: string
}

function walkJsonLd(node: unknown, out: JsonLdOffer[]) {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const type = obj['@type']
  const types = Array.isArray(type) ? type : type ? [type] : []

  if (types.some((t) => String(t).toLowerCase().includes('product'))) {
    const offers = obj.offers
    const offerList = Array.isArray(offers) ? offers : offers ? [offers] : []
    let price: number | undefined
    let available: boolean | undefined
    for (const offer of offerList) {
      if (!offer || typeof offer !== 'object') continue
      const o = offer as Record<string, unknown>
      const p = parseMoney(String(o.price ?? o.lowPrice ?? ''))
      if (p != null) price = p
      const avail = String(o.availability || '')
      if (avail) available = /instock|InStock/i.test(avail)
    }
    const img = obj.image
    const image =
      typeof img === 'string'
        ? img
        : Array.isArray(img)
          ? String(img[0])
          : img && typeof img === 'object' && 'url' in (img as object)
            ? String((img as { url: string }).url)
            : undefined

    out.push({
      title: typeof obj.name === 'string' ? obj.name : undefined,
      image,
      price,
      available,
    })
  }

  if (obj['@graph']) walkJsonLd(obj['@graph'], out)
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') walkJsonLd(v, out)
  }
}

export function extractJsonLd($: CheerioRoot): JsonLdOffer | null {
  const found: JsonLdOffer[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()
    if (!raw) return
    try {
      walkJsonLd(JSON.parse(raw), found)
    } catch {
      /* ignore */
    }
  })
  return found.find((f) => f.price != null) || found[0] || null
}

export function discountFrom(oldPrice?: number | null, price?: number | null) {
  if (!oldPrice || !price || oldPrice <= price) return 0
  return Math.round(((oldPrice - price) / oldPrice) * 100)
}

export function extractAsin(url: string): string | null {
  try {
    const u = new URL(url)
    const q = u.searchParams.get('asin')
    if (q && /^[A-Z0-9]{10}$/i.test(q)) return q.toUpperCase()
  } catch {
    /* ignore */
  }
  const m = url.match(
    /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing|product)\/([A-Z0-9]{10})(?:[/?]|$)/i,
  )
  return m?.[1]?.toUpperCase() || null
}
