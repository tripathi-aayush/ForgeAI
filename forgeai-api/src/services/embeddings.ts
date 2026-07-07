import { env } from '../config/env'

export interface EmbeddingService {
  generateEmbedding(text: string): Promise<number[]>
  generateEmbeddings(texts: string[]): Promise<number[][]>
}

/**
 * OpenAI implementation using text-embedding-3-small (1536 dimensions).
 */
export class OpenAIEmbeddingService implements EmbeddingService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeds = await this.generateEmbeddings([text])
    return embeds[0]
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key is missing')
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: 'text-embedding-3-small',
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI Embeddings API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>
    }

    // Sort by index to preserve input order
    const sorted = [...data.data].sort((a, b) => a.index - b.index)
    return sorted.map((item) => item.embedding)
  }
}

/**
 * Voyage AI implementation. Uses voyage-code-2 (1536 dimensions) or voyage-3 (1024/1536 dimensions).
 * We default to voyage-code-2 which provides 1536 dimensions.
 */
export class VoyageEmbeddingService implements EmbeddingService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeds = await this.generateEmbeddings([text])
    return embeds[0]
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('Voyage AI API Key is missing')
    }

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: 'voyage-code-2',
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Voyage AI Embeddings API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>
    }

    // Sort by index to preserve input order
    const sorted = [...data.data].sort((a, b) => a.index - b.index)
    return sorted.map((item) => item.embedding)
  }
}

/**
 * Google Gemini implementation. Uses text-embedding-004 (768 dimensions), padded to 1536.
 */
export class GeminiEmbeddingService implements EmbeddingService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeds = await this.generateEmbeddings([text])
    return embeds[0]
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('Gemini API Key is missing')
    }

    const requests = texts.map((text) => ({
      model: 'models/gemini-embedding-2',
      content: {
        parts: [{ text }],
      },
      outputDimensionality: 1536,
    }))

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini Embeddings API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as {
      embeddings: Array<{ values: number[] }>
    }

    return data.embeddings.map((item) => {
      let vec = item.values
      // If the model returns more than 1536 dimensions, slice it
      if (vec.length > 1536) {
        vec = vec.slice(0, 1536)
      }
      // If the model returns fewer than 1536 dimensions, pad it with zeros
      const padCount = 1536 - vec.length
      return [...vec, ...Array(padCount).fill(0)]
    })
  }
}

/**
 * Mock implementation for testing/demo when no api keys are set.
 * Returns random 1536-dimensional vectors.
 */
export class MockEmbeddingService implements EmbeddingService {
  async generateEmbedding(_text: string): Promise<number[]> {
    const vector = Array.from({ length: 1536 }, () => Math.random() * 2 - 1)
    // Normalize vector
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
    return vector.map((val) => val / magnitude)
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.generateEmbedding(text)))
  }
}

/**
 * Get active EmbeddingService instance based on configured environment variables.
 */
export function getEmbeddingService(): EmbeddingService {
  if (env.GEMINI_API_KEY) {
    console.log('Using GeminiEmbeddingService')
    return new GeminiEmbeddingService(env.GEMINI_API_KEY)
  }

  if (env.OPENAI_API_KEY) {
    console.log('Using OpenAIEmbeddingService')
    return new OpenAIEmbeddingService(env.OPENAI_API_KEY)
  }

  if (env.VOYAGE_API_KEY) {
    console.log('Using VoyageEmbeddingService')
    return new VoyageEmbeddingService(env.VOYAGE_API_KEY)
  }

  console.warn('⚠️ No embedding API keys found in env. Falling back to MockEmbeddingService (Demo Mode).')
  return new MockEmbeddingService()
}
