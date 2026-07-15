# Playwright base image — includes Chromium + OS deps (required for live scrapers)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install ALL deps (incl. typescript + @types) for compile — NODE_ENV=production
# would skip devDependencies and break `tsc`.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm ci --include=dev

# App source
COPY tsconfig.json ./
COPY src ./src

RUN npx prisma generate && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=4000
ENV ENABLE_WORKER=true
ENV SCRAPER_MODE=live

EXPOSE 4000

# prisma CLI stays via dependency; apply migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
