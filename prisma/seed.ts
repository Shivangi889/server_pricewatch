import 'dotenv/config'
import { PrismaClient, StoreCategory, StoreHealth } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const stores = [
  {
    slug: 'amazon',
    name: 'Amazon',
    domain: 'amazon.in',
    website: 'https://www.amazon.in',
    color: '#FF9900',
    category: StoreCategory.ecommerce,
    requiresPincode: false,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'flipkart',
    name: 'Flipkart',
    domain: 'flipkart.com',
    website: 'https://www.flipkart.com',
    color: '#2874F0',
    category: StoreCategory.ecommerce,
    requiresPincode: false,
    status: StoreHealth.degraded,
    builtIn: true,
  },
  {
    slug: 'meesho',
    name: 'Meesho',
    domain: 'meesho.com',
    website: 'https://www.meesho.com',
    color: '#9F2089',
    category: StoreCategory.ecommerce,
    requiresPincode: false,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'blinkit',
    name: 'Blinkit',
    domain: 'blinkit.com',
    website: 'https://blinkit.com',
    color: '#F8CB46',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'zepto',
    name: 'Zepto',
    domain: 'zeptonow.com',
    website: 'https://www.zeptonow.com',
    color: '#3C019F',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.healthy,
    builtIn: true,
  },
  {
    slug: 'instamart',
    name: 'Instamart',
    domain: 'swiggy.com',
    website: 'https://www.swiggy.com/instamart',
    color: '#FC8019',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.degraded,
    builtIn: true,
  },
  {
    slug: 'bigbasket',
    name: 'BigBasket',
    domain: 'bigbasket.com',
    website: 'https://www.bigbasket.com',
    color: '#84C225',
    category: StoreCategory.quick_commerce,
    requiresPincode: true,
    status: StoreHealth.healthy,
    builtIn: true,
  },
]

async function main() {
  const email = process.env.OWNER_EMAIL || 'you@pricewatch.app'
  const password = process.env.OWNER_PASSWORD || 'watch123'
  const name = process.env.OWNER_NAME || 'PriceWatch Owner'

  const passwordHash = await bcrypt.hash(password, 10)

  await prisma.owner.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { email, name, passwordHash },
  })

  for (const store of stores) {
    await prisma.store.upsert({
      where: { slug: store.slug },
      update: {
        name: store.name,
        domain: store.domain,
        website: store.website,
        color: store.color,
        category: store.category,
        requiresPincode: store.requiresPincode,
        status: store.status,
        builtIn: store.builtIn,
      },
      create: store,
    })
  }

  console.log('Seed complete')
  console.log(`Owner: ${email} / ${password}`)
  console.log(`Stores: ${stores.length}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
