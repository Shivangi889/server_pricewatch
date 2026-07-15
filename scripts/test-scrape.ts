import { scrapeProduct } from '../src/scrapers/index.js'
import { closeBrowser } from '../src/scrapers/fetchPage.js'

async function main() {
  const url = process.argv[2] || 'https://www.amazon.in/dp/B0D54JZQH1'
  const store = process.argv[3] || 'amazon'
  console.log('Scraping', store, url)
  const r = await scrapeProduct({ url, storeSlug: store })
  console.log(JSON.stringify(r, null, 2))
  await closeBrowser()
}

main().catch(async (err) => {
  console.error('FAIL:', err.message)
  await closeBrowser().catch(() => undefined)
  process.exit(1)
})
