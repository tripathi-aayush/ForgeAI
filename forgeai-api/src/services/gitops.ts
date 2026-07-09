import { Octokit } from '@octokit/rest'
import { PROTECTED_BRANCH_PATTERN } from '../config/constants'

/**
 * Validates that a target branch is NOT a protected branch.
 * Primary check: compares against the repository's actual defaultBranch.
 * Fallback check: matches against the PROTECTED_BRANCH_PATTERN regex.
 * Throws if the branch matches either check.
 */
function assertNotProtectedBranch(branchName: string, defaultBranch: string): void {
  if (branchName === defaultBranch) {
    throw new Error(
      `Refusing to write to the repository's default branch "${defaultBranch}". ` +
      `ForgeAI always creates a separate branch for changes.`
    )
  }

  if (PROTECTED_BRANCH_PATTERN.test(branchName)) {
    throw new Error(
      `Refusing to write to protected branch "${branchName}". ` +
      `ForgeAI always creates a separate branch for changes.`
    )
  }
}

/**
 * Creates a new branch for a bugfix from the default branch HEAD.
 * Returns the new branch name.
 */
export async function createBugfixBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  timestamp: number
): Promise<string> {
  const branchName = `forgeai/bugfix-${timestamp}`

  // Validate the new branch name is not protected
  assertNotProtectedBranch(branchName, defaultBranch)

  // Get the SHA of the default branch HEAD
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${defaultBranch}`,
  })

  // Create the new branch
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: refData.object.sha,
  })

  return branchName
}

/**
 * Commits a fix by splicing proposedCode into a specific line range of a file.
 * Fetches the full file, reconstructs it with the fix spliced in, and pushes.
 *
 * IMPORTANT: This function preserves all content outside the edited line range.
 * It does NOT overwrite the file with just the proposed code.
 */
export async function commitFix(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  defaultBranch: string,
  filePath: string,
  startLine: number,
  endLine: number,
  proposedCode: string,
  commitMessage: string
): Promise<void> {
  // Enforce branch protection
  assertNotProtectedBranch(branchName, defaultBranch)

  // 1. Fetch current file content from the branch
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref: branchName,
  })

  if (Array.isArray(data) || !('content' in data)) {
    throw new Error(`Cannot commit to "${filePath}" — not a valid file`)
  }

  const currentContent = Buffer.from(data.content, 'base64').toString('utf8')
  const fileSha = data.sha

  // 2. Splice the proposed code into the correct line range
  const reconstructedContent = spliceLines(currentContent, startLine, endLine, proposedCode)

  // 3. Push the reconstructed file
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(reconstructedContent).toString('base64'),
    sha: fileSha,
    branch: branchName,
  })
}

/**
 * Opens a pull request from a feature branch to the default branch.
 * Returns the PR URL.
 */
export async function openPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  defaultBranch: string,
  title: string,
  body: string
): Promise<string> {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: defaultBranch,
  })

  return pr.html_url
}

/**
 * Splice new content into a specific line range of a file's text.
 * Lines are 1-indexed. The range [startLine, endLine] is inclusive.
 * Content outside this range is preserved exactly.
 *
 * Exported for testing.
 */
export function spliceLines(
  fullContent: string,
  startLine: number,
  endLine: number,
  newCode: string
): string {
  const lines = fullContent.split('\n')

  // Convert to 0-indexed
  const startIdx = startLine - 1
  const endIdx = endLine // endLine is inclusive, so we remove up to endLine (0-indexed = endLine)

  // Validate bounds
  if (startIdx < 0 || endIdx > lines.length || startIdx >= endIdx) {
    throw new Error(
      `Invalid line range [${startLine}, ${endLine}] for a file with ${lines.length} lines`
    )
  }

  // Split the new code into lines (preserving empty trailing line if present)
  const newLines = newCode.split('\n')

  // Reconstruct: before + new + after
  const before = lines.slice(0, startIdx)
  const after = lines.slice(endIdx)

  return [...before, ...newLines, ...after].join('\n')
}
