// Criterion ids are data. One may appear in source only as a test's `criterion` value, and that
// value must name a criterion that exists in docs/specs/. Each test plants one file in a throw-away
// copy of the repository and runs the lint commands over it. The planted ids are built at run
// time, so this file itself holds none outside test metadata.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { after, before, test } from 'node:test';
import { criterionId } from '../support/criterion-ids.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, lintWithEdits } from './scratch-edits.ts';

const TIMEOUT = 300_000;
const EXISTING = criterionId(1, 3);
const MISSING = criterionId(99, 1);

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const plantedTest = (id: string): string => [
  "import { test } from 'node:test';",
  `test('rejects unknown steps', { criterion: '${id}' }, () => {});`,
  '',
].join('\n');

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

test('the lint fails on a criterion id in a code string', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { 'packages/engine/src/planted-label.ts': `export const stepLabel = '${EXISTING}';\n` });
  assertLintFails(outcome, ['planted-label.ts']);
});

test('the lint fails on a criterion id in a comment', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'packages/engine/src/planted-comment.ts': `// Rejects unknown steps, as ${EXISTING} asks.\nexport const rejectsUnknownSteps = true;\n`,
  });
  assertLintFails(outcome, ['planted-comment.ts']);
});

test('the lint fails on a test whose criterion names no criterion in docs/specs', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { 'test/proofs/planted-criterion.test.ts': plantedTest(MISSING) });
  assertLintFails(outcome, ['planted-criterion.test.ts', MISSING]);
});

test('counter-example: a test whose criterion exists in docs/specs passes', { criterion: 'AC-SPEC-00-15', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, { 'test/proofs/planted-criterion.test.ts': plantedTest(EXISTING) }));
});
