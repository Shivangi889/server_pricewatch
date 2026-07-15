import { Redis } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'

const redisUrl = () => process.env.REDIS_URL || 'redis://127.0.0.1:6379'

/** BullMQ prefers its own ioredis — pass options, not a shared client. */
export function getBullConnection(): ConnectionOptions {
  return {
    url: redisUrl(),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
}

/** One-shot ping; does not keep a reconnecting client around. */
export async function pingRedis(): Promise<void> {
  const url = redisUrl()
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
    lazyConnect: true,
    enableOfflineQueue: false,
  })
  client.on('error', () => {
    /* swallow — probe only */
  })
  try {
    await client.connect()
    const pong = await client.ping()
    if (pong !== 'PONG') throw new Error('unexpected ping response')
  } catch {
    throw new Error(`Redis unreachable at ${url}`)
  } finally {
    try {
      client.disconnect()
    } catch {
      /* ignore */
    }
  }
}
