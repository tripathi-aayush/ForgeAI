import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection string'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  GITHUB_CLIENT_ID: z.string().min(1, 'GITHUB_CLIENT_ID is required'),
  GITHUB_CLIENT_SECRET: z.string().min(1, 'GITHUB_CLIENT_SECRET is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be a 64-char hex string (32 bytes)'),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
  OPENAI_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
  VOYAGE_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
  GEMINI_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
  GROQ_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
  // Phase 4: Judge0 execution sandbox (optional — absence causes graceful skip)
  JUDGE0_BASE_URL: z.preprocess((val) => (val === '' ? undefined : val), z.string().url().optional()),
  JUDGE0_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
  // Phase 5: Jina AI embedding provider (optional fallback)
  JINA_API_KEY: z.preprocess((val) => (val === '' ? undefined : val), z.string().optional()),
})

function validateEnv() {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    console.error('❌ Invalid environment variables:')
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`)
    }
    process.exit(1)
  }

  return result.data
}

export const env = validateEnv()
