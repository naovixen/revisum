// The coverage study reports two shares side by side, overall and for each sample: the
// closed-language share, of intents whose plan parses and uses no unsafe feature, and the "1.3 with
// unsafe features" share, of intents whose plan parses under its suite's project with or without
// them. An intent counts toward the second share only if its plan parses, so a feature its suite
// does not enable counts for nothing. The fixture is fixtures/coverage-study/unsafe-features.json:
//   0 shop, original: a closed 1.2 plan;            1 shop, original: a CSS plan (shop enables CSS);
//   2 shop, original: not expressible, no plan;     3 docs, original: a CSS plan (docs enables nothing);
//   4 shop, fresh: a class check (shop enables it); 5 docs, fresh: a closed plan written in 1.3.
// The study report names the second share's fields shareWithUnsafeFeatures and
// shareWithUnsafeFeaturesBySample; only this file reads them.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessCoverage, type CoverageReport } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import { defaultParser, withValue, type JsonRecord } from './plan-examples.ts';

const study = (): JsonRecord => JSON.parse(readFileSync(join(FIXTURES, 'coverage-study', 'unsafe-features.json'), 'utf8'));

function assessed(input: unknown): CoverageReport {
  const outcome = assessCoverage(input, defaultParser());
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
}

// The two shares, overall and by sample, as one comparable value.
const shares = (report: CoverageReport) => ({
  closed: { overall: report.expressibleShare, ...report.expressibleShareBySample },
  withUnsafeFeatures: { overall: report.shareWithUnsafeFeatures, ...report.shareWithUnsafeFeaturesBySample },
});

test('the closed share and the share with unsafe features are reported side by side, overall and per sample', { criterion: 'AC-SPEC-36-19' }, () => {
  assert.deepEqual(shares(assessed(study())), {
    // Intents 0 and 5: a closed plan, whatever version it declares.
    closed: { overall: 2 / 6, original: 1 / 4, fresh: 1 / 2 },
    // Intents 0, 1, 4 and 5: every plan that parses under its suite's project.
    withUnsafeFeatures: { overall: 4 / 6, original: 2 / 4, fresh: 2 / 2 },
  });
});

test('an intent whose plan uses a feature its suite does not enable counts toward neither share, with a new reason', { criterion: 'AC-SPEC-36-19' }, () => {
  const intent = assessed(study()).intents[3];
  assert.ok(intent !== undefined);
  assert.equal(intent.verdict, 'not-expressible');
  assert.ok(intent.reason.includes('unsafe_feature_disabled'), intent.reason);
});

// Metamorphic: moving that intent to the suite that enables CSS makes it count, in the second
// share only; nothing in its plan changes.
test('moving it to the suite that enables CSS counts it toward the share with unsafe features, and not the closed share', { criterion: 'AC-SPEC-36-19' }, () => {
  const moved = shares(assessed(withValue(study(), ['intents', 3, 'suite'], 'example-shop')));
  assert.deepEqual(moved.closed, { overall: 2 / 6, original: 1 / 4, fresh: 1 / 2 });
  assert.deepEqual(moved.withUnsafeFeatures, { overall: 5 / 6, original: 3 / 4, fresh: 2 / 2 });
});

test('turning a suite\'s features off in its project removes its unsafe intents from the second share', { criterion: 'AC-SPEC-36-19' }, () => {
  const closedShop = withValue(study(), ['suites', 'example-shop', 'project', 'unsafeFeatures'], { cssLocators: true });
  // Intent 4's class check now fails to parse; intent 1's CSS locator still does.
  assert.deepEqual(shares(assessed(closedShop)).withUnsafeFeatures, { overall: 3 / 6, original: 2 / 4, fresh: 1 / 2 });
});

test('a plan using unsafe features never raises the closed share, even marked expressible', { criterion: 'AC-SPEC-36-19' }, () => {
  // Counter-example to a study talking the closed share up: dropping every unsafe intent leaves
  // the closed count unchanged, so they were never in it.
  const report = assessed(study());
  const closedOnly = { ...study(), intents: (study()['intents'] as JsonRecord[]).filter((_, index) => ![1, 3, 4].includes(index)) };
  const closedReport = assessed(closedOnly);
  assert.equal(Math.round(report.expressibleShare * 6), Math.round(closedReport.expressibleShare * 3));
});

test('with no unsafe plan in the study, the two shares are equal', { criterion: 'AC-SPEC-36-19' }, () => {
  const closedOnly = { ...study(), intents: (study()['intents'] as JsonRecord[]).filter((_, index) => [0, 2, 5].includes(index)) };
  const { closed, withUnsafeFeatures } = shares(assessed(closedOnly));
  assert.deepEqual(withUnsafeFeatures, closed);
});
