// run() accepts only a run the policy gate cleared. This is a compile-time guarantee: the guarantee
// file must compile, and each line marked as an expected error must be one, so a parsed plan, a
// hand-made cleared run or a copy of one under another project or standing can never reach a run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { compileFiles } from './scratch-compiler.ts';

const GUARANTEE_FILE = join(REPOSITORY_ROOT, 'test', 'proofs', 'policy-type-guarantees.ts');
const EXPECTED_ERROR_LINE = /^\s*\/\/\s*@ts-expect-error\b/;
const TIMEOUT = 300_000;

// The guarantee file with the expected-error marker above the line holding `marker` removed.
function withoutMarkerBefore(marker: string): string {
  const lines = readFileSync(GUARANTEE_FILE, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(marker));
  assert.ok(index > 0, `the guarantee file has no line with ${marker}`);
  const above = lines.slice(0, index).findLastIndex((line) => EXPECTED_ERROR_LINE.test(line));
  assert.ok(above >= 0, `no expected-error marker above ${marker}`);
  return lines.filter((_, lineIndex) => lineIndex !== above).join('\n');
}

const assertMutantFails = (marker: string): void => {
  const compiled = compileFiles([{ name: 'policy-type-guarantees-mutant.ts', source: withoutMarkerBefore(marker) }]);
  assert.equal(compiled.passed, false, `with the marker above ${marker} removed, the file still compiled`);
  assert.equal(compiled.errors.length, 1, compiled.output);
};

test('the policy guarantee file compiles: a cleared run is a real type, holds a Plan, and runs', { timeout: TIMEOUT }, () => {
  const compiled = compileFiles([GUARANTEE_FILE]);
  assert.equal(compiled.passed, true, compiled.output);
});

test('run() called with a parsed plan the gate has not cleared does not type-check', { timeout: TIMEOUT }, () => {
  assertMutantFails('unclearedPlanRuns');
});

test('a copy of a parsed plan cannot pass as Authorised', { timeout: TIMEOUT }, () => {
  assertMutantFails('forgedAuthorised');
});

test('every expected-error marker in the policy guarantee file is checked by a test above', () => {
  const markers = readFileSync(GUARANTEE_FILE, 'utf8').split(/\r?\n/).filter((line) => EXPECTED_ERROR_LINE.test(line)).length;
  assert.equal(markers, 6);
});

const CLEARED_RUN_MUTANTS: readonly (readonly [string, string])[] = [
  ['an authorised plan alone', 'authorisedPlanRuns'],
  ['a cleared run written by hand', 'handMadeClearedRunRuns'],
  ['a cleared run copied under another project', 'clearedRunUnderAnotherProject'],
  ['a cleared run copied under another standing', 'clearedRunUnderAnotherStanding'],
];

describe('Using the policy guarantee file', () => {
  for (const [handed, marker] of CLEARED_RUN_MUTANTS) {
    describe(`given the line running ${handed} without its expected-error marker`, () => {
      describe('when it is type-checked', () => {
        test('then it should fail on that line alone', { timeout: TIMEOUT }, () => {
          assertMutantFails(marker);
        });
      });
    });
  }
});
