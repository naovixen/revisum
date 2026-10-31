// DOM checks in a real browser on both drivers (fixtures/unsafe-features-app/dom-checks.html). The
// page holds two twins that differ only in what the checks read: one class, one computed colour,
// one attribute value and one attribute's presence. Each check passes on its matching twin and
// fails on its mismatched twin; the same check, with only the twin swapped, flips its outcome, so
// neither a check that always passes nor one that always fails can satisfy both.
// The elements are found by test id, and once more by a CSS locator inside a twin, so the checks
// are shown to read the element the locator resolves.
// The remembered attribute's leak scan is in test/proofs/unsafe-page-leak-scan.test.ts.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  ADAPTER_OF, BOTH_TARGETS, check, css, listedFeatures, navigate, outcomes, reference, rememberAttribute, testId, unsafePageDrivers, unsafePageHarness,
  type JsonRecord, type UnsafePageHarness,
} from './unsafe-page-support.ts';

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

type Twin = 'matching' | 'mismatched';
type DomCheck = { readonly name: string; readonly element: (twin: Twin) => JsonRecord; readonly assertion: JsonRecord };

const badge = (twin: Twin): JsonRecord => testId(`${twin}-badge`);
const DOM_CHECKS: readonly DomCheck[] = [
  { name: 'hasClass is-active', element: badge, assertion: { kind: 'hasClass', value: 'is-active' } },
  { name: 'lacksClass is-empty', element: badge, assertion: { kind: 'lacksClass', value: 'is-empty' } },
  { name: 'computedStyleEquals background-color', element: badge, assertion: { kind: 'computedStyleEquals', property: 'background-color', value: 'rgb(220, 38, 38)' } },
  { name: 'attributeEquals aria-sort', element: (twin) => testId(`${twin}-sort`), assertion: { kind: 'attributeEquals', name: 'aria-sort', value: 'ascending' } },
  { name: 'attributeAbsent disabled', element: (twin) => testId(`${twin}-checkout`), assertion: { kind: 'attributeAbsent', name: 'disabled' } },
];

for (const targetId of BOTH_TARGETS) {
  describe(`DOM checks on twin elements: ${targetId}`, () => {
    for (const domCheck of DOM_CHECKS) {
      test(`${domCheck.name} passes on the matching twin and fails on the mismatched twin`, { criterion: 'AC-SPEC-36-07' }, async () => {
        const matching = await harness.runSteps(targetId, [navigate('/dom-checks.html'), check(domCheck.element('matching'), domCheck.assertion, 'dom.matching')]);
        assert.equal(matching.result.state, 'Passed', JSON.stringify(matching.result.steps));
        const mismatched = await harness.runSteps(targetId, [navigate('/dom-checks.html'), check(domCheck.element('mismatched'), domCheck.assertion, 'dom.mismatched')]);
        assert.equal(mismatched.result.state, 'Failed', JSON.stringify(mismatched.result.steps));
        assert.deepEqual(outcomes(mismatched.result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']]);
      });
    }

    test('the class and colour checks read the element a CSS locator inside each twin resolves', { criterion: 'AC-SPEC-36-07' }, async () => {
      const inTwin = (twin: Twin): JsonRecord => css('.badge', { inside: testId(`${twin}-twin`) });
      const matching = await harness.runSteps(targetId, [
        navigate('/dom-checks.html'),
        check(inTwin('matching'), { kind: 'hasClass', value: 'is-active' }, 'dom.css-class'),
        check(inTwin('matching'), { kind: 'computedStyleEquals', property: 'background-color', value: 'rgb(220, 38, 38)' }, 'dom.css-colour'),
      ]);
      assert.equal(matching.result.state, 'Passed', JSON.stringify(matching.result.steps));
      const mismatched = await harness.runSteps(targetId, [
        navigate('/dom-checks.html'),
        check(inTwin('mismatched'), { kind: 'hasClass', value: 'is-active' }, 'dom.css-class'),
      ]);
      assert.deepEqual(outcomes(mismatched.result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']], JSON.stringify(mismatched.result.steps));
    });

    // A remember from an attribute also needs rememberedValues, which the Playwright fallback does not declare.
    const remembers = listedFeatures(unsafePageDrivers().get(ADAPTER_OF[targetId] ?? '')).includes('rememberedValues');
    test('an attribute remembered from one twin passes attributeEquals on that twin and fails it on the other', { criterion: 'AC-SPEC-36-07', skip: !remembers }, async () => {
      const ran = await harness.runSteps(targetId, [
        navigate('/dom-checks.html'),
        rememberAttribute('sortOrder', testId('matching-sort'), 'aria-sort'),
        check(testId('matching-sort'), { kind: 'attributeEquals', name: 'aria-sort', value: reference('sortOrder') }, 'dom.remembered-matches'),
        check(testId('mismatched-sort'), { kind: 'attributeEquals', name: 'aria-sort', value: reference('sortOrder') }, 'dom.remembered-differs'),
      ]);
      assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'failed', 'assertion-failed']], JSON.stringify(ran.result.steps));
    });
  });
}
