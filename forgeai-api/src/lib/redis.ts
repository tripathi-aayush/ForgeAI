import Redis from 'ioredis'
import { env } from '../config/env'

/**
 * Shared Redis connection for BullMQ and general caching.
 * Supports Upstash (TLS via rediss:// protocol).
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false, // Upstash compatibility
  lazyConnect: true,
})

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message)
})

redis.on('connect', () => {
  console.log('✅ Redis connected')
})

/**
 * Return a fresh Redis connection instance.
 * BullMQ workers/queues require separate connections to prevent blocking conflicts.
 */
export function getRedisConnection() {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  })
}
