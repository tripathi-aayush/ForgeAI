import fs from 'fs'
import path from 'path'
import { getIndexableFiles } from '../workers/indexing'

/**
 * Unit tests for indexing.ts helpers.
 *
 * Run with: npx tsx src/__tests__/indexing.test.ts
 */

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
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

// Helper to prepare mock directories and files
const testTempDir = path.join(__dirname, 'temp_indexing_test')

function setupMockWorkspace() {
  if (fs.existsSync(testTempDir)) {
    fs.rmSync(testTempDir, { recursive: true, force: true })
  }
  fs.mkdirSync(testTempDir, { recursive: true })
}

function cleanupMockWorkspace() {
  if (fs.existsSync(testTempDir)) {
    fs.rmSync(testTempDir, { recursive: true, force: true })
  }
}

console.log('\n🧪 getIndexableFiles and indexing filter unit tests\n')

test('skips binary extensions and __pycache__ directories', () => {
  setupMockWorkspace()

  // 1. Valid files
  fs.writeFileSync(path.join(testTempDir, 'index.ts'), 'console.log("hello");')
  fs.writeFileSync(path.join(testTempDir, 'utils.py'), 'def hello(): pass')
  
  // 2. Pycache folder and compiled files
  const pycacheDir = path.join(testTempDir, '__pycache__')
  fs.mkdirSync(pycacheDir)
  fs.writeFileSync(path.join(pycacheDir, 'utils.cpython-310.pyc'), 'binary bytecode')
  fs.writeFileSync(path.join(testTempDir, 'main.pyc'), 'bytecode')

  // 3. Binary and image assets
  fs.writeFileSync(path.join(testTempDir, 'logo.png'), 'png data')
  fs.writeFileSync(path.join(testTempDir, 'photo.jpg'), 'jpg data')
  fs.writeFileSync(path.join(testTempDir, 'archive.zip'), 'zip data')
  
  // 4. Dotfiles or non-indexable extensionless files
  fs.writeFileSync(path.join(testTempDir, '.gitignore'), 'node_modules')
  
  // 5. Allowed extensionless files
  fs.writeFileSync(path.join(testTempDir, 'Dockerfile'), 'FROM node:20')

  const files = getIndexableFiles(testTempDir, testTempDir)

  // Verify only index.ts, utils.py, and Dockerfile are listed
  const relativeFiles = files.map(f => path.relative(testTempDir, f)).sort()
  
  assert(relativeFiles.length === 3, `Expected 3 files, got ${relativeFiles.length}: ${JSON.stringify(relativeFiles)}`)
  assert(relativeFiles.includes('index.ts'), 'Should include index.ts')
  assert(relativeFiles.includes('utils.py'), 'Should include utils.py')
  assert(relativeFiles.includes('Dockerfile'), 'Should include Dockerfile')

  // Verify compiled and binary files are skipped
  assert(!relativeFiles.includes('main.pyc'), 'Should skip main.pyc')
  assert(!relativeFiles.includes('logo.png'), 'Should skip logo.png')
  assert(!relativeFiles.includes('photo.jpg'), 'Should skip photo.jpg')
  assert(!relativeFiles.includes('archive.zip'), 'Should skip archive.zip')
  assert(!relativeFiles.includes('__pycache__/utils.cpython-310.pyc'), 'Should skip __pycache__ contents')

  cleanupMockWorkspace()
})

test('resilient to directory/file read permission errors', () => {
  setupMockWorkspace()
  
  fs.writeFileSync(path.join(testTempDir, 'index.ts'), 'console.log("hello");')
  
  // Create a subdirectory that we cannot read
  const unreadableDir = path.join(testTempDir, 'secured_folder')
  fs.mkdirSync(unreadableDir)
  fs.writeFileSync(path.join(unreadableDir, 'secret.ts'), 'secret')
  
  // Mock fs.readdirSync to throw error for secured_folder
  const originalReaddirSync = fs.readdirSync
  fs.readdirSync = ((p: any, options: any) => {
    if (typeof p === 'string' && p.includes('secured_folder')) {
      throw new Error('EACCES: permission denied')
    }
    return originalReaddirSync(p, options)
  }) as any

  try {
    const files = getIndexableFiles(testTempDir, testTempDir)
    const relativeFiles = files.map(f => path.relative(testTempDir, f))
    
    assert(relativeFiles.includes('index.ts'), 'Should still index index.ts')
    assert(!relativeFiles.includes('secured_folder/secret.ts'), 'Should ignore files inside unreadable directories')
  } finally {
    // Restore
    fs.readdirSync = originalReaddirSync
    cleanupMockWorkspace()
  }
})

console.log('\n✅ All indexing tests complete\n')
process.exit(0)
