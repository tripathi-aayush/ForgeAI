import crypto from 'crypto'
import { env } from '../config/env'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16

/**
 * Encrypt a string using AES-256-GCM.
 * Returns a colon-separated string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  const iv = crypto.randomBytes(IV_LENGTH)

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Expects the format: iv:authTag:ciphertext (all hex-encoded).
 */
export function decrypt(encryptedText: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  const [ivHex, authTagHex, ciphertext] = encryptedText.split(':')

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('Invalid encrypted text format')
  }

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * Generate a random hex string for use as CSRF state tokens.
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex')
}
