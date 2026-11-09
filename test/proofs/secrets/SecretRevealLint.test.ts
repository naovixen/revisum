// Only the modules on the reveal allow-list may import `reveal`, the one way to read a secret's
// value. Each test plants one file in a throw-away copy of the repository and runs the
// repository's lint commands over it. `reveal` lives in contracts, so any package could import it;
// the allow-list (the drivers' input modules, and runner's service caller) is one
// constant. The command-line and report packages are not on it: neither needs a secret's value.
// The counter-example plants the same file importing another contracts export, so the lint is
// shown to fail for `reveal`, not for the file.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RepositoryRuleName } from '../../../tools/repo-rules/RunRepositoryRules.ts';
import { copyRepository, type ScratchRepository } from '../repo-rules/support/ScratchRepository.ts';

const ONLY_THE_RULE = { rule: RepositoryRuleName.SecretReveal };

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;
// The package that exports `reveal`.
const REVEAL_MODULE = '@revisum/contracts';

function assertLintFailsOn(relativePath: string, lines: readonly string[]): void {
  const source = [...lines, ''].join('\n');
  const outcome = scratch.lintWith(relativePath, source, ONLY_THE_RULE);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

test('control: the unchanged copy of the repository passes every lint command', { timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('the lint fails, naming the file, when the command-line package imports reveal', { timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/cli/src/planted-secret-peek.ts', [
    `import { reveal } from '${REVEAL_MODULE}';`,
    '// Prints a secret for debugging.',
    'export const peek = (secret: Parameters<typeof reveal>[0]): string => reveal(secret);',
  ]);
});

test('the lint fails when the report package imports reveal under another name', { timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/report/src/planted-secret-alias.ts', [
    `import { reveal as show } from '${REVEAL_MODULE}';`,
    'export const describe = (secret: Parameters<typeof show>[0]): string => `value: ${show(secret)}`;',
  ]);
});

test('the lint fails when a module outside the allow-list re-exports reveal for others', { timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/cli/src/planted-secret-relay.ts', [
    `export { reveal } from '${REVEAL_MODULE}';`,
  ]);
});

test('counter-example: the same file importing another contracts export passes the lint', { timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWith('packages/cli/src/planted-result-helper.ts', [
    `import { success } from '${REVEAL_MODULE}';`,
    '// Wraps a value as a successful result.',
    'export const wrapped = (text: string) => success(text);',
    '',
  ].join('\n'));
  assert.equal(outcome.passed, true, `the lint rejected a file that does not import reveal:\n${outcome.failureOutput}`);
});
