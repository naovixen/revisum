// The policy gate's static check over advancing the clock and checking the clipboard. Neither is
// an action step: an advance moves the page's own clock and a clipboard check or remember only
// reads, so a plan with no approval, a proposal, may hold all three, and no side-effect rule
// applies. That the driver dispatches no input event during an advance, and that the runtime
// guard is never asked, come with the CDP driver's clock port.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPEN_ACCOUNT_PAGE, approvedStanding, click, comparable, decideOn, deniedCodes, parsedPlan, planOf, policyProjectInput, role, testGate,
  type JsonRecord,
} from './policy-examples.ts';

const newerPlan = (steps: readonly unknown[]): JsonRecord => ({ ...planOf(steps), version: '1.2' });

const ADVANCE: JsonRecord = { type: 'advanceClock', by: { amount: 10, unit: 'minutes' } };
const SKIP_AHEAD: JsonRecord = { type: 'advanceClock', by: { amount: 1, unit: 'hours' }, mode: 'skipAhead' };
const COPY: JsonRecord = click(role('button', 'Copy invite link'));
const CLIPBOARD_CHECK: JsonRecord = {
  type: 'expectClipboard', assert: { kind: 'textContains', value: '/invite/' }, criterionId: 'account.invite-copied',
};
const CLIPBOARD_EXCLUDES: JsonRecord = {
  type: 'expectClipboard', assert: { kind: 'textExcludes', value: 'password' }, criterionId: 'account.invite-has-no-password',
};
const REMEMBER: JsonRecord = { type: 'remember', name: 'inviteLink', from: { clipboard: 'text' } };

async function decide(raw: JsonRecord, approved = false) {
  const input = policyProjectInput();
  const tested = await testGate(input);
  const plan = parsedPlan(raw, input);
  const standing = approved ? await approvedStanding(plan) : undefined;
  return { decision: comparable(decideOn(tested, plan, standing)), events: tested.events };
}

test('a proposal that advances the clock in both modes and checks and remembers the clipboard is allowed, with no denial recorded', { criterion: 'AC-SPEC-34-18' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, ADVANCE, SKIP_AHEAD, COPY, CLIPBOARD_CHECK, CLIPBOARD_EXCLUDES, REMEMBER]));
  assert.deepEqual(decision, { kind: 'allow' });
  assert.deepEqual(deniedCodes(events), []);
});

test('a proposal is allowed an advance before its first navigation and a clipboard check as its only assertion', { criterion: 'AC-SPEC-34-18' }, async () => {
  const raw = { ...newerPlan([]), steps: [ADVANCE, OPEN_ACCOUNT_PAGE, COPY, CLIPBOARD_CHECK] };
  const { decision, events } = await decide(raw);
  assert.deepEqual(decision, { kind: 'allow' });
  assert.deepEqual(deniedCodes(events), []);
});

test('the same plan is allowed when approved', { criterion: 'AC-SPEC-34-18' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, ADVANCE, COPY, CLIPBOARD_CHECK, REMEMBER]), true);
  assert.deepEqual(decision, { kind: 'allow' });
});

// Counter-example: the gate still judges the plan's actions around the advance, so the allows
// above come from the advance and the clipboard steps, not from a gate that allows everything.
test('counter-example: an irreversible click after an advance and a clipboard check is still denied at its own index', { criterion: 'AC-SPEC-34-18' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, ADVANCE, CLIPBOARD_CHECK, click(role('button', 'Delete account'))]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'irreversible-action', stepIndex: 3 });
  assert.deepEqual(deniedCodes(events), ['irreversible-action']);
});
