import { prisma } from '../lib/prisma'
import { indexingQueue } from '../lib/queue'

async function main() {
  console.log('Fetching repositories from database...')
  const repos = await prisma.repository.findMany({
    include: {
      workspace: {
        include: {
          user: true
        }
      }
    }
  })

  if (repos.length === 0) {
    console.log('No repositories found in database.')
    process.exit(0)
  }

  console.log(`\nFound ${repos.length} repositories:`)
  for (const repo of repos) {
    console.log(`- [${repo.id}] ${repo.owner}/${repo.name}`)
    console.log(`  GitHub URL: ${repo.githubUrl}`)
    console.log(`  Default Branch: ${repo.defaultBranch}`)
    console.log(`  Indexing Status: ${repo.indexingStatus}`)
    console.log(`  Last Indexed At: ${repo.lastIndexedAt}`)
    console.log(`  User: ${repo.workspace.user.username}`)
    console.log('--------------------------------------------')
  }

  // If a command line parameter is specified, trigger re-indexing
  const repoIdToReindex = process.argv[2]
  if (repoIdToReindex) {
    const repo = repos.find(r => r.id === repoIdToReindex || `${r.owner}/${r.name}` === repoIdToReindex)
    if (!repo) {
      console.error(`Error: Repository "${repoIdToReindex}" not found.`)
      process.exit(1)
    }

    console.log(`Queueing indexing job for ${repo.owner}/${repo.name} (ID: ${repo.id})...`)
    const job = await indexingQueue.add('index_repository', {
      repositoryId: repo.id,
      userId: repo.workspace.user.id
    })
    console.log(`Job queued successfully! Job ID: ${job.id}`)
  } else {
    console.log('\nTo trigger re-indexing, run: npx tsx src/scripts/check_indexing.ts <repoId or owner/name>')
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
