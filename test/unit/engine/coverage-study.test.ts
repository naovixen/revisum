// The coverage study records, for each sampled test intent, whether the plan language can express
// it and why, and reports the expressible share. A claim of "expressible" is only believed when the
// intent's plan parses, so the share cannot be talked up. A malformed study file is rejected.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessCoverage, planParser } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import { REMOVE, testProject, withValue, type JsonRecord } from './plan-examples.ts';

const parsePlan = planParser(testProject());
const study = (): JsonRecord => JSON.parse(readFileSync(join(FIXTURES, 'coverage-study', 'intents.json'), 'utf8'));

function assessed(input: unknown) {
  const outcome = assessCoverage(input, parsePlan);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
}

const rejectedWith = (input: unknown): string[] => {
  const outcome = assessCoverage(input, parsePlan);
  assert.equal(outcome.ok, false, 'the study file was accepted');
  return outcome.ok ? [] : [...outcome.error].map((error) => `${error.code} ${error.path}`);
};

// ---- Verdicts and reasons -----------------------------------------------------------------------

test('records every intent with its suite, source, test name, verdict and reason, in file order', { criterion: 'AC-SPEC-01-01' }, () => {
  const report = assessed(study());
  assert.deepEqual(report.intents.map((intent) => [intent.suite, intent.testName, intent.verdict]), [
    ['example-shop', 'shows a welcome message after sign-up', 'expressible'],
    ['example-shop', 'removing the last item empties the cart', 'expressible'],
    ['example-docs', 'search opens the first result', 'expressible'],
    ['example-docs', 'theme toggle is remembered', 'not-expressible'],
    ['example-docs', 'downloads the offline bundle', 'not-expressible'],
    ['example-shop', 'product page matches the stored screenshot', 'not-expressible'],
  ]);
  assert.deepEqual(report.intents.map((intent) => intent.sourceUrl), (study()['intents'] as JsonRecord[]).map((intent) => intent['sourceUrl']));
});

test('keeps the recorded reason of every intent whose verdict stands', { criterion: 'AC-SPEC-01-01' }, () => {
  const report = assessed(study());
  const reasons = report.intents.map((intent) => intent.reason);
  assert.deepEqual([reasons[0], reasons[1], reasons[2], reasons[4], reasons[5]], [
    'Fill, click and a text check on a status region',
    'A click and an absent-element check',
    'Fill, press Enter and a page path check',
    'Downloads are not plan steps until phase 2',
    'Pixel comparison against a baseline is not an assertion kind',
  ]);
});

test('an intent marked expressible whose plan does not parse counts as not expressible, with a new reason', { criterion: 'AC-SPEC-01-01' }, () => {
  const theme = assessed(study()).intents[3];
  assert.ok(theme !== undefined);
  assert.equal(theme.verdict, 'not-expressible');
  assert.equal(typeof theme.reason, 'string');
  assert.ok(theme.reason.length > 0, 'the reason is recorded');
  assert.notEqual(theme.reason, 'Wrongly marked: the plan needs a CSS selector, which the language does not have', 'the claimed reason is not kept for an overturned verdict');
});

test('every plan of an intent marked expressible goes through the plan parser', { criterion: 'AC-SPEC-01-01' }, () => {
  let calls = 0;
  const counting = (input: unknown) => { calls++; return parsePlan(input); };
  const outcome = assessCoverage(study(), counting);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(calls, 4, 'one parse per intent marked expressible');
});

// ---- The expressible share ----------------------------------------------------------------------

test('reports the expressible share exactly: 3 of 6 intents', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.equal(assessed(study()).expressibleShare, 0.5);
});

test('fixing the overturned plan raises the share to exactly 4 of 6', { criterion: 'AC-SPEC-01-01' }, () => {
  const fixed = withValue(study(), ['intents', 3, 'plan', 'steps', 1, 'locator'], { by: 'role', role: 'switch', name: 'Dark theme' });
  const report = assessed(fixed);
  assert.equal(report.intents[3]?.verdict, 'expressible');
  assert.equal(report.expressibleShare, 4 / 6);
});

test('a study of only expressible intents has a share of exactly 1, and of none, exactly 0', { criterion: 'AC-SPEC-01-01' }, () => {
  const intents = study()['intents'] as JsonRecord[];
  assert.equal(assessed({ intents: intents.slice(0, 3) }).expressibleShare, 1);
  assert.equal(assessed({ intents: intents.slice(4) }).expressibleShare, 0);
});

// ---- Malformed study files ----------------------------------------------------------------------

test('rejects a study file that is not an object', { criterion: 'AC-SPEC-01-01' }, () => {
  for (const input of [null, 'six intents', [], 42]) assert.ok(rejectedWith(input).length > 0, `accepted ${JSON.stringify(input)}`);
});

test('rejects a study with no intents as empty', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith({ intents: [] }), ['empty $.intents']);
});

test('rejects an intent with no verdict, naming the missing field', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 4, 'verdict'], REMOVE)), ['missing_field $.intents[4].verdict']);
});

test('rejects an intent with no reason, naming the missing field', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 0, 'reason'], REMOVE)), ['missing_field $.intents[0].reason']);
});

test('rejects a verdict outside the closed set', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 1, 'verdict'], 'mostly')), ['unknown_value $.intents[1].verdict']);
});

test('rejects an unknown key on an intent', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 2, 'score'], 0.9)), ['unknown_field $.intents[2].score']);
});

test('rejects an intent marked expressible that carries no plan', { criterion: 'AC-SPEC-01-01' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 0, 'plan'], REMOVE)), ['missing_field $.intents[0].plan']);
});
