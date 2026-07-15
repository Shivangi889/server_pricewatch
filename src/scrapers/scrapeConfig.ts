/** Tuned for Render free / small VMs — fail fast, prefer HTTP over Playwright. */
export function isCloudHost() {
  return (
    process.env.RENDER === 'true' ||
    process.env.FREE_TIER === 'true' ||
    process.env.RAILWAY_ENVIRONMENT != null ||
    process.env.FLY_APP_NAME != null
  )
}

export function scrapeLimits() {
  const cloud = isCloudHost()
  const httpOnly = (process.env.SCRAPE_HTTP_ONLY || '').toLowerCase() === 'true'

  return {
    cloud,
    /** Skip Playwright entirely when true (set SCRAPE_HTTP_ONLY=true) */
    httpOnly,
    httpTimeoutMs: Number(process.env.SCRAPE_HTTP_TIMEOUT_MS || (cloud ? 12_000 : 25_000)),
    navigationTimeoutMs: Number(
      process.env.SCRAPE_NAV_TIMEOUT_MS || (cloud ? 18_000 : 35_000),
    ),
    selectorTimeoutMs: Number(process.env.SCRAPE_SELECTOR_TIMEOUT_MS || (cloud ? 8_000 : 15_000)),
    settleMs: Number(process.env.SCRAPE_SETTLE_MS || (cloud ? 400 : 1200)),
    refreshWaitMs: Number(process.env.REFRESH_WAIT_MS || (cloud ? 8_000 : 12_000)),
  }
}
