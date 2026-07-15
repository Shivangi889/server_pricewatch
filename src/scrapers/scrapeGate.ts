/**
 * Serialize scrapes so one hang doesn't spawn many browsers
 * and starve the API process (dashboard / login appear "pending").
 *
 * Browser stays warm — closing Chromium after every scrape on Render
 * forced a ~30–60s cold launch on the next refresh.
 */
let chain: Promise<unknown> = Promise.resolve()
let active = 0
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null

const IDLE_CLOSE_MS = Number(process.env.BROWSER_IDLE_CLOSE_MS || 120_000)

export function scrapeConcurrency() {
  return active
}

function scheduleIdleBrowserClose() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer)
  // Only auto-close on tiny hosts after idle — keep warm during active use
  if (process.env.RENDER !== 'true' && process.env.FREE_TIER !== 'true') return
  idleCloseTimer = setTimeout(() => {
    void import('./fetchPage.js')
      .then(({ closeBrowser }) => closeBrowser())
      .catch(() => undefined)
  }, IDLE_CLOSE_MS)
}

export function withScrapeGate<T>(fn: () => Promise<T>): Promise<T> {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer)
    idleCloseTimer = null
  }

  const run = chain.then(async () => {
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      if (active === 0) scheduleIdleBrowserClose()
    }
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
