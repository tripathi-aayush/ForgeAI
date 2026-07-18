import { Queue } from 'bullmq'
import { getRedisConnection } from './redis'
import { EXECUTION_QUEUE_NAME, DISCOVERY_QUEUE_NAME } from '../config/constants'

export const INDEX_QUEUE_NAME = 'repo-indexing'

export const indexingQueue = new Queue(INDEX_QUEUE_NAME, {
  connection: getRedisConnection() as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
})

// Phase 4: Code execution queue.
// attempts: 1 — re-diagnosis is managed explicitly in the worker (not via BullMQ retries)
// so that the attempt counter in the DB is the authoritative source of truth.
export { EXECUTION_QUEUE_NAME }
export const executionQueue = new Queue(EXECUTION_QUEUE_NAME, {
  connection: getRedisConnection() as any,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  },
})

// Phase 6: Discovery queue.
// Weekly repeatable job is registered in the worker. No retries — if a weekly run fails,
// the next scheduled run will try again. One-off trigger jobs are added via the API.
export { DISCOVERY_QUEUE_NAME }
export const discoveryQueue = new Queue(DISCOVERY_QUEUE_NAME, {
  connection: getRedisConnection() as any,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  },
})

