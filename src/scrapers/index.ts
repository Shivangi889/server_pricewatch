import { amazonScraper } from './amazon.js'
import { flipkartScraper } from './flipkart.js'
import {
  bigbasketScraper,
  blinkitScraper,
  cromaScraper,
  instamartScraper,
  jiomartScraper,
  meeshoScraper,
  relianceDigitalScraper,
  zeptoScraper,
} from './meeshoAndQuick.js'
import { demoScrape } from './demo.js'
import type { ScrapeContext, ScrapeResult, StoreScraper } from './types.js'

const scrapers: Record<string, StoreScraper> = {
  amazon: amazonScraper,
  flipkart: flipkartScraper,
  meesho: meeshoScraper,
  blinkit: blinkitScraper,
  zepto: zeptoScraper,
  instamart: instamartScraper,
  bigbasket: bigbasketScraper,
  'reliance-digital': relianceDigitalScraper,
  jiomart: jiomartScraper,
  croma: cromaScraper,
}

export function getScraperMode(): 'live' | 'demo' | 'auto' {
  const mode = (process.env.SCRAPER_MODE || 'live').toLowerCase()
  if (mode === 'live' || mode === 'demo' || mode === 'auto') return mode
  return 'live'
}

export async function scrapeProduct(ctx: ScrapeContext): Promise<ScrapeResult> {
  const mode = getScraperMode()
  if (mode === 'demo') return demoScrape(ctx)

  const scraper = scrapers[ctx.storeSlug]
  if (!scraper) {
    throw new Error(`No scraper for store: ${ctx.storeSlug}`)
  }

  try {
    return await scraper.scrape(ctx)
  } catch (err) {
    if (mode === 'auto') {
      const demo = demoScrape(ctx)
      demo.rawNote = `live failed → demo (${err instanceof Error ? err.message : 'error'})`
      return demo
    }
    // live: never invent prices — surface the real failure
    throw err
  }
}

export { scrapers }
