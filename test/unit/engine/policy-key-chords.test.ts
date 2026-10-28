// The runtime guard treats a press of Enter or Space with modifiers exactly as without them: in a
// form whose submit control matches an irreversible pattern it is denied as irreversible-submit.
// That an allowed chord reaches the page, and a denied one sends no key event, comes with the
// CDP driver, which calls this guard before every action.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedElement } from '@revisum/engine';
import {
  ALLOWED, ENGLISH, OPEN_ACCOUNT_PAGE, denied, element, label, localeOf, parsedPlan, planOf, stepAt, testGate,
  type JsonRecord,
} from './policy-examples.ts';

const PASSWORD = label('Password');
const passwordField = (formSubmitName: string | null): ResolvedElement => element({ role: 'textbox', name: 'Password', formSubmitName });
const chord = (key: string, modifiers: readonly string[]): JsonRecord => ({ type: 'press', locator: PASSWORD, key, modifiers });

// Parses a 1.2 plan of [open the account page, `press`], then guards the press as a driver would.
async function guardPress(press: JsonRecord, field: ResolvedElement) {
  const { gate, project } = await testGate();
  const plan = parsedPlan({ ...planOf([OPEN_ACCOUNT_PAGE, press]), version: '1.2' });
  return gate.guardAction(stepAt(plan, 1), 1, field, null, localeOf(project, ENGLISH));
}

const SUBMITTING_CHORDS: readonly [string, readonly string[]][] = [
  ['Enter', ['Control']], ['Enter', ['Shift']], ['Enter', ['ControlOrMeta']], ['Enter', ['Meta', 'Alt']],
  ['Space', ['Alt']], ['Space', ['Control', 'Shift']],
];

for (const [key, modifiers] of SUBMITTING_CHORDS) {
  test(`${[...modifiers, key].join('+')} in a form whose submit control is named "Delete account" is denied as irreversible-submit`, { criterion: 'AC-SPEC-30-15' }, async () => {
    assert.deepEqual(await guardPress(chord(key, modifiers), passwordField('Delete account')), denied('irreversible-submit', 1));
  });
}

// Counter-examples: the same chords where nothing irreversible is submitted, and a chord whose key
// submits nothing, are allowed.
test('Control+Enter and Shift+Enter in a form whose submit control is named "Update password" are allowed', { criterion: 'AC-SPEC-30-15' }, async () => {
  for (const modifiers of [['Control'], ['Shift']]) {
    assert.deepEqual(await guardPress(chord('Enter', modifiers), passwordField('Update password')), ALLOWED);
  }
});

test('Control+Enter in a text field outside any form is allowed', { criterion: 'AC-SPEC-30-15' }, async () => {
  assert.deepEqual(await guardPress(chord('Enter', ['Control']), passwordField(null)), ALLOWED);
});

test('Control+k, which submits nothing, in the "Delete account" form is allowed', { criterion: 'AC-SPEC-30-15' }, async () => {
  assert.deepEqual(await guardPress(chord('k', ['Control']), passwordField('Delete account')), ALLOWED);
});
