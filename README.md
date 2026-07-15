# PriceWatch API

Node.js + Express + Prisma backend for the **single-user** PriceWatch app.  
Designed for **Neon PostgreSQL**.

## Why Neon is a good fit

- Managed Postgres (no local DB required)
- Free tier is enough for personal MVP
- Works cleanly with Prisma (`DATABASE_URL` + `DIRECT_URL`)
- Easy SSL + branching for experiments

## 1. Create Neon project

1. Go to [https://console.neon.tech](https://console.neon.tech)
2. Create project (region close to you)
3. Open **Dashboard → Connection details**
4. Copy:
   - **Pooled** connection string → `DATABASE_URL`
   - **Direct** connection string → `DIRECT_URL`  
     (same host without `-pooler` in hostname is the direct one)

## 2. Configure env

```bash
cd server
copy .env.example .env
```

Edit `.env` and paste your Neon URLs + change `JWT_SECRET`.

## 3. Install, migrate, seed

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed
```

Seed creates:
- Owner: `you@pricewatch.app` / `watch123` (or values from `.env`)
- Stores: Amazon, Flipkart, Meesho, Blinkit, Zepto, Instamart, BigBasket

## 4. Run API

```bash
npm run dev
```

API: `http://localhost:4000`  
Health: `http://localhost:4000/api/health`

## Auth

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "you@pricewatch.app", "password": "watch123" }
```

Use returned `token` as:

```http
Authorization: Bearer <token>
```

## Main routes

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | DB ping |
| POST | `/api/auth/login` | JWT |
| GET | `/api/auth/me` | Owner profile |
| GET/POST | `/api/stores` | List / add store |
| DELETE | `/api/stores/:id` | Custom stores only |
| GET/POST | `/api/products` | List / create (multi-pincode) |
| GET/PATCH/DELETE | `/api/products/:id` | Detail / update / delete |
| POST | `/api/products/:id/pause` | Toggle pause |
| POST | `/api/products/:id/refresh` | Force scrape now |
| GET/PATCH | `/api/settings` | Telegram + tracking prefs |
| GET | `/api/notifications` | Alerts |
| GET | `/api/dashboard/stats` | Overview |
| GET | `/api/logs` | Activity logs |
| POST | `/api/jobs/sweep` | Enqueue due checks |
| GET | `/api/jobs/stats` | Queue counts (needs Redis) |

## Workers & scrapers

On boot the API starts a checker:

1. **Redis available** → BullMQ worker + sweep every 60s  
2. **No Redis** → in-process fallback (works for local/dev without Docker)

```bash
# optional Redis
docker compose up -d redis
```

Env:

| Var | Meaning |
|-----|---------|
| `REDIS_URL` | default `redis://127.0.0.1:6379` |
| `ENABLE_WORKER` | `true` / `false` |
| `SCRAPER_MODE` | **`live`** (real only) · `auto` (live→demo) · `demo` (fake) |

Default for delivery is **`live`** — never invents prices. Failures show in Logs / product `error` status.

Live scrapers use **Playwright Chromium** when sites block plain HTTP.

```bash
npm run playwright:install   # once per machine
```

Flow: sweep → scrape → compare price/discount/offer/pincode → history + notification → Telegram (if configured).

## Schema highlights

- **Owner** — one personal account
- **Store** — ecommerce + quick_commerce (`requiresPincode`)
- **Product** + **ProductPincode** — many pincodes per product
- **Notification** — includes `pincode_available`
- **PriceHistory** / **ActivityLog**

## Scripts

```bash
npm run dev          # API + worker
npm run redis:up     # docker compose redis (if Docker installed)
npm run db:migrate
npm run db:seed
npm run db:studio
```
