import { spliceLines, commitFullFile } from '../services/gitops'

/**
 * Unit tests for gitops.ts helpers.
 *
 * Tests:
 *   - spliceLines: verifies content outside the edited line range is preserved.
 *   - commitFullFile: verifies SHA-fetch logic and branch-protection guard.
 *
 * Run with: npx tsx src/__tests__/gitops.test.ts
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// spliceLines tests
// ---------------------------------------------------------------------------
console.log('\n🧪 spliceLines unit tests\n')

test('preserves content before and after the edited range', () => {
  const original = [
    'line 1 — header',
    'line 2 — before',
    'line 3 — buggy code A',
    'line 4 — buggy code B',
    'line 5 — after',
    'line 6 — footer',
  ].join('\n')

  const result = spliceLines(original, 3, 4, 'line 3 — fixed A\nline 4 — fixed B')

  const expected = [
    'line 1 — header',
    'line 2 — before',
    'line 3 — fixed A',
    'line 4 — fixed B',
    'line 5 — after',
    'line 6 — footer',
  ].join('\n')

  assert(result === expected, `Got:\n${result}\n\nExpected:\n${expected}`)
})

test('handles replacement with fewer lines than original', () => {
  const original = 'A\nB\nC\nD\nE'
  const result = spliceLines(original, 2, 4, 'REPLACED')
  assert(result === 'A\nREPLACED\nE', `Got: ${result}`)
})

test('handles replacement with more lines than original', () => {
  const original = 'A\nB\nC\nD\nE'
  const result = spliceLines(original, 3, 3, 'C1\nC2\nC3')
  assert(result === 'A\nB\nC1\nC2\nC3\nD\nE', `Got: ${result}`)
})

test('handles editing the first line', () => {
  const original = 'first\nsecond\nthird'
  const result = spliceLines(original, 1, 1, 'FIRST')
  assert(result === 'FIRST\nsecond\nthird', `Got: ${result}`)
})

test('handles editing the last line', () => {
  const original = 'first\nsecond\nthird'
  const result = spliceLines(original, 3, 3, 'THIRD')
  assert(result === 'first\nsecond\nTHIRD', `Got: ${result}`)
})

test('throws on invalid line range', () => {
  try {
    spliceLines('A\nB\nC', 4, 5, 'X')
    assert(false, 'Should have thrown')
  } catch (err: any) {
    assert(err.message.includes('Invalid line range'), `Unexpected error: ${err.message}`)
  }
})

// ---------------------------------------------------------------------------
// commitFullFile tests — run inside async main() to avoid top-level await
// ---------------------------------------------------------------------------

/**
 * Build a minimal Octokit mock for commitFullFile tests.
 * Captures calls so we can assert on arguments. No network requests made.
 */
function buildMockOctokit(opts: {
  /** Return value for repos.getContent. Pass an Error with .status to simulate HTTP errors. */
  getContentResult: { sha: string; content: string } | Error
}) {
  const calls: Record<string, any[]> = {
    getContent: [],
    createOrUpdateFileContents: [],
  }

  const mock = {
    repos: {
      getContent: async (args: any) => {
        calls.getContent.push(args)
        if (opts.getContentResult instanceof Error) {
          throw opts.getContentResult
        }
        return { data: opts.getContentResult }
      },
      createOrUpdateFileContents: async (args: any) => {
        calls.createOrUpdateFileContents.push(args)
        return { data: {} }
      },
    },
    calls,
  }

  return mock as any
}

async function main() {
  console.log('\n🧪 commitFullFile unit tests\n')

  // Test 1: Creating a new file (GET returns 404 — proceed without sha)
  await testAsync('creates new file when GET returns 404 (no sha in update call)', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 })
    const octokit = buildMockOctokit({ getContentResult: notFoundError })

    await commitFullFile(
      octokit,
      'owner',
      'repo',
      'forgeai/docs-123',  // non-protected branch
      'main',              // defaultBranch
      'README.md',
      '# Hello World',
      'docs: add README'
    )

    assert(
      octokit.calls.getContent.length === 1,
      'getContent should be called once to attempt SHA fetch'
    )
    assert(
      octokit.calls.createOrUpdateFileContents.length === 1,
      'createOrUpdateFileContents should be called once'
    )

    const updateCall = octokit.calls.createOrUpdateFileContents[0]
    assert(
      updateCall.sha === undefined,
      `sha must be undefined for a new file, got: ${updateCall.sha}`
    )
    assert(updateCall.path === 'README.md', `path should be README.md, got: ${updateCall.path}`)
  })

  // Test 2: Updating an existing file — SHA must be fetched and included
  await testAsync('fetches SHA and includes it in the update call for an existing file', async () => {
    const existingFile = {
      sha: 'abc123existingsha',
      content: Buffer.from('# Old Content').toString('base64'),
    }
    const octokit = buildMockOctokit({ getContentResult: existingFile })

    await commitFullFile(
      octokit,
      'owner',
      'repo',
      'forgeai/docs-456',
      'main',
      'README.md',
      '# Updated Content',
      'docs: update README'
    )

    assert(
      octokit.calls.getContent.length === 1,
      'getContent should be called once to retrieve the existing SHA'
    )

    const updateCall = octokit.calls.createOrUpdateFileContents[0]

    assert(
      updateCall.sha === 'abc123existingsha',
      `sha must match the existing file sha, got: ${updateCall.sha}`
    )

    const decoded = Buffer.from(updateCall.content, 'base64').toString('utf8')
    assert(
      decoded === '# Updated Content',
      `content decoded must be '# Updated Content', got: ${decoded}`
    )
  })

  // Test 3: Protected branch check rejects writes to the repo's actual default branch
  await testAsync("rejects write to the repo's actual default branch", async () => {
    const octokit = buildMockOctokit({ getContentResult: { sha: 'sha', content: '' } })

    try {
      await commitFullFile(
        octokit,
        'owner',
        'repo',
        'main',   // branchName === defaultBranch — must be rejected
        'main',   // defaultBranch
        'README.md',
        '# Should not be written',
        'docs: this should fail'
      )
      assert(false, 'Should have thrown a protected-branch error')
    } catch (err: any) {
      assert(
        err.message.includes('Refusing to write'),
        `Expected protected-branch error, got: ${err.message}`
      )
      // Safety check: neither API call must have been made
      assert(
        octokit.calls.getContent.length === 0,
        'getContent must NOT be called when branch is protected'
      )
      assert(
        octokit.calls.createOrUpdateFileContents.length === 0,
        'createOrUpdateFileContents must NOT be called when branch is protected'
      )
    }
  })

  console.log('\n✅ All gitops tests complete\n')
}

main().catch((err) => {
  console.error('Test runner error:', err)
  process.exit(1)
})
