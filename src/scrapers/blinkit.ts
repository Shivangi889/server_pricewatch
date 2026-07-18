/**
 * Blinkit integration — location-aware, production hardened (2026-07).
 *
 * Reverse-engineered from live Chrome traffic on blinkit.com:
 *   1. Session   : homepage load mints Cloudflare cookies (__cf_bm, _cfuvid) +
 *                  gr_1_deviceId. Harvested via headless Chrome, then persisted so
 *                  they survive worker restarts (the "save cookies" gap) and are
 *                  reused by fetch from the same IP.
 *   2. Auth      : GET /v2/accounts/auth_key/  → auth_key (sent on every API call)
 *   3. Location  : GET /location/autoSuggest?query=<pincode>  → place_id
 *                  GET /location/info?place_id=…               → {is_serviceable,
 *                                                                 coordinate{lat,lon}, city}
 *   4. Product   : POST /v1/layout/product/<product_id>  (lat/lon in headers)
 *                  → snippets carrying {price, mrp, inventory, state, cart_item…}
 *   5. ETA       : GET /v1/consumerweb/eta  → eta_in_minutes
 *
 * Prices are already in rupees (not paise). Availability is driven by the real
 * store's `state`/`inventory`, never by HTML text. Contract (ScrapeResult) is
 * unchanged so the worker/queue/scheduler/alerts/Prisma layer stay untouched.
 */
import { randomBytes } from 'crypto'
import {
  Session,
  ScrapeError,
  chromeFingerprint,
  discountPct,
  isRetryable,
  makeLogger,
  request,
  requestJson,
  sessions,
  DEFAULT_UA,
} from './lib/scrapeClient.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

const PROVIDER = 'blinkit'
const BASE = 'https://blinkit.com'
const log = makeLogger(PROVIDER)

// Web artifact versions — verified 2026-07-17. Bump if responses degrade.
const APP_VERSION = process.env.BLINKIT_APP_VERSION || '52434332'
const WEB_APP_VERSION = process.env.BLINKIT_WEB_APP_VERSION || '1008010016'
const RN_BUNDLE_VERSION = process.env.BLINKIT_RN_BUNDLE_VERSION || '1009003012'
/**
 * Blinkit's consumer-web auth_key is a static client key (identical across
 * devices/sessions). GET /v2/accounts/auth_key/ just echoes it back but is
 * fingerprint-picky, so we default to the known key and refresh best-effort.
 */
const DEFAULT_AUTH_KEY =
  process.env.BLINKIT_AUTH_KEY ||
  'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477'

// ---------------------------------------------------------------------------
// Session: Cloudflare cookies + device_id + auth_key
// ---------------------------------------------------------------------------
function newDeviceId() {
  return randomBytes(8).toString('hex') // 16-hex, matches web client
}

function sessionValid(s: Session | null): s is Session {
  return Boolean(s && typeof s.meta.authKey === 'string' && s.meta.authKey)
}

function baseHeaders(s: Session, lat?: number, lon?: number): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'content-type': 'application/json',
    app_client: 'consumer_web',
    app_version: APP_VERSION,
    web_app_version: WEB_APP_VERSION,
    rn_bundle_version: RN_BUNDLE_VERSION,
    platform: 'desktop_web',
    device_id: String(s.meta.deviceId || ''),
    session_uuid: String(s.meta.sessionUuid || ''),
    auth_key: String(s.meta.authKey || ''),
    access_token: 'null',
    Origin: BASE,
    Referer: `${BASE}/`,
    ...chromeFingerprint(),
  }
  if (lat != null && lon != null) {
    h.lat = String(lat)
    h.lon = String(lon)
  }
  return h
}

async function fetchAuthKey(s: Session): Promise<void> {
  // Minimal header set — the auth_key endpoint 400s if app_client/auth_key/etc.
  // are present. It only wants a fresh req_key + browser fingerprint.
  const data = await requestJson<{ auth_key?: string; data?: { auth_key?: string } }>(
    `${BASE}/v2/accounts/auth_key/`,
    {
      provider: PROVIDER,
      where: 'auth_key',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN',
        req_key: crypto.randomUUID(),
        ...chromeFingerprint(),
      },
      browserOrigin: BASE,
    },
  )
  const key = data.auth_key || data.data?.auth_key
  if (!key) throw new ScrapeError('SESSION_EXPIRED', 'auth_key missing in response', { provider: PROVIDER })
  s.meta.authKey = key
}

async function getSession(force = false): Promise<Session> {
  const cached = sessions.get(PROVIDER)
  if (!force && sessionValid(cached) && sessions.fresh(cached)) return cached

  // Cloudflare cookies live in the warm browser page (persisted via storageState).
  // Here we only need a device_id/session_uuid identity + the auth_key.
  const s = force || !cached ? new Session(PROVIDER) : cached
  if (!s.meta.deviceId) s.meta.deviceId = newDeviceId()
  if (!s.meta.sessionUuid) s.meta.sessionUuid = crypto.randomUUID()
  s.meta.authKey = DEFAULT_AUTH_KEY
  // Best-effort refresh; the static default keeps us working if it 400s.
  try {
    await fetchAuthKey(s)
  } catch (err) {
    log.debug('auth_key refresh failed, using default:', err instanceof Error ? err.message : err)
  }
  sessions.put(s)
  return s
}

// ---------------------------------------------------------------------------
// URL → product_id
// ---------------------------------------------------------------------------
export function extractBlinkitProductId(url: string): string | null {
  const m = url.match(/\/prid\/(\d+)/i) || url.match(/[?&]product_id=(\d+)/i)
  if (m) return m[1]
  const tail = url.match(/\/(\d{4,})(?:[/?#]|$)/)
  return tail ? tail[1] : null
}

// ---------------------------------------------------------------------------
// Location: pincode → place_id → {serviceable, lat, lon, city}
// ---------------------------------------------------------------------------
type BlinkitLocation = {
  serviceable: boolean
  lat: number
  lon: number
  city?: string
  locality?: string
}

type AutoSuggest = {
  ui_data?: {
    suggestions?: {
      title?: { text?: string }
      subtitle?: { text?: string }
      meta?: { place_id?: string; session_token?: string }
    }[]
  }
}

type LocationInfo = {
  is_serviceable?: boolean
  is_available?: boolean
  coordinate?: { lat?: number; lon?: number }
  city?: string
  locality?: string
}

async function resolveLocation(s: Session, pincode: string): Promise<BlinkitLocation> {
  if (!/^\d{6}$/.test(pincode)) {
    throw new ScrapeError('INVALID_PINCODE', `"${pincode}" is not a 6-digit pincode`, { provider: PROVIDER })
  }
  // A non-empty seed lat/lng is required (empty → "Missing required parameters").
  // Any India coordinate works — results are keyed off the pincode query.
  const auto = await requestJson<AutoSuggest>(
    `${BASE}/location/autoSuggest?query=${encodeURIComponent(pincode)}&lat=28.6139&lng=77.209&session_token=`,
    { provider: PROVIDER, where: 'autoSuggest', headers: baseHeaders(s), browserOrigin: BASE },
  )
  const sug = auto.ui_data?.suggestions?.find((x) => x.meta?.place_id)
  if (!sug?.meta?.place_id) {
    throw new ScrapeError('GEOLOCATION_FAILED', `no place match for pincode ${pincode}`, { provider: PROVIDER })
  }
  const params = new URLSearchParams({
    place_id: sug.meta.place_id,
    title: sug.title?.text || pincode,
    description: sug.subtitle?.text || '',
  })
  if (sug.meta.session_token) params.set('session_token', sug.meta.session_token)
  const info = await requestJson<LocationInfo>(`${BASE}/location/info?${params.toString()}`, {
    provider: PROVIDER,
    where: 'locationInfo',
    headers: baseHeaders(s),
    browserOrigin: BASE,
  })
  const lat = info.coordinate?.lat
  const lon = info.coordinate?.lon
  if (lat == null || lon == null) {
    throw new ScrapeError('GEOLOCATION_FAILED', `no coordinates for pincode ${pincode}`, { provider: PROVIDER })
  }
  return {
    serviceable: Boolean(info.is_serviceable ?? info.is_available),
    lat,
    lon,
    city: info.city,
    locality: info.locality,
  }
}

// ---------------------------------------------------------------------------
// ETA
// ---------------------------------------------------------------------------
async function fetchEta(s: Session, lat: number, lon: number): Promise<number | undefined> {
  try {
    const eta = await requestJson<{ eta_in_minutes?: number }>(`${BASE}/v1/consumerweb/eta`, {
      provider: PROVIDER,
      where: 'eta',
      headers: baseHeaders(s, lat, lon),
      browserOrigin: BASE,
      retries: 0,
    })
    return typeof eta.eta_in_minutes === 'number' ? eta.eta_in_minutes : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Product detail → availability + price
// ---------------------------------------------------------------------------
type CartItem = {
  product_id?: number
  price?: number
  mrp?: number
  inventory?: number
  unavailable_quantity?: number
  display_name?: string
  product_name?: string
  brand?: string
  image_url?: string
}
type Tracking = { product_id?: string | number; state?: string; price?: number; mrp?: number; inventory?: number }

type BlinkitProductInfo = {
  found: boolean
  title?: string
  image?: string
  price?: number
  mrp?: number
  inventory?: number
  state?: string
  soldOut?: boolean
}

/** Deep-collect cart_item + tracking objects that match the target product id. */
function extractProductInfo(payload: unknown, productId: string): BlinkitProductInfo {
  const pid = Number(productId)
  let cart: CartItem | undefined
  let track: Tracking | undefined
  let soldOut: boolean | undefined

  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 16) return
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const obj = node as Record<string, unknown>

    // cart_item: cleanest numeric source (price/mrp/inventory/name/image)
    if (
      !cart &&
      typeof obj.product_id === 'number' &&
      obj.product_id === pid &&
      (typeof obj.price === 'number' || typeof obj.mrp === 'number') &&
      ('image_url' in obj || 'display_name' in obj || 'unavailable_quantity' in obj)
    ) {
      cart = obj as CartItem
    }
    // tracking map: authoritative availability `state`
    if (
      typeof obj.state === 'string' &&
      (String(obj.product_id) === productId || obj.product_id === pid) &&
      (typeof obj.price === 'number' || typeof obj.inventory === 'number')
    ) {
      track = obj as Tracking
    }
    // main product snippet: is_sold_out flag
    if (
      soldOut == null &&
      typeof obj.is_sold_out === 'boolean' &&
      (obj.product_id === pid || (obj.identity as { id?: string })?.id === productId)
    ) {
      soldOut = obj.is_sold_out as boolean
    }
    for (const v of Object.values(obj)) walk(v, depth + 1)
  }
  walk(payload, 0)

  if (!cart && !track) return { found: false }
  const price = cart?.price ?? track?.price
  const mrp = cart?.mrp ?? track?.mrp
  const inventory = cart?.inventory ?? track?.inventory
  return {
    found: true,
    title: cart?.display_name || cart?.product_name,
    image: cart?.image_url,
    price: typeof price === 'number' ? price : undefined,
    mrp: typeof mrp === 'number' ? mrp : undefined,
    inventory: typeof inventory === 'number' ? inventory : undefined,
    state: track?.state,
    soldOut,
  }
}

async function fetchProduct(
  s: Session,
  productId: string,
  lat: number,
  lon: number,
): Promise<BlinkitProductInfo> {
  const res = await request(`${BASE}/v1/layout/product/${productId}`, {
    provider: PROVIDER,
    where: 'product',
    method: 'POST',
    headers: baseHeaders(s, lat, lon),
    body: '{}',
    browserOrigin: BASE,
  })
  const json = (await res.json()) as unknown
  return extractProductInfo(json, productId)
}

// ---------------------------------------------------------------------------
// Public scraper
// ---------------------------------------------------------------------------
async function checkBlinkit(ctx: ScrapeContext, productId: string): Promise<ScrapeResult> {
  const s = await getSession()

  // Resolve store/location. Without a pincode we cannot pick a store (Blinkit is
  // hyper-local) → fail clearly rather than invent a price.
  if (!ctx.pincode) {
    throw new ScrapeError('INVALID_PINCODE', 'Blinkit requires a pincode to select a store', {
      provider: PROVIDER,
    })
  }
  const loc = await resolveLocation(s, ctx.pincode)
  const eta = loc.serviceable ? await fetchEta(s, loc.lat, loc.lon) : undefined
  const prevPrice = ctx.previousPrice && ctx.previousPrice > 0 ? ctx.previousPrice : 0

  // Business states return available:false (so lastAvailable flips and a later
  // "back in stock" alert can fire) instead of throwing — matches the tracker's
  // availability model. Price alerts are gated on available, so prevPrice is safe.
  if (!loc.serviceable) {
    log.info(`PIN=${ctx.pincode} city=${loc.city ?? '?'} => NOT_SERVICEABLE`)
    return {
      price: prevPrice,
      available: false,
      source: 'live',
      rawNote: `pin ${ctx.pincode} NOT_SERVICEABLE city=${loc.city ?? '?'}`,
    }
  }

  const info = await fetchProduct(s, productId, loc.lat, loc.lon)
  if (!info.found || info.price == null) {
    log.info(`PIN=${ctx.pincode} product=${productId} => PRODUCT_NOT_IN_STORE`)
    return {
      price: prevPrice,
      available: false,
      source: 'live',
      rawNote: `pin ${ctx.pincode} PRODUCT_NOT_IN_STORE city=${loc.city ?? '?'}`,
    }
  }

  const stateOk = info.state ? info.state === 'available' : true
  const available = stateOk && info.soldOut !== true && (info.inventory == null || info.inventory > 0)

  log.info(
    `PIN=${ctx.pincode} city=${loc.city ?? '?'} lat=${loc.lat} lon=${loc.lon} ` +
      `product=${productId} state=${info.state ?? '?'} inv=${info.inventory ?? '?'} ` +
      `price=${info.price} eta=${eta ?? '?'}m => ${available ? 'AVAILABLE' : 'OUT_OF_STOCK'}`,
  )

  const oldPrice = info.mrp && info.mrp > info.price ? info.mrp : undefined
  return {
    title: info.title,
    image: info.image,
    price: info.price,
    oldPrice,
    discount: discountPct(oldPrice, info.price),
    available,
    source: 'live',
    rawNote:
      `pin ${ctx.pincode} ${available ? 'AVAILABLE' : 'OUT_OF_STOCK'} city=${loc.city ?? '?'} ` +
      `inv=${info.inventory ?? '?'} eta=${eta ?? '?'}m`,
  }
}

async function scrapeBlinkit(ctx: ScrapeContext): Promise<ScrapeResult> {
  const productId = extractBlinkitProductId(ctx.url)
  if (!productId) {
    throw new ScrapeError('PRODUCT_NOT_FOUND', `no product id in URL: ${ctx.url}`, { provider: PROVIDER })
  }

  try {
    return await checkBlinkit(ctx, productId)
  } catch (err) {
    if (err instanceof ScrapeError && isRetryable(err.code)) {
      log.info(`retrying after ${err.code}: forcing fresh session`)
      await getSession(true)
      return await checkBlinkit(ctx, productId)
    }
    throw err
  }
}

export const blinkitScraper: StoreScraper = {
  slug: PROVIDER,
  scrape: scrapeBlinkit,
}
