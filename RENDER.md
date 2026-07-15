# Deploy API to Render (Docker)

## Why Docker
Playwright needs Chromium + Linux libs. Plain Node on Render often breaks scrapers. Use the `Dockerfile`.

## Files added
- `Dockerfile` — Playwright image + build + migrate + start
- `render.yaml` — Blueprint (web + Redis Key Value)
- `.dockerignore`
- `.env.example`
- migration `owner_avatar` for `avatarUrl`

## Steps on Render

1. Push this `server` repo (or monorepo with **Root Directory = `server`**).
2. **New → Blueprint** and select `render.yaml`  
   **Or** manually:
   - **New → Key Value** (Redis) → name `pricewatch-redis`
   - **New → Web Service → Docker** → Dockerfile in `server/`
3. Set env vars (Dashboard → Environment):

| Key | Value |
|-----|--------|
| `DATABASE_URL` | Neon pooled URL |
| `DIRECT_URL` | Neon URL (same OK for pooler) |
| `JWT_SECRET` | long random string |
| `CORS_ORIGIN` | `https://your-frontend.vercel.app` |
| `OWNER_EMAIL` | login email |
| `OWNER_PASSWORD` | strong password |
| `OWNER_NAME` | your name |
| `REDIS_URL` | from Key Value service (auto if Blueprint) |
| `SCRAPER_MODE` | `live` |
| `ENABLE_WORKER` | `true` |

4. Deploy → open `https://your-service.onrender.com/api/health` → `{ ok: true, db: "up" }`
5. One-time seed (Render Shell or local against Neon):

```bash
npx tsx prisma/seed.ts
```

(Requires `tsx` / `npm install` in a one-off; or run seed from your PC with production `DATABASE_URL`.)

6. Point frontend `VITE_API_URL` to the Render URL, rebuild frontend.

## Notes
- Free Render web services **sleep** after idle — first request is slow; scrapes may time out on cold start. Starter plan stays awake.
- Without Redis, app still starts (in-process fallback) but scheduled checks are weaker.
- Do **not** commit `.env` with real secrets.
