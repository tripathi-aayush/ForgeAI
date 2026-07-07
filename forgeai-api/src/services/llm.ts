import { env } from '../config/env'

export interface LlmService {
  generateAnswer(prompt: string, systemPrompt?: string): Promise<string>
}

/**
 * OpenAI implementation using gpt-4o-mini.
 */
export class OpenAILlmService implements LlmService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateAnswer(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key is missing')
    }

    const messages = []
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.2,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI Chat API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }

    return data.choices[0]?.message?.content || 'No response returned from OpenAI.'
  }
}

/**
 * Gemini implementation using gemini-2.5-flash.
 */
export class GeminiLlmService implements LlmService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async generateAnswer(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Gemini API Key is missing')
    }

    const payload: any = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ]
    }

    if (systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: systemPrompt }]
      }
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini generateContent API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text: string }>
        }
      }>
    }

    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text
    return answer || 'No response returned from Gemini.'
  }
}

/**
 * Mock implementation for testing/demo when no api keys are set.
 * Reads the prompt context and generates a mock response based on the files found in context.
 */
export class MockLlmService implements LlmService {
  async generateAnswer(prompt: string, _systemPrompt?: string): Promise<string> {
    // Attempt to extract some context filenames
    const fileMatches = [...prompt.matchAll(/File:\s*([^\n\s]+)/g)].map((m) => m[1])
    const uniqueFiles = Array.from(new Set(fileMatches))

    const filesList = uniqueFiles.length > 0 
      ? uniqueFiles.map(f => `- \`${f}\``).join('\n') 
      : 'no files'

    return `### ForgeAI Demo Mode Response (No API Keys Configured)

This is a simulated answer because no **OpenAI API Key** was provided in the backend configurations. 

**Context Received:**
I received the following source files for retrieval context:
${filesList}

**Your Query:**
"${prompt.slice(prompt.lastIndexOf('User Query:') + 11).trim()}"

**Suggested Response:**
If OpenAI keys were active, a semantic synthesis of these files would be displayed here. To enable live LLM completions, please define \`OPENAI_API_KEY\` in your \`forgeai-api/.env\` file.`
  }
}

/**
 * Get active LlmService instance based on configured environment variables.
 */
export function getLlmService(): LlmService {
  if (env.GEMINI_API_KEY) {
    console.log('Using GeminiLlmService')
    return new GeminiLlmService(env.GEMINI_API_KEY)
  }

  if (env.OPENAI_API_KEY) {
    console.log('Using OpenAILlmService')
    return new OpenAILlmService(env.OPENAI_API_KEY)
  }

  console.warn('⚠️ No OpenAI or Gemini API key found in env. Falling back to MockLlmService (Demo Mode).')
  return new MockLlmService()
}
