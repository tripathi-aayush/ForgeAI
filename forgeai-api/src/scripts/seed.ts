import { PrismaClient } from '@prisma/client'
import { encrypt } from '../lib/crypto'

const prisma = new PrismaClient()

// 1536-dimensional mock embedding helper
function getMockVector() {
  const vector = Array.from({ length: 1536 }, () => Math.random() * 2 - 1)
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  return vector.map((val) => val / magnitude)
}

async function main() {
  console.log('🌱 Starting database seeding...')

  // 1. Find or create a demo user if none exists
  let user = await prisma.user.findFirst()
  
  if (!user) {
    console.log('Creating a demo user since none was found...')
    user = await prisma.user.create({
      data: {
        githubId: 999999,
        username: 'forgeai-demo-user',
        displayName: 'Demo User',
        avatarUrl: 'https://avatars.githubusercontent.com/u/999999?v=4',
        email: 'demo@forgeai.dev',
        githubToken: encrypt('gho_mocktokenfordemopurposesonly12345'),
      },
    })
  }

  // 2. Find or create default workspace for this user
  let workspace = await prisma.workspace.findFirst({
    where: { userId: user.id },
  })

  if (!workspace) {
    console.log(`Creating default workspace for user: ${user.username}`)
    workspace = await prisma.workspace.create({
      data: {
        name: 'Default Workspace',
        userId: user.id,
      },
    })
  }

  // 3. Seed Spoon-Knife repository
  console.log('Seeding curated Spoon-Knife repository...')
  const spoonKnife = await prisma.repository.upsert({
    where: {
      workspaceId_githubUrl: {
        workspaceId: workspace.id,
        githubUrl: 'https://github.com/octocat/Spoon-Knife.git',
      },
    },
    update: {
      indexingStatus: 'COMPLETED',
      lastIndexedAt: new Date(),
    },
    create: {
      workspaceId: workspace.id,
      name: 'Spoon-Knife',
      owner: 'octocat',
      githubUrl: 'https://github.com/octocat/Spoon-Knife.git',
      defaultBranch: 'main',
      indexingStatus: 'COMPLETED',
      lastIndexedAt: new Date(),
    },
  })

  // 4. Seed CodeChunks for Spoon-Knife
  console.log('Seeding mock CodeChunks for Spoon-Knife to allow immediate RAG queries...')
  
  // Clear any existing chunks first to avoid duplicates
  await prisma.codeChunk.deleteMany({
    where: { repositoryId: spoonKnife.id },
  })

  const mockChunks = [
    {
      filePath: 'README.md',
      content: `# Spoon-Knife\n\nAll that this repository does is show how to fork a repository on GitHub. It contains a few simple files including index.html and some stylesheets. Feel free to use it for test clones and experiments.`,
      startLine: 1,
      endLine: 4,
    },
    {
      filePath: 'index.html',
      content: `<!DOCTYPE html>\n<html>\n  <head>\n    <title>Spoon-Knife</title>\n    <link href="style.css" rel="stylesheet">\n  </head>\n  <body>\n    <h1>Forking a Repository</h1>\n    <p>This page is hosted inside the octocat/Spoon-Knife repository. It is a simple HTML page used to teach forks and pull requests on GitHub.</p>\n  </body>\n</html>`,
      startLine: 1,
      endLine: 12,
    },
    {
      filePath: 'style.css',
      content: `body {\n  background-color: #f4f4f9;\n  color: #333;\n  font-family: sans-serif;\n  padding: 2rem;\n}\nh1 {\n  color: #4f46e5;\n}`,
      startLine: 1,
      endLine: 8,
    },
  ]

  // Insert mock chunks with vector embeddings using executeRawUnsafe
  for (const chunk of mockChunks) {
    const id = `chunk_${Math.random().toString(36).substring(7)}`
    const vector = getMockVector()

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "code_chunks" ("id", "repositoryId", "filePath", "content", "startLine", "endLine", "embedding", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW(), NOW())
      `,
      id,
      spoonKnife.id,
      chunk.filePath,
      chunk.content,
      chunk.startLine,
      chunk.endLine,
      `[${vector.join(',')}]`
    )
  }

  console.log('✅ Seeding completed successfully!')
  console.log(`Demo workspace ID: ${workspace.id}`)
  console.log(`Curated Repository ID: ${spoonKnife.id}`)
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
