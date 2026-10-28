// The policy gate's runtime guard. The driver calls it before every action with the element the
// locator resolved to, so it sees what the static check cannot: the name behind a test id, the
// form a key press would submit, the text of a dialog, where a link leads, and controls with no
// accessible name.
// It is tested here through its own interface; SPEC-06 wires it into the CDP driver.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedElement } from '@revisum/engine';
import {
  ALLOWED, ALLOWED_UNNAMED_TEST_ID, DESTRUCTIVE_PATH, ENGLISH, FRENCH, FRENCH_IN_FRANCE, JAPANESE, NO_ELEMENT, OPEN_ACCOUNT_PAGE, ORIGIN,
  acceptDialog, click, denied, dismissDialog, element, label, localeOf, parsedPlan, planOf, press, role,
  stepAt, testGate, testId, withPolicy, type JsonRecord,
} from './policy-examples.ts';

type GuardCall = {
  readonly steps: readonly unknown[];
  readonly stepIndex: number;
  readonly element: ResolvedElement;
  readonly dialogText?: string;
  readonly targetId?: string;
  readonly projectInput?: JsonRecord;
};

// Parses a plan of `steps`, then guards its step `stepIndex` as the driver would just before acting.
async function guard(call: GuardCall) {
  const targetId = call.targetId ?? ENGLISH;
  const { gate, project } = await testGate(call.projectInput);
  const plan = parsedPlan(planOf(call.steps, [targetId]), call.projectInput);
  return gate.guardAction(stepAt(plan, call.stepIndex), call.stepIndex, call.element, call.dialogText ?? null, localeOf(project, targetId));
}

// ---- Irreversible clicks the static check cannot see --------------------------------------------

const DANGER_ZONE = testId('danger-zone-action');

test('a click on a test id that resolves to a button named "Delete account" is denied as irreversible-action with its step index', { criterion: 'AC-SPEC-03-01' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Delete account' }),
  });
  assert.deepEqual(verdict, denied('irreversible-action', 1));
});

test('the same click is allowed when the test id resolves to a button named "Download your data"', { criterion: 'AC-SPEC-03-01' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Download your data' }),
  });
  assert.deepEqual(verdict, ALLOWED);
});

// ---- Key presses that submit an irreversible form -----------------------------------------------

const PASSWORD = label('Password');
const passwordField = (formSubmitName: string | null): ResolvedElement => element({ role: 'textbox', name: 'Password', formSubmitName });

test('pressing Enter in a text field of a form whose submit control is named "Delete account" is denied as irreversible-submit', { criterion: 'AC-SPEC-03-07' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Enter')], stepIndex: 1, element: passwordField('Delete account') });
  assert.deepEqual(verdict, denied('irreversible-submit', 1));
});

test('pressing Space in a text field of a form whose submit control is named "Delete account" is denied as irreversible-submit', { criterion: 'AC-SPEC-03-07' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Space')], stepIndex: 1, element: passwordField('Delete account') });
  assert.deepEqual(verdict, denied('irreversible-submit', 1));
});

test('pressing Enter in a form whose submit control is named "Update password" is allowed', { criterion: 'AC-SPEC-03-07' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Enter')], stepIndex: 1, element: passwordField('Update password') });
  assert.deepEqual(verdict, ALLOWED);
});

test('pressing Enter in a text field outside any form is allowed', { criterion: 'AC-SPEC-03-07' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Enter')], stepIndex: 1, element: passwordField(null) });
  assert.deepEqual(verdict, ALLOWED);
});

test('pressing Tab, which submits nothing, in the "Delete account" form is allowed', { criterion: 'AC-SPEC-03-07' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Tab')], stepIndex: 1, element: passwordField('Delete account') });
  assert.deepEqual(verdict, ALLOWED);
});

// ---- Dialogs ------------------------------------------------------------------------------------

const OPEN_KEYS = click(role('button', 'Manage keys'));

test('accepting a dialog whose text matches an irreversible pattern is denied as irreversible-dialog', { criterion: 'AC-SPEC-03-09' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, OPEN_KEYS, acceptDialog], stepIndex: 2, element: NO_ELEMENT, dialogText: 'Revoke all API keys?',
  });
  assert.deepEqual(verdict, denied('irreversible-dialog', 2));
});

test('dismissing the same dialog is allowed', { criterion: 'AC-SPEC-03-09' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, OPEN_KEYS, dismissDialog], stepIndex: 2, element: NO_ELEMENT, dialogText: 'Revoke all API keys?',
  });
  assert.deepEqual(verdict, ALLOWED);
});

test('accepting a dialog whose text matches no pattern is allowed', { criterion: 'AC-SPEC-03-09' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, OPEN_KEYS, acceptDialog], stepIndex: 2, element: NO_ELEMENT, dialogText: 'Leave this page?',
  });
  assert.deepEqual(verdict, ALLOWED);
});

// ---- Controls with no accessible name -----------------------------------------------------------

const ICON_ONLY = testId('icon-only');

for (const [what, name] of [['no accessible name', null], ['an empty accessible name', '']] as const) {
  test(`a click on a control with ${what} that the project has not allowed by test id is denied as unnamed-control`, { criterion: 'AC-SPEC-03-10' }, async () => {
    const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, click(ICON_ONLY)], stepIndex: 1, element: element({ role: 'button', name }) });
    assert.deepEqual(verdict, denied('unnamed-control', 1));
  });
}

test('a click on an unnamed control whose test id the project allows is allowed', { criterion: 'AC-SPEC-03-10' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(testId(ALLOWED_UNNAMED_TEST_ID))], stepIndex: 1, element: element({ role: 'button', name: null }),
  });
  assert.deepEqual(verdict, ALLOWED);
});

test('with the allowance removed from the project, the same click on that unnamed control is denied', { criterion: 'AC-SPEC-03-10' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(testId(ALLOWED_UNNAMED_TEST_ID))], stepIndex: 1, element: element({ role: 'button', name: null }),
    projectInput: withPolicy({ unnamedControlsAllowedByTestId: [] }),
  });
  assert.deepEqual(verdict, denied('unnamed-control', 1));
});

test('a click on the same test id is allowed once the control it resolves to has a name', { criterion: 'AC-SPEC-03-10' }, async () => {
  const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, click(ICON_ONLY)], stepIndex: 1, element: element({ role: 'button', name: 'Open menu' }) });
  assert.deepEqual(verdict, ALLOWED);
});

// ---- Locales ------------------------------------------------------------------------------------

test('on a French target, a click that resolves to a button named "Supprimer" is denied as irreversible-action', { criterion: 'AC-SPEC-03-11' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Supprimer' }), targetId: FRENCH,
  });
  assert.deepEqual(verdict, denied('irreversible-action', 1));
});

test('on a French target, a click that resolves to a button named "Modifier" is allowed', { criterion: 'AC-SPEC-03-11' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Modifier' }), targetId: FRENCH,
  });
  assert.deepEqual(verdict, ALLOWED);
});

test('an action under a locale with no pattern set is denied as no-locale-patterns', { criterion: 'AC-SPEC-03-11' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))], stepIndex: 1, element: element({ role: 'button', name: 'Save changes' }),
    targetId: JAPANESE,
  });
  assert.deepEqual(verdict, denied('no-locale-patterns', 1));
});

test('on an fr-FR target, which falls back to the French patterns, a button named "Supprimer" is denied', { criterion: 'AC-SPEC-03-11' }, async () => {
  const verdict = await guard({
    steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Supprimer' }), targetId: FRENCH_IN_FRANCE,
  });
  assert.deepEqual(verdict, denied('irreversible-action', 1));
});

// ---- Irreversible names the project allows ------------------------------------------------------
// A team that tests its own delete feature lists the exact names in the trusted project.

const ALLOWS_DELETE_ACCOUNT = withPolicy({ allowedIrreversibleNames: ['Delete account', 'Revoke all API keys?'] });
const ALLOWS_NOTHING = withPolicy({ allowedIrreversibleNames: [] });

for (const [what, projectInput, expected] of [
  ['allows', ALLOWS_DELETE_ACCOUNT, ALLOWED], ['no longer allows', ALLOWS_NOTHING, denied('irreversible-action', 1)],
] as const) {
  test(`a click resolving to "Delete account" when the project ${what} that name is ${expected.kind === 'allow' ? 'allowed' : 'denied'}`, { criterion: 'AC-SPEC-03-01' }, async () => {
    const verdict = await guard({
      steps: [OPEN_ACCOUNT_PAGE, click(DANGER_ZONE)], stepIndex: 1, element: element({ role: 'button', name: 'Delete account' }), projectInput,
    });
    assert.deepEqual(verdict, expected);
  });

  test(`pressing Enter in the "Delete account" form when the project ${what} that name is ${expected.kind === 'allow' ? 'allowed' : 'denied'}`, { criterion: 'AC-SPEC-03-07' }, async () => {
    const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, press(PASSWORD, 'Enter')], stepIndex: 1, element: passwordField('Delete account'), projectInput });
    assert.deepEqual(verdict, expected.kind === 'allow' ? ALLOWED : denied('irreversible-submit', 1));
  });

  test(`accepting the dialog "Revoke all API keys?" when the project ${what} that text is ${expected.kind === 'allow' ? 'allowed' : 'denied'}`, { criterion: 'AC-SPEC-03-09' }, async () => {
    const verdict = await guard({
      steps: [OPEN_ACCOUNT_PAGE, OPEN_KEYS, acceptDialog], stepIndex: 2, element: NO_ELEMENT, dialogText: 'Revoke all API keys?', projectInput,
    });
    assert.deepEqual(verdict, expected.kind === 'allow' ? ALLOWED : denied('irreversible-dialog', 2));
  });
}

// ---- Links to destructive URLs ------------------------------------------------------------------

const YOUR_DATA = click(role('link', 'Your data'));
const linkTo = (url: string): ResolvedElement => element({ role: 'link', name: 'Your data', linkUrl: url });

for (const url of [`${ORIGIN}${DESTRUCTIVE_PATH}`, `${ORIGIN}${DESTRUCTIVE_PATH}/confirm`]) {
  test(`a click on a link whose resolved URL is ${url} is denied as destructive-navigation`, { criterion: 'AC-SPEC-03-08' }, async () => {
    const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, YOUR_DATA], stepIndex: 1, element: linkTo(url) });
    assert.deepEqual(verdict, denied('destructive-navigation', 1));
  });
}

for (const url of [`${ORIGIN}/account/deleted`, `${ORIGIN}/account/settings`]) {
  test(`a click on a link whose resolved URL is ${url} is allowed`, { criterion: 'AC-SPEC-03-08' }, async () => {
    const verdict = await guard({ steps: [OPEN_ACCOUNT_PAGE, YOUR_DATA], stepIndex: 1, element: linkTo(url) });
    assert.deepEqual(verdict, ALLOWED);
  });
}
