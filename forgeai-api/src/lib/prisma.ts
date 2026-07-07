import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    // Neon free tier suspends after inactivity — allow time for cold start
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

/**
 * Retry a Prisma operation up to `retries` times with exponential backoff.
 * Handles Neon's cold-start connection drops (P1001, P1008, P1017).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 500
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      const isConnectionError = ['P1001', 'P1008', 'P1017'].includes(code ?? '')

      if (isConnectionError && attempt < retries) {
        console.warn(
          `DB connection failed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms... [${code}]`
        )
        await new Promise((r) => setTimeout(r, delayMs * attempt))
        continue
      }

      throw err
    }
  }
  throw new Error('withRetry: exhausted retries')
}
