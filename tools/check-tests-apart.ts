// The tests-apart check. A change may touch the test set or the code it judges, never both, so
// that no change can edit a test to make its own code pass.
// On a pull request it reads the changed paths, one per line, from standard input:
//   git diff --name-only origin/main...HEAD | node tools/check-tests-apart.ts
// On a push to main, where commits arrive without a pull request, it checks each commit of the
// pushed range on its own, in the repository of the working folder:
//   node tools/check-tests-apart.ts --commits <from>..<to>
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { execFileSync } from 'node:child_process';
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

const git = (...words: readonly string[]): string => execFileSync('git', words, { encoding: 'utf8', ['maxBuffer']: 256 * 1024 * 1024 });

// The paths one commit changes against its first parent (every path, for a root commit). Renames
// are listed as a deletion and an addition, so moving a file into or out of the test set counts
// on both sides.
function changedPaths(commit: string): string[] {
  const listed = git('diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', '--first-parent', '-z', commit);
  return listed.split('\0').filter((path) => path !== '');
}

// Every commit of the range that mixes the two, oldest first.
export function mixedCommits(range: string): { readonly commit: string; readonly result: TestsApartResult }[] {
  const commits = git('rev-list', '--reverse', range).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return commits
    .map((commit) => ({ commit, result: checkTestsApart(changedPaths(commit)) }))
    .filter(({ result }) => !result.passed);
}

function report(label: string, result: TestsApartResult): void {
  console.error(`tests-apart failed: ${label} touches both the test set and other files.`);
  console.error(`Test set:\n  ${result.testSetPaths.join('\n  ')}`);
  console.error(`Other:\n  ${result.otherPaths.join('\n  ')}`);
}

function main(words: readonly string[]): number {
  const flag = words.indexOf('--commits');
  if (flag !== -1) {
    const range = words[flag + 1];
    if (range === undefined || !range.includes('..')) {
      console.error('usage: node tools/check-tests-apart.ts --commits <from>..<to>');
      return 2;
    }
    const mixed = mixedCommits(range);
    for (const { commit, result } of mixed) report(`commit ${commit.slice(0, 12)}`, result);
    console.log(mixed.length === 0 ? `tests-apart passed: no commit in ${range} mixes the test set and other files` : `tests-apart failed: ${mixed.length} commit(s) mix them`);
    return mixed.length === 0 ? 0 : 1;
  }
  const result = checkTestsApart(readFileSync(0, 'utf8').split('\n'));
  if (result.passed) {
    console.log(`tests-apart passed: ${result.testSetPaths.length} test-set path(s), ${result.otherPaths.length} other path(s)`);
    return 0;
  }
  report('this change', result);
  console.error('Split it into two changes.');
  return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
