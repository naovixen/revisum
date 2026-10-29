// The reveal check must see reveal however a module reaches it, not only through a named import.
// Two more ways a module outside the allow-list could read a secret's value: destructuring reveal
// out of a namespace import, and destructuring it out of a dynamic import(). Each is planted in the
// command-line package, which the allow-list leaves out, in a throw-away copy of the repository.
// Controls: a plain named import is still reported; the same two forms in an allow-listed module
// pass; and the same files destructuring another contracts export pass, so the lint fails for
// reveal, not for the file's shape.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;
const CONTRACTS = '@revisum/contracts';
// An allow-listed module: the CDP driver types a secret into the page.
const ALLOWED_MODULE = 'packages/driver-cdp/src/browser-session.ts';

const NAMESPACE_DESTRUCTURE = (exported: string) => [
  `import * as contracts from '${CONTRACTS}';`,
  `const { ${exported}: picked } = contracts;`,
  '// Hands the picked export on.',
  'export const handedOn = picked;',
];
const DYNAMIC_DESTRUCTURE = (exported: string) => [
  `const { ${exported} } = await import('${CONTRACTS}');`,
  '// Hands the loaded export on.',
  `export const handedOn = ${exported};`,
];

// The lint fails, and some line of its output names both the file and reveal.
function assertRevealReported(relativePath: string, lines: readonly string[]): void {
  const source = [...lines, ''].join('\n');
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  const reported = outcome.failureOutput.split('\n').some((line) => line.includes(fileName) && line.includes('reveal'));
  assert.ok(reported, `the lint failed, but no line names both ${fileName} and reveal:\n${outcome.failureOutput}`);
}

function assertLintPasses(relativePath: string, lines: readonly string[]): void {
  const outcome = scratch.lintWith(relativePath, [...lines, ''].join('\n'));
  assert.equal(outcome.passed, true, `the lint rejected ${relativePath}:\n${outcome.failureOutput}`);
}

test('the lint fails when the command-line package destructures reveal out of a namespace import', { criterion: 'AC-SPEC-04-02', timeout: TIMEOUT }, () => {
  assertRevealReported('packages/cli/src/planted-namespace-reveal.ts', NAMESPACE_DESTRUCTURE('reveal'));
});

test('the lint fails when the command-line package destructures reveal out of a dynamic import', { criterion: 'AC-SPEC-04-02', timeout: TIMEOUT }, () => {
  assertRevealReported('packages/cli/src/planted-dynamic-reveal.ts', DYNAMIC_DESTRUCTURE('reveal'));
});

test('control: the lint still fails when the command-line package imports reveal by name', { criterion: 'AC-SPEC-04-02', timeout: TIMEOUT }, () => {
  assertRevealReported('packages/cli/src/planted-named-reveal.ts', [
    `import { reveal } from '${CONTRACTS}';`,
    '// Hands reveal on.',
    'export const handedOn = reveal;',
  ]);
});

test('counter-example: the same namespace and dynamic forms with another contracts export pass the lint', { criterion: 'AC-SPEC-04-02', timeout: TIMEOUT }, () => {
  assertLintPasses('packages/cli/src/planted-namespace-success.ts', NAMESPACE_DESTRUCTURE('success'));
  assertLintPasses('packages/cli/src/planted-dynamic-success.ts', DYNAMIC_DESTRUCTURE('success'));
});

test('counter-example: an allow-listed module may destructure reveal out of a namespace or a dynamic import', { criterion: 'AC-SPEC-04-02', timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWithEdit(ALLOWED_MODULE, (text) => [
    text.trimEnd(),
    '',
    `import * as contractsAgain from '${CONTRACTS}';`,
    'const { reveal: revealAgain } = contractsAgain;',
    `const { reveal: revealLoaded } = await import('${CONTRACTS}');`,
    '// The same reveal, reached two more ways.',
    'export const revealedTwice = [revealAgain, revealLoaded];',
    '',
  ].join('\n'));
  assert.equal(outcome.passed, true, `the lint rejected an allow-listed module:\n${outcome.failureOutput}`);
});
