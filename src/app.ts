import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { storesRouter } from './routes/stores.js'
import { productsRouter } from './routes/products.js'
import { settingsRouter } from './routes/settings.js'
import { notificationsRouter } from './routes/notifications.js'
import { dashboardRouter } from './routes/dashboard.js'
import { logsRouter } from './routes/logs.js'
import { jobsRouter } from './routes/jobs.js'
import { errorHandler, notFound } from './middleware/error.js'

export function createApp() {
  const app = express()

  app.use(helmet())
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '2mb' }))
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

  app.use('/api/health', healthRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/stores', storesRouter)
  app.use('/api/products', productsRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/logs', logsRouter)
  app.use('/api/jobs', jobsRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
