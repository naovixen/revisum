// Only the plan parser makes a Plan. Each test plants one file in a throw-away copy of the
// repository and runs the repository's lint commands over it: a cast to Plan, or a call to the
// engine's brand helper for Plan, anywhere outside the parser fails the lint and names the file.
// Counter-examples show the lint fails for the planted reason, not for everything.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

const TIMEOUT = 300_000;

function assertLintFailsOn(relativePath: string, lines: readonly string[]): void {
  const source = [...lines, ''].join('\n');
  const outcome = scratch.lintWith(relativePath, source);
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}:\n${source}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

function assertLintPassesWith(relativePath: string, lines: readonly string[]): void {
  const outcome = scratch.lintWith(relativePath, [...lines, ''].join('\n'));
  assert.equal(outcome.passed, true, `the lint rejected ${relativePath}:\n${outcome.failureOutput}`);
}

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('the lint fails when engine code outside the parser casts plan data to Plan', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/planted-plan-shortcut.ts', [
    "import type { Plan, PlanData } from '@revisum/contracts';",
    '// Skips the parser for plans the caller says are already safe.',
    'export const trustedPlan = (data: PlanData): Plan => data as Plan;',
  ]);
});

test('the lint fails when engine code beside the parser brands a Plan with the brand helper', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/plan/planted-plan-migration.ts', [
    "import type { PlanData } from '@revisum/contracts';",
    "import { brand } from '../brand.ts';",
    "export const migratedPlan = (data: PlanData) => brand<PlanData, 'Plan'>(data);",
  ]);
});

test('the lint fails when a driver casts parsed JSON through unknown to Plan', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/driver-cdp/src/planted-plan-cast.ts', [
    "import type { Plan } from '@revisum/contracts';",
    'export const loadPlan = (text: string): Plan => JSON.parse(text) as unknown as Plan;',
  ]);
});

test('the lint fails on an angle-bracket cast to Plan in the command-line package', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/cli/src/planted-plan-cast.ts', [
    "import type { Plan } from '@revisum/contracts';",
    'export const asPlan = (value: unknown): Plan => <Plan>value;',
  ]);
});

test('the lint accepts code that receives a Plan and reads it', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/report/src/planted-plan-reader.ts', [
    "import type { Plan } from '@revisum/contracts';",
    'export const stepCount = (plan: Plan): number => plan.steps.length;',
  ]);
});

test('the lint accepts a cast to the unbranded PlanData', { criterion: 'AC-SPEC-01-06', timeout: TIMEOUT }, () => {
  assertLintPassesWith('packages/cli/src/planted-plan-data.ts', [
    "import type { PlanData } from '@revisum/contracts';",
    '// A draft for display only: PlanData carries no promise that it was parsed.',
    'export const draftOf = (value: unknown): PlanData => value as PlanData;',
  ]);
});
