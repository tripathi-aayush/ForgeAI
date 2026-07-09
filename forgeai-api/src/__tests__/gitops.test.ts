import { spliceLines } from '../services/gitops'

/**
 * Unit tests for the spliceLines function.
 * Verifies that content outside the edited line range is preserved.
 *
 * Run with: npx tsx src/__tests__/gitops.test.ts
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

console.log('\n✅ All spliceLines tests passed\n')
