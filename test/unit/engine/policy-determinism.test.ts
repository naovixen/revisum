// The policy gate is a pure function: the same plan, project and targets always give the same
// decision, and the same step, element, dialog text and locale always give the same verdict. Two
// gates built from the same project file agree, and deciding changes none of the inputs.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '@revisum/engine';
import {
  DESTRUCTIVE_PATH, ENGLISH, FRENCH, JAPANESE, NO_ELEMENT, OPEN_ACCOUNT_PAGE, PRODUCTION_ORIGIN,
  acceptDialog, click, comparable, decideOn, element, label, localeOf, navigate, parsedPlan, planOf, press, role, stepAt,
  targetsOf, testGate, testId,
} from './policy-examples.ts';

// One plan per outcome the static check can reach, so every branch is decided twice.
const PLANS: readonly (readonly [string, readonly unknown[], readonly string[]])[] = [
  ['an allowed plan', [OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))], [ENGLISH]],
  ['an irreversible click', [OPEN_ACCOUNT_PAGE, click(role('button', 'Delete account'))], [ENGLISH]],
  ['a production origin', [OPEN_ACCOUNT_PAGE, navigate(`${PRODUCTION_ORIGIN}/orders`)], [ENGLISH]],
  ['a destructive URL', [OPEN_ACCOUNT_PAGE, navigate(DESTRUCTIVE_PATH)], [ENGLISH]],
  ['a French irreversible click', [OPEN_ACCOUNT_PAGE, click(role('button', 'Modifier le profil')), click(role('button', 'Supprimer le compte'))], [FRENCH]],
  ['a locale with no pattern set', [OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))], [JAPANESE]],
];

for (const [what, steps, targets] of PLANS) {
  test(`deciding ${what} twice with the same inputs gives the same decision`, { criterion: 'AC-SPEC-03-06' }, async () => {
    const tested = await testGate();
    const plan = parsedPlan(planOf(steps, targets));
    const first = decideOn(tested, plan);
    const second = decideOn(tested, plan);
    assert.deepEqual(comparable(second), comparable(first));
    if (first.kind === 'allow' && second.kind === 'allow') assert.equal(canonicalJson(second.plan), canonicalJson(first.plan));
  });

  test(`two gates built from the same project file decide ${what} alike`, { criterion: 'AC-SPEC-03-06' }, async () => {
    const one = await testGate();
    const other = await testGate();
    const plan = parsedPlan(planOf(steps, targets));
    assert.deepEqual(
      comparable(decideOn(other, plan)),
      comparable(decideOn(one, plan)),
    );
  });

  test(`deciding ${what} leaves the plan, project and targets as they were`, { criterion: 'AC-SPEC-03-06' }, async () => {
    const { gate, project } = await testGate();
    const plan = parsedPlan(planOf(steps, targets));
    const chosen = targetsOf(project, plan);
    const before = canonicalJson({ plan, project, chosen });
    gate.decide(plan, chosen);
    assert.equal(canonicalJson({ plan, project, chosen }), before);
  });
}

// One action per outcome the runtime guard can reach.
const ACTIONS = [
  { what: 'an allowed click', steps: [OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))], index: 1, element: element({ role: 'button', name: 'Download your data' }), dialogText: null },
  { what: 'an irreversible click', steps: [OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))], index: 1, element: element({ role: 'button', name: 'Delete account' }), dialogText: null },
  { what: 'an irreversible submit', steps: [OPEN_ACCOUNT_PAGE, press(label('Password'), 'Enter')], index: 1, element: element({ role: 'textbox', name: 'Password', formSubmitName: 'Delete account' }), dialogText: null },
  { what: 'an irreversible dialog', steps: [OPEN_ACCOUNT_PAGE, acceptDialog], index: 1, element: NO_ELEMENT, dialogText: 'Revoke all API keys?' },
  { what: 'an unnamed control', steps: [OPEN_ACCOUNT_PAGE, click(testId('icon-only'))], index: 1, element: element({ role: 'button', name: null }), dialogText: null },
] as const;

for (const action of ACTIONS) {
  test(`guarding ${action.what} twice with the same inputs gives the same verdict`, { criterion: 'AC-SPEC-03-06' }, async () => {
    const { gate, project } = await testGate();
    const plan = parsedPlan(planOf(action.steps));
    const step = stepAt(plan, action.index);
    const locale = localeOf(project, ENGLISH);
    const first = gate.guardAction(step, action.index, action.element, action.dialogText, locale);
    const second = gate.guardAction(step, action.index, action.element, action.dialogText, locale);
    assert.deepEqual(second, first);
  });
}

test('the decisions above are not all alike, so agreement between two calls is not vacuous', { criterion: 'AC-SPEC-03-06' }, async () => {
  const tested = await testGate();
  const kinds = new Set(PLANS.map(([, steps, targets]) => {
    const plan = parsedPlan(planOf(steps, targets));
    return JSON.stringify(comparable(decideOn(tested, plan)));
  }));
  assert.equal(kinds.size, PLANS.length, [...kinds].join('\n'));
});
