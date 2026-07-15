import { fetchHtmlBrowser, closeBrowser } from '../src/scrapers/fetchPage.js'
import fs from 'node:fs'

async function main() {
  const url = process.argv[2] || 'https://www.amazon.in/dp/B0D54JZQH1'
  const $ = await fetchHtmlBrowser(url, { waitMs: 4000 })
  const title = $('title').text()
  const bodyLen = $('body').text().length
  const offscreen = $('.a-offscreen').first().text()
  const whole = $('span.a-price-whole').first().text()
  const productTitle = $('#productTitle').text().trim()
  const snippets = []
  $('script[type="application/ld+json"]').each((_, el) => {
    snippets.push(($(el).html() || '').slice(0, 200))
  })
  console.log({ title, bodyLen, offscreen, whole, productTitle, ldCount: snippets.length, ld0: snippets[0] })
  fs.writeFileSync('tmp-scrape.html', $.html().slice(0, 50000))
  console.log('wrote tmp-scrape.html')
  await closeBrowser()
}

main().catch(async (e) => {
  console.error(e)
  await closeBrowser().catch(() => undefined)
  process.exit(1)
})
