import { Queue } from 'bullmq'
import { getRedisConnection } from './redis'

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
