import 'dotenv/config'
import { createApp } from './app.js'
import { pingRedis } from './queue/connection.js'
import { startCheckWorker } from './queue/worker.js'
import { startScheduler } from './queue/scheduler.js'
import { startInProcessRunner } from './queue/inProcess.js'

const port = Number(process.env.PORT || 4000)
const app = createApp()

app.listen(port, '0.0.0.0', () => {
  console.log(`PriceWatch API listening on http://0.0.0.0:${port}`)
  console.log(`Health: http://0.0.0.0:${port}/api/health`)
})

const enableWorker = (process.env.ENABLE_WORKER || 'true').toLowerCase() !== 'false'

async function bootWorkers() {
  if (!enableWorker) {
    console.log('[worker] disabled (ENABLE_WORKER=false)')
    return
  }

  try {
    await pingRedis()
    startCheckWorker()
    await startScheduler()
    console.log('[worker] BullMQ + Redis ready')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[worker] Redis not reachable (${message})`)
    console.warn('[worker] Falling back to in-process scheduler (fine for local/dev)')
    startInProcessRunner()
  }
}

void bootWorkers()
