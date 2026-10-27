// The tests-apart check. A pull request may change the test set or the code it judges, never
// both, so that no change can edit a test to make its own code pass.
// Reads the changed paths, one per line, from standard input:
//   git diff --name-only origin/main...HEAD | node tools/check-tests-apart.ts
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readFileSync } from 'node:fs';
import { matchesAny } from './glob.ts';

// Tests, proofs, fixtures and golden files; everything else is code under test.
export const TEST_SET = ['test/**', 'proofs/**', 'fixtures/**', 'golden/**'] as const;

export type TestsApartResult = {
  readonly passed: boolean;
  readonly testSetPaths: readonly string[];
  readonly otherPaths: readonly string[];
};

export function checkTestsApart(changedPaths: readonly string[]): TestsApartResult {
  const paths = changedPaths.map((path) => path.trim()).filter((path) => path !== '');
  const testSetPaths = paths.filter((path) => matchesAny(path, TEST_SET));
  const otherPaths = paths.filter((path) => !matchesAny(path, TEST_SET));
  return { passed: testSetPaths.length === 0 || otherPaths.length === 0, testSetPaths, otherPaths };
}

if (import.meta.main) {
  const result = checkTestsApart(readFileSync(0, 'utf8').split('\n'));
  if (result.passed) {
    console.log(`tests-apart passed: ${result.testSetPaths.length} test-set path(s), ${result.otherPaths.length} other path(s)`);
  } else {
    console.error('tests-apart failed: this change touches both the test set and other files. Split it into two pull requests.');
    console.error(`Test set:\n  ${result.testSetPaths.join('\n  ')}`);
    console.error(`Other:\n  ${result.otherPaths.join('\n  ')}`);
    process.exitCode = 1;
  }
}
