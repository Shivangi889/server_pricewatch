/**
 * Shared scraping infrastructure for location-aware quick-commerce providers.
 *
 * One place for the cross-cutting concerns every provider needs:
 *   - Persistent cookie manager (survives worker restarts → the "save cookies" gap)
 *   - Session manager (per-provider jar + metadata + TTL, disk-backed)
 *   - Retry with exponential backoff + jitter
 *   - Per-host rate limiting (min interval between calls)
 *   - Proxy support (SCRAPE_PROXY_URL, via undici ProxyAgent when available)
 *   - Request/response logging (SCRAPE_DEBUG)
 *   - Error classification (shared taxonomy)
 *   - Browser fingerprint headers (Chrome sec-ch-ua*)
 *   - Playwright cookie-harvest fallback (Cloudflare / AWS WAF)
 *
 * Providers (zepto/blinkit/instamart/bigbasket) build their request flows on top
 * of this and never re-implement the plumbing. The worker/queue/scheduler/alerts
 * and Prisma layer stay untouched — providers still return a ScrapeResult.
 */
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const DEFAULT_UA =
  process.env.SCRAPE_USER_AGENT?.trim() ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const STATE_DIR = process.env.SCRAPE_STATE_DIR?.trim() || join(process.cwd(), '.scrape-state')
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.SCRAPE_DEBUG || '')
const PROXY_URL = process.env.SCRAPE_PROXY_URL?.trim() || ''

/** Chrome major used across sec-ch-ua + UA. Keep in sync with DEFAULT_UA. */
const CHROME_MAJOR =
  DEFAULT_UA.match(/Chrome\/(\d+)/)?.[1] || '122'

// ---------------------------------------------------------------------------
// Error taxonomy (shared across providers)
// ---------------------------------------------------------------------------
export type ScrapeErrorCode =
  | 'INVALID_PINCODE'
  | 'PIN_NOT_SERVICEABLE'
  | 'STORE_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'OUT_OF_STOCK'
  | 'SESSION_EXPIRED'
  | 'GEOLOCATION_FAILED'
  | 'API_CHANGED'
  | 'RATE_LIMITED'
  | 'BLOCKED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'UNKNOWN'

export class ScrapeError extends Error {
  code: ScrapeErrorCode
  status?: number
  provider?: string
  constructor(code: ScrapeErrorCode, message: string, opts?: { status?: number; provider?: string }) {
    super(`[${opts?.provider ? opts.provider + ':' : ''}${code}] ${message}`)
    this.name = 'ScrapeError'
    this.code = code
    this.status = opts?.status
    this.provider = opts?.provider
  }
}

/** Retryable = transient anti-bot / infra states worth one fresh-session retry. */
export function isRetryable(code: ScrapeErrorCode): boolean {
  return (
    code === 'SESSION_EXPIRED' ||
    code === 'BLOCKED' ||
    code === 'RATE_LIMITED' ||
    code === 'NETWORK' ||
    code === 'TIMEOUT'
  )
}

export function classifyStatus(
  status: number,
  where: string,
  provider: string,
): ScrapeError | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 419)
    return new ScrapeError('SESSION_EXPIRED', `${where} → ${status}`, { status, provider })
  if (status === 403 || status === 405)
    return new ScrapeError('BLOCKED', `${where} → ${status} (WAF/anti-bot)`, { status, provider })
  if (status === 429)
    return new ScrapeError('RATE_LIMITED', `${where} → ${status}`, { status, provider })
  if (status === 404)
    return new ScrapeError('API_CHANGED', `${where} → 404 (endpoint moved?)`, { status, provider })
  if (status >= 500)
    return new ScrapeError('UNKNOWN', `${where} → ${status} (upstream)`, { status, provider })
  return new ScrapeError('UNKNOWN', `${where} → ${status}`, { status, provider })
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export function makeLogger(provider: string) {
  return {
    debug: (...a: unknown[]) => {
      if (DEBUG) console.log(`[${provider}:debug]`, ...a)
    },
    info: (...a: unknown[]) => console.log(`[${provider}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${provider}]`, ...a),
  }
}

// ---------------------------------------------------------------------------
// Cookie manager (persistent)
// ---------------------------------------------------------------------------
export class CookieJar {
  private map = new Map<string, string>()

  get size() {
    return this.map.size
  }
  has(name: string) {
    return this.map.has(name)
  }
  set(name: string, value: string) {
    this.map.set(name, value)
  }
  delete(name: string) {
    this.map.delete(name)
  }
  keys() {
    return [...this.map.keys()]
  }
  /** Raw (still URL-encoded) value as stored. */
  raw(name: string) {
    return this.map.get(name)
  }
  /** Decoded value (Zepto/Blinkit store JSON cookies URL-encoded). */
  value(name: string) {
    const v = this.map.get(name)
    return v ? decodeURIComponent(v) : ''
  }

  /** Merge Set-Cookie headers from a fetch Response. */
  applySetCookie(res: Response) {
    const raw =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || []
    for (const c of raw) {
      const [kv] = c.split(';')
      const i = kv.indexOf('=')
      if (i > 0) this.map.set(kv.slice(0, i).trim(), kv.slice(i + 1))
    }
  }

  /** Merge cookies harvested from a Playwright context. */
  applyPlaywright(cookies: { name: string; value: string }[]) {
    for (const c of cookies) this.map.set(c.name, c.value)
  }

  /** Cookie header string, optionally with per-request extras (not persisted). */
  header(extra?: Record<string, string>) {
    const parts = [...this.map.entries()].map(([k, v]) => `${k}=${v}`)
    if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`)
    return parts.join('; ')
  }

  toJSON() {
    return Object.fromEntries(this.map)
  }
  loadJSON(obj: Record<string, string> | undefined | null) {
    if (!obj) return
    for (const [k, v] of Object.entries(obj)) this.map.set(k, v)
  }
}

// ---------------------------------------------------------------------------
// Session manager (per-provider, disk-backed)
// ---------------------------------------------------------------------------
export type SessionMeta = Record<string, string | number | boolean | undefined>

export class Session {
  jar = new CookieJar()
  meta: SessionMeta = {}
  createdAt = Date.now()
  constructor(public provider: string) {}
}

function stateFile(provider: string) {
  return join(STATE_DIR, `${provider}.json`)
}

/**
 * Per-provider session cache with disk persistence. The disk copy is what makes
 * Cloudflare `__cf_bm` / AWS WAF tokens / location cookies survive a restart —
 * the piece the client was missing when cookies were only kept in memory.
 */
export class SessionManager {
  private cache = new Map<string, Session>()

  constructor(
    private ttlMs = Number(process.env.SCRAPE_SESSION_TTL_MS || 10 * 60_000),
  ) {}

  private load(provider: string): Session | null {
    try {
      const f = stateFile(provider)
      if (!existsSync(f)) return null
      const parsed = JSON.parse(readFileSync(f, 'utf8')) as {
        cookies: Record<string, string>
        meta: SessionMeta
        createdAt: number
      }
      const s = new Session(provider)
      s.jar.loadJSON(parsed.cookies)
      s.meta = parsed.meta || {}
      s.createdAt = parsed.createdAt || 0
      return s
    } catch {
      return null
    }
  }

  save(session: Session) {
    try {
      const f = stateFile(session.provider)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(
        f,
        JSON.stringify(
          { cookies: session.jar.toJSON(), meta: session.meta, createdAt: session.createdAt },
          null,
          2,
        ),
      )
    } catch {
      /* best effort — a read-only FS just disables persistence */
    }
  }

  fresh(session: Session | null): boolean {
    return Boolean(session && Date.now() - session.createdAt < this.ttlMs)
  }

  /** In-memory first, disk second. Returns null if nothing usable is cached. */
  get(provider: string): Session | null {
    let s = this.cache.get(provider) || null
    if (!s) {
      s = this.load(provider)
      if (s) this.cache.set(provider, s)
    }
    return s
  }

  put(session: Session) {
    session.createdAt = Date.now()
    this.cache.set(session.provider, session)
    this.save(session)
  }

  clear(provider: string) {
    this.cache.delete(provider)
    try {
      const f = stateFile(provider)
      if (existsSync(f)) unlinkSync(f)
      const sf = join(STATE_DIR, `${provider}.storage.json`)
      if (existsSync(sf)) unlinkSync(sf)
    } catch {
      /* best effort */
    }
  }
}

export const sessions = new SessionManager()

// ---------------------------------------------------------------------------
// Rate limiter (per host, min interval + jitter)
// ---------------------------------------------------------------------------
const lastCallAt = new Map<string, number>()
const MIN_INTERVAL_MS = Number(process.env.SCRAPE_MIN_INTERVAL_MS || 350)

async function rateLimit(host: string) {
  const now = Date.now()
  const last = lastCallAt.get(host) || 0
  const wait = last + MIN_INTERVAL_MS - now
  if (wait > 0) {
    await sleep(wait + Math.floor(Math.random() * 120))
  }
  lastCallAt.set(host, Date.now())
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Proxy (optional, via undici ProxyAgent)
// ---------------------------------------------------------------------------
let dispatcherPromise: Promise<unknown> | null | undefined

async function proxyDispatcher(): Promise<unknown | undefined> {
  if (!PROXY_URL) return undefined
  if (dispatcherPromise === undefined) {
    dispatcherPromise = import('undici')
      .then((u) => new (u as { ProxyAgent: new (url: string) => unknown }).ProxyAgent(PROXY_URL))
      .catch(() => {
        console.warn(
          '[scrape] SCRAPE_PROXY_URL set but `undici` not installed — run `npm i undici` to enable proxying',
        )
        return null
      })
  }
  const d = await dispatcherPromise
  return d ?? undefined
}

// ---------------------------------------------------------------------------
// Fingerprint headers
// ---------------------------------------------------------------------------
export function chromeFingerprint(): Record<string, string> {
  return {
    'sec-ch-ua': `"Not;A=Brand";v="99", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  }
}

// ---------------------------------------------------------------------------
// HTTP core: rate-limit → proxy → fetch → retry → classify → log
// ---------------------------------------------------------------------------
export type RequestOpts = {
  provider: string
  where: string
  method?: string
  headers?: Record<string, string>
  body?: string
  jar?: CookieJar
  /** Cookie extras merged for this call only. */
  cookieExtra?: Record<string, string>
  timeoutMs?: number
  retries?: number
  /** Treat these HTTP statuses as success (e.g. 3xx you follow manually). */
  okStatuses?: number[]
  /**
   * Route the call through a warm headless-browser page on this origin. Required
   * for Cloudflare/WAF-fronted APIs (Blinkit) where Node's TLS fingerprint gets a
   * 403 even with valid cookies — the in-page fetch uses the browser's TLS +
   * same-origin cookies, so anti-bot treats it as a genuine XHR.
   */
  browserOrigin?: string
}

export async function request(url: string, opts: RequestOpts): Promise<Response> {
  const {
    provider,
    where,
    method = 'GET',
    headers = {},
    body,
    jar,
    cookieExtra,
    timeoutMs = 20_000,
    retries = 2,
    okStatuses = [],
  } = opts
  const log = makeLogger(provider)
  const host = safeHost(url)

  let lastErr: ScrapeError | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit(host)
    const finalHeaders: Record<string, string> = { ...headers }
    // Browser transport carries cookies itself; only add jar Cookie for direct fetch.
    if (jar && !opts.browserOrigin) finalHeaders.Cookie = jar.header(cookieExtra)
    const started = Date.now()
    let res: Response
    try {
      if (opts.browserOrigin) {
        res = await browserTransport(provider, opts.browserOrigin, url, {
          method,
          headers: finalHeaders,
          body,
          timeoutMs,
        })
      } else {
        const dispatcher = await proxyDispatcher()
        res = await fetch(url, {
          method,
          headers: finalHeaders,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const timeout = /timeout|abort/i.test(msg)
      lastErr = new ScrapeError(timeout ? 'TIMEOUT' : 'NETWORK', `${where}: ${msg}`, { provider })
      log.debug(`${where} ${lastErr.code} attempt=${attempt} ${Date.now() - started}ms`)
      if (attempt < retries) {
        await sleep(backoff(attempt))
        continue
      }
      throw lastErr
    }

    if (jar && !opts.browserOrigin) jar.applySetCookie(res)
    log.debug(`${where} ${res.status} ${method} ${Date.now() - started}ms ${redact(url)}`)

    // Manual redirect handling so we can capture Set-Cookie on 3xx (Zepto/BB rely on this).
    if (res.status >= 300 && res.status < 400 && !okStatuses.includes(res.status)) {
      const loc = res.headers.get('location')
      if (loc) {
        return request(new URL(loc, url).toString(), { ...opts, retries: retries - attempt })
      }
    }

    if (okStatuses.includes(res.status)) return res
    const errCls = classifyStatus(res.status, where, provider)
    if (!errCls) return res

    lastErr = errCls
    if (isRetryable(errCls.code) && attempt < retries) {
      log.debug(`${where} retry after ${errCls.code} (attempt ${attempt})`)
      await sleep(backoff(attempt))
      continue
    }
    throw errCls
  }
  throw lastErr || new ScrapeError('UNKNOWN', `${where}: exhausted retries`, { provider })
}

export async function requestJson<T>(url: string, opts: RequestOpts): Promise<T> {
  const res = await request(url, opts)
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ScrapeError('API_CHANGED', `${opts.where}: non-JSON response (${text.slice(0, 80)})`, {
      provider: opts.provider,
    })
  }
}

function backoff(attempt: number) {
  return Math.min(4_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250)
}

function safeHost(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function redact(url: string) {
  return url.replace(/(token|key|auth|session)=[^&]+/gi, '$1=***')
}

// ---------------------------------------------------------------------------
// Playwright cookie-harvest fallback (Cloudflare / AWS WAF)
// ---------------------------------------------------------------------------
let browserPromise: Promise<Browser> | null = null

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .catch(() =>
        chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      )
  }
  return browserPromise
}

export async function closeSharedBrowser() {
  for (const [, entry] of warmPages) {
    await entry.context.close().catch(() => undefined)
  }
  warmPages.clear()
  if (browserPromise) {
    const b = await browserPromise
    browserPromise = null
    await b.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Browser transport: in-page fetch for Cloudflare/WAF-fronted APIs
// ---------------------------------------------------------------------------
type WarmPage = { context: BrowserContext; page: Page; origin: string; loadedAt: number }
const warmPages = new Map<string, WarmPage>()
const WARM_TTL_MS = Number(process.env.SCRAPE_WARM_TTL_MS || 8 * 60_000)

function storageFile(provider: string) {
  return join(STATE_DIR, `${provider}.storage.json`)
}

async function ensureWarmPage(provider: string, origin: string): Promise<WarmPage> {
  const existing = warmPages.get(provider)
  if (existing && existing.origin === origin && Date.now() - existing.loadedAt < WARM_TTL_MS) {
    return existing
  }
  if (existing) await existing.context.close().catch(() => undefined)

  const log = makeLogger(provider)
  const browser = await getBrowser()
  // Restore a previously saved storageState (persisted cookies survive restarts).
  const sf = storageFile(provider)
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
    ...(existsSync(sf) ? { storageState: sf } : {}),
  })
  const page = await context.newPage()
  await page.route('**/*', (route) => {
    const t = route.request().resourceType()
    if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort()
    return route.continue()
  })
  log.debug(`warming browser page on ${origin}`)
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(2000) // let Cloudflare/WAF mint tokens
  try {
    mkdirSync(dirname(sf), { recursive: true })
    await context.storageState({ path: sf })
  } catch {
    /* read-only FS disables persistence */
  }
  const warm: WarmPage = { context, page, origin, loadedAt: Date.now() }
  warmPages.set(provider, warm)
  return warm
}

async function browserTransport(
  provider: string,
  origin: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
): Promise<Response> {
  const warm = await ensureWarmPage(provider, origin)
  const result = (await warm.page.evaluate(
    async ({ url, method, headers, body }) => {
      // Same-origin fetch inside the real page: browser TLS + cookies auto-attached.
      const controller = new AbortController()
      const to = setTimeout(() => controller.abort(), 20_000)
      try {
        const r = await fetch(url, {
          method,
          headers,
          body: body ?? undefined,
          credentials: 'include',
          signal: controller.signal,
        })
        const text = await r.text()
        return { status: r.status, text, ok: r.ok }
      } finally {
        clearTimeout(to)
      }
    },
    { url, method: init.method, headers: stripHopHeaders(init.headers), body: init.body },
  )) as { status: number; text: string; ok: boolean }
  // Persist refreshed cookies opportunistically.
  try {
    await warm.context.storageState({ path: storageFile(provider) })
  } catch {
    /* ignore */
  }
  return new Response(result.text, { status: result.status })
}

/** Cookie/Host are managed by the browser; passing them to in-page fetch is invalid. */
function stripHopHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/^(cookie|host|content-length|origin|referer|user-agent)$/i.test(k)) continue
    out[k] = v
  }
  return out
}

export type HarvestOpts = {
  provider: string
  url: string
  /** Cookies to preset before navigation (e.g. location). */
  presetCookies?: { name: string; value: string; domain: string; path?: string }[]
  waitMs?: number
  /** Run inside the page after load (set location, click, etc.). */
  onPage?: (ctx: BrowserContext) => Promise<void>
}

/**
 * Load a URL in a real (headless) Chrome to obtain a full cookie set — including
 * anti-bot tokens (`__cf_bm`, `cf_clearance`, `aws-waf-token`) that plain fetch
 * cannot mint. Returns the cookies; caller merges them into the persistent jar.
 */
export async function harvestCookies(opts: HarvestOpts): Promise<{ name: string; value: string }[]> {
  const log = makeLogger(opts.provider)
  log.info('session: harvesting cookies via headless browser (anti-bot)')
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
  })
  try {
    if (opts.presetCookies?.length) {
      await context.addCookies(
        opts.presetCookies.map((c) => ({ ...c, path: c.path || '/' })),
      )
    }
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const t = route.request().resourceType()
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort()
      return route.continue()
    })
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
    await page.waitForTimeout(opts.waitMs ?? 2500)
    if (opts.onPage) await opts.onPage(context).catch((e) => log.debug('onPage err', String(e)))
    const cookies = await context.cookies()
    log.debug('harvested cookies:', cookies.map((c) => c.name).join(','))
    return cookies.map((c) => ({ name: c.name, value: c.value }))
  } finally {
    await context.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Money helpers (shared)
// ---------------------------------------------------------------------------
export function paiseToInr(paise?: number | null): number | null {
  if (paise == null || !Number.isFinite(paise) || paise <= 0) return null
  return Math.round(paise) / 100
}

export function discountPct(oldPrice?: number | null, price?: number | null) {
  if (!oldPrice || !price || oldPrice <= price) return 0
  return Math.round(((oldPrice - price) / oldPrice) * 100)
}
