import fs from 'fs'
import path from 'path'
import { getIndexableFiles } from '../workers/indexing'
import { getEmbeddingService } from '../services/embeddings'

function chunkFile(filePath: string, content: string, repositoryId: string) {
  const lines = content.split('\n')
  const chunks: any[] = []
  const chunkSize = 50
  const overlap = 10
  
  let i = 0
  while (i < lines.length) {
    const startLine = i + 1
    const endLine = Math.min(i + chunkSize, lines.length)
    const chunkLines = lines.slice(i, endLine)
    const chunkContent = chunkLines.join('\n')
    
    if (chunkContent.trim().length > 0) {
      chunks.push({
        id: `chunk_${Math.random()}`,
        repositoryId,
        filePath,
        content: chunkContent,
        startLine,
        endLine,
      })
    }
    
    if (endLine === lines.length) {
      break
    }
    
    i += chunkSize - overlap
  }
  
  return chunks
}

async function main() {
  const cloneDir = path.join(__dirname, '../../tmp/repos/Kalebu_Real-time-Vehicle-Dection-Python')
  console.log(`Analyzing files in ${cloneDir}...`)

  const files = getIndexableFiles(cloneDir, cloneDir)
  console.log(`Found ${files.length} indexable files:`)
  for (const f of files) {
    const relativePath = path.relative(cloneDir, f)
    const stats = fs.statSync(f)
    console.log(`- ${relativePath} (${(stats.size / 1024).toFixed(1)} KB)`)
  }

  const allChunks: any[] = []
  for (const f of files) {
    const relativePath = path.relative(cloneDir, f)
    const content = fs.readFileSync(f, 'utf8')
    const fileChunks = chunkFile(relativePath, content, 'test-repo')
    console.log(`File: ${relativePath} generated ${fileChunks.length} chunks.`)
    allChunks.push(...fileChunks)
  }

  console.log(`Total generated chunks: ${allChunks.length}`)

  // Let's print maximum length of any chunk content
  let maxLen = 0
  let maxChunk: any = null
  for (const chunk of allChunks) {
    const textToEmbed = `File: ${chunk.filePath}\n\n${chunk.content}`
    if (textToEmbed.length > maxLen) {
      maxLen = textToEmbed.length
      maxChunk = chunk
    }
  }

  console.log(`Largest chunk content size: ${maxLen} characters`)
  if (maxChunk) {
    console.log(`Largest chunk file path: ${maxChunk.filePath} (Lines ${maxChunk.startLine}-${maxChunk.endLine})`)
  }

  // Check if Gemini embedding generation works for the largest chunk (or fails)
  console.log('\nTesting embedding generation simulation on the largest chunk...')
  const embeddingService = getEmbeddingService()
  try {
    const testText = `File: ${maxChunk.filePath}\n\n${maxChunk.content}`
    const result = await embeddingService.generateEmbeddings([testText])
    console.log(`Success! Generated embedding. Vector dimension: ${result[0].length}`)
  } catch (err: any) {
    console.error(`Error generating embedding on largest chunk: ${err.message}`)
  }
}

main().catch(console.error)
