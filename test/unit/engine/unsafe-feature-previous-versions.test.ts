// Plan language 1.3 adds the unsafe features and nothing else, and only a plan declaring "1.3" can
// hold one. A plan declaring "1.2" or "1.1" that uses a 1.3 feature is refused with exactly the
// code and path that version's parser gives, even when the project enables the feature. Each
// expected refusal below was recorded from the 1.2 engine itself, before any 1.3 code existed, on
// the plans built from unsafe-feature-steps.ts.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedBy, parserEnabling, rejection } from './unsafe-feature-examples.ts';
import {
  ALL_FEATURES_PLAN, ATTRIBUTE_CHECK, CART_COUNT_CHECK, CLASS_CHECK, CSS_CHECK, FEATURES, INLINE_READ, NO_ATTRIBUTE_CHECK, NO_CLASS_CHECK,
  OPEN_CART, ORDER_COUNT_CHECK, READ_CART, REMEMBER_ATTRIBUTE, SEED_ORDERS, STYLE_CHECK, UNSAFE_VERSION, XPATH_CHECK,
  css, planIn, type JsonRecord,
} from './unsafe-feature-steps.ts';

// Every feature on: the version a plan declares is what refuses it here, not the project.
const parseAll = parserEnabling(FEATURES);

type PreviousCase = {
  readonly construct: string;
  readonly plan: (version: string) => JsonRecord;
  // What the 1.2 and the 1.1 parser returned for the plan, as "code path" lines.
  readonly errors: { readonly '1.2': readonly string[]; readonly '1.1': readonly string[] };
};

const withStep = (step: JsonRecord) => (version: string): JsonRecord => planIn(version, [OPEN_CART, step]);

const PREVIOUS_CASES: readonly PreviousCase[] = [
  { construct: 'a CSS locator', plan: withStep(CSS_CHECK), errors: { '1.2': ['unknown_value $.steps[1].locator.by'], '1.1': ['unknown_value $.steps[1].locator.by'] } },
  {
    construct: 'a CSS locator with hasText and inside',
    plan: withStep({ type: 'click', locator: css('button', { hasText: 'Add', inside: css('li.product') }) }),
    errors: { '1.2': ['unknown_value $.steps[1].locator.by'], '1.1': ['unknown_value $.steps[1].locator.by'] },
  },
  { construct: 'an XPath locator', plan: withStep(XPATH_CHECK), errors: { '1.2': ['unknown_value $.steps[1].locator.by'], '1.1': ['unknown_value $.steps[1].locator.by'] } },
  {
    construct: 'a CSS frame holding an XPath check',
    plan: withStep({ type: 'frame', locator: css('iframe.editor-canvas'), steps: [XPATH_CHECK] }),
    errors: {
      '1.2': ['unknown_value $.steps[1].locator.by', 'unknown_value $.steps[1].steps[0].locator.by'],
      '1.1': ['unknown_value $.steps[1].locator.by', 'unknown_value $.steps[1].steps[0].locator.by'],
    },
  },
  { construct: 'a hasClass check', plan: withStep(CLASS_CHECK), errors: { '1.2': ['unknown_value $.steps[1].assert.kind'], '1.1': ['unknown_value $.steps[1].assert.kind'] } },
  { construct: 'a lacksClass check', plan: withStep(NO_CLASS_CHECK), errors: { '1.2': ['unknown_value $.steps[1].assert.kind'], '1.1': ['unknown_value $.steps[1].assert.kind'] } },
  { construct: 'a computedStyleEquals check', plan: withStep(STYLE_CHECK), errors: { '1.2': ['unknown_value $.steps[1].assert.kind'], '1.1': ['unknown_value $.steps[1].assert.kind'] } },
  { construct: 'an attributeEquals check', plan: withStep(ATTRIBUTE_CHECK), errors: { '1.2': ['unknown_value $.steps[1].assert.kind'], '1.1': ['unknown_value $.steps[1].assert.kind'] } },
  { construct: 'an attributeAbsent check', plan: withStep(NO_ATTRIBUTE_CHECK), errors: { '1.2': ['unknown_value $.steps[1].assert.kind'], '1.1': ['unknown_value $.steps[1].assert.kind'] } },
  { construct: 'a remember from an attribute', plan: withStep(REMEMBER_ATTRIBUTE), errors: { '1.2': ['unknown_field $.steps[1].from.attribute'], '1.1': ['unknown_step $.steps[1].type'] } },
  { construct: 'a named page script', plan: withStep(READ_CART), errors: { '1.2': ['unknown_step $.steps[1].type'], '1.1': ['unknown_step $.steps[1].type'] } },
  { construct: 'a page-script check', plan: withStep(CART_COUNT_CHECK), errors: { '1.2': ['unknown_step $.steps[1].type'], '1.1': ['unknown_step $.steps[1].type'] } },
  { construct: 'an inline page script', plan: withStep(INLINE_READ), errors: { '1.2': ['unknown_step $.steps[1].type'], '1.1': ['unknown_step $.steps[1].type'] } },
  { construct: 'a database step', plan: withStep(SEED_ORDERS), errors: { '1.2': ['unknown_step $.steps[1].type'], '1.1': ['unknown_step $.steps[1].type'] } },
  { construct: 'a database check', plan: withStep(ORDER_COUNT_CHECK), errors: { '1.2': ['unknown_step $.steps[1].type'], '1.1': ['unknown_step $.steps[1].type'] } },
  {
    construct: 'a database step in cleanup',
    plan: (version) => planIn(version, [OPEN_CART], { cleanup: [SEED_ORDERS] }),
    errors: { '1.2': ['unknown_step $.cleanup[0].type'], '1.1': ['unknown_field $.cleanup'] },
  },
  {
    construct: 'all six features at once',
    plan: (version) => ({ ...ALL_FEATURES_PLAN(), version }),
    errors: {
      '1.2': [
        'unknown_value $.steps[1].locator.by', 'unknown_value $.steps[2].locator.by', 'unknown_value $.steps[3].assert.kind',
        'unknown_field $.steps[4].from.attribute', 'unknown_step $.steps[5].type', 'unknown_step $.steps[6].type', 'unknown_step $.steps[7].type',
        'unknown_value $.steps[8].locator.by', 'unknown_step $.steps[8].steps[0].type', 'unknown_step $.cleanup[0].type',
      ],
      '1.1': ['unknown_field $.cleanup'],
    },
  },
];

for (const previous of PREVIOUS_CASES) {
  for (const version of ['1.2', '1.1'] as const) {
    test(`a plan declaring "${version}" that uses ${previous.construct} is refused as the ${version} parser refused it, with every feature enabled`, { criterion: 'AC-SPEC-36-02' }, () => {
      assert.deepEqual(rejection(parseAll, previous.plan(version)), previous.errors[version]);
    });
  }
}

test('none of those refusals is unsafe_feature_disabled: below 1.3 the features do not exist', { criterion: 'AC-SPEC-36-02' }, () => {
  for (const previous of PREVIOUS_CASES) {
    for (const version of ['1.2', '1.1'] as const) {
      assert.ok(!rejection(parseAll, previous.plan(version)).some((line) => line.startsWith('unsafe_feature_disabled')), `${previous.construct} in ${version}`);
    }
  }
});

test('a project with no feature enabled refuses those plans with the same codes and paths', { criterion: 'AC-SPEC-36-02' }, () => {
  // Metamorphic: enabling the features must not change how a 1.2 or 1.1 plan is read.
  const parseNone = parserEnabling([]);
  for (const previous of PREVIOUS_CASES) {
    for (const version of ['1.2', '1.1'] as const) {
      assert.deepEqual(rejection(parseNone, previous.plan(version)), rejection(parseAll, previous.plan(version)), `${previous.construct} in ${version}`);
    }
  }
});

// Counter-example: each of those plans, declared as "1.3", parses, so the declared version alone
// refused them above.
test('declared as "1.3", every one of those plans parses under the project that enables every feature', { criterion: 'AC-SPEC-36-02' }, () => {
  for (const previous of PREVIOUS_CASES) {
    acceptedBy(parseAll, previous.plan(UNSAFE_VERSION));
  }
});
