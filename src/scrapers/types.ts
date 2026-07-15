export type ScrapeResult = {
  title?: string
  image?: string
  price: number
  oldPrice?: number
  discount?: number
  available: boolean
  offerText?: string
  source: 'live' | 'demo'
  rawNote?: string
}

export type ScrapeContext = {
  url: string
  pincode?: string
  storeSlug: string
  /** Previous known price — used by demo mode */
  previousPrice?: number
  previousAvailable?: boolean | null
}

export type StoreScraper = {
  slug: string
  scrape: (ctx: ScrapeContext) => Promise<ScrapeResult>
}
