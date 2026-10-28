// The coverage study with a project per suite. intents.json may give each suite a project, with
// the declarations plan language 1.2 adds; each intent's plan is parsed with its own suite's
// project, so a secret or email domain only one suite declares only parses there. Each intent
// belongs to a sample, the original 100 or the fresh one drawn after the 1.2 grammar froze, and
// the study reports the expressible share of each sample and of both together. The fixture is
// fixtures/coverage-study/per-suite-projects.json, never the real study file.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessCoverage } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import { defaultParser, withValue, type JsonRecord } from './plan-examples.ts';

// The parser for intents whose suite gives no project: the shared test project, which declares
// neither the shop's secret nor its email domain.
const parsePlan = defaultParser();
const study = (): JsonRecord => JSON.parse(readFileSync(join(FIXTURES, 'coverage-study', 'per-suite-projects.json'), 'utf8'));

function assessed(input: unknown) {
  const outcome = assessCoverage(input, parsePlan);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
}

const verdicts = (input: unknown): string[] => assessed(input).intents.map((intent) => intent.verdict);

test('each intent\'s plan is parsed with its own suite\'s project', { criterion: 'AC-SPEC-30-18' }, () => {
  assert.deepEqual(verdicts(study()), ['expressible', 'not-expressible', 'expressible', 'expressible', 'not-expressible', 'not-expressible']);
});

test('a secret only the shop suite declares parses for a shop intent and not for a docs intent', { criterion: 'AC-SPEC-30-18' }, () => {
  const report = assessed(study());
  assert.equal(report.intents[0]?.verdict, 'expressible');
  assert.equal(report.intents[1]?.verdict, 'not-expressible');
  assert.notEqual(report.intents[1]?.reason, 'Uses the shop\'s secret, which the docs project does not declare', 'an overturned verdict gets a new reason');
});

test('an email domain only the shop suite declares parses for a shop intent and not for a docs intent', { criterion: 'AC-SPEC-30-18' }, () => {
  const report = assessed(study());
  assert.equal(report.intents[3]?.verdict, 'expressible');
  assert.equal(report.intents[4]?.verdict, 'not-expressible');
});

// Metamorphic: moving the docs intents to the shop suite, whose project declares what they use,
// makes them expressible; nothing in the plans changes.
test('moving an intent to the suite that declares what its plan uses makes it expressible', { criterion: 'AC-SPEC-30-18' }, () => {
  let moved = withValue(study(), ['intents', 1, 'suite'], 'example-shop');
  moved = withValue(moved, ['intents', 4, 'suite'], 'example-shop');
  assert.deepEqual(verdicts(moved), ['expressible', 'expressible', 'expressible', 'expressible', 'expressible', 'not-expressible']);
});

test('removing a declaration from a suite\'s project overturns that suite\'s intent that relies on it', { criterion: 'AC-SPEC-30-18' }, () => {
  const withoutSecret = withValue(study(), ['suites', 'example-shop', 'project', 'secretNames'], []);
  assert.equal(assessed(withoutSecret).intents[0]?.verdict, 'not-expressible');
});

// ---- Shares per sample --------------------------------------------------------------------------

test('the report gives the expressible share of the original sample, of the fresh sample and of both', { criterion: 'AC-SPEC-30-18' }, () => {
  const report = assessed(study());
  assert.deepEqual(report.expressibleShareBySample, { original: 2 / 3, fresh: 1 / 3 });
  assert.equal(report.expressibleShare, 3 / 6);
});

test('fixing the fresh docs intent raises only the fresh share and the combined share', { criterion: 'AC-SPEC-30-18' }, () => {
  const report = assessed(withValue(study(), ['intents', 4, 'suite'], 'example-shop'));
  assert.deepEqual(report.expressibleShareBySample, { original: 2 / 3, fresh: 2 / 3 });
  assert.equal(report.expressibleShare, 4 / 6);
});

test('moving an intent from the original sample to the fresh one moves it between the per-sample shares', { criterion: 'AC-SPEC-30-18' }, () => {
  const report = assessed(withValue(study(), ['intents', 2, 'sample'], 'fresh'));
  assert.deepEqual(report.expressibleShareBySample, { original: 1 / 2, fresh: 2 / 4 });
  assert.equal(report.expressibleShare, 3 / 6);
});

// ---- Malformed study files ----------------------------------------------------------------------

const rejectedWith = (input: unknown): string[] => {
  const outcome = assessCoverage(input, parsePlan);
  assert.equal(outcome.ok, false, 'the study file was accepted');
  return outcome.ok ? [] : outcome.error.map((error) => `${error.code} ${error.path}`);
};

test('a sample other than original or fresh is refused with unknown_value', { criterion: 'AC-SPEC-30-18' }, () => {
  assert.deepEqual(rejectedWith(withValue(study(), ['intents', 2, 'sample'], 'later')), ['unknown_value $.intents[2].sample']);
});

test('a suite project the project parser refuses makes the study file rejected, at that project', { criterion: 'AC-SPEC-30-18' }, () => {
  const errors = rejectedWith(withValue(study(), ['suites', 'example-docs', 'project', 'origins'], ['not a url']));
  assert.ok(errors.length > 0 && errors.every((error) => error.includes('$.suites.example-docs.project')), JSON.stringify(errors));
});
