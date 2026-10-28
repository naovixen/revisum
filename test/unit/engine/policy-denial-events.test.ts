// Every deny decision, static or at run time, is an audit event: core appends one plan.denied
// event through the shared event sink, whose code is the rule, so a denial leaves a record even
// when nothing ran. A denied plan is not patched and retried under its old standing: the
// re-planned plan is a new plan, with a new hash, and stands as a proposal until it has its own
// approval.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jsonLinesEventSink, mergeGateOpen, planHash, planStanding, policyGate, type Approval } from '@revisum/engine';
import { memoryApprovalStore, parsedSignupPlan, withRepository } from './approval-repositories.ts';
import {
  ENGLISH, JAPANESE, OPEN_ACCOUNT_PAGE, POLICY, acceptDialog, click, decideOn, deniedCodes, element, label, localeOf, navigate,
  parsedPlan, planOf, policyProjectInput, press, role, stepAt, targetsOf, testGate, testId, trustedProject, NO_ELEMENT,
} from './policy-examples.ts';
import { TARGET_ID, signupPlan, withValue } from './plan-examples.ts';

const DELETE_PLAN = planOf([OPEN_ACCOUNT_PAGE, click(role('button', 'Delete account'))]);
const SAVE_PLAN = planOf([OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))]);
const DANGER_ZONE_PLAN = planOf([OPEN_ACCOUNT_PAGE, click(testId('danger-zone-action'))]);

// ---- Static denials -----------------------------------------------------------------------------

const STATIC_DENIALS = [
  ['an irreversible click', DELETE_PLAN, 'irreversible-action'],
  ['a production origin', planOf([OPEN_ACCOUNT_PAGE, navigate('https://shop.example.com/orders')]), 'production-origin'],
  ['a destructive URL', planOf([OPEN_ACCOUNT_PAGE, navigate('/account/delete')]), 'destructive-navigation'],
  ['a locale with no pattern set', planOf([OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))], [JAPANESE]), 'no-locale-patterns'],
] as const;

for (const [what, raw, rule] of STATIC_DENIALS) {
  test(`when the gate denies a plan for ${what}, core appends one plan.denied event whose code is ${rule}`, { criterion: 'AC-SPEC-03-05' }, async () => {
    const tested = await testGate();
    const decision = decideOn(tested, parsedPlan(raw));
    assert.equal(decision.kind, 'deny', JSON.stringify(decision));
    assert.deepEqual(deniedCodes(tested.events), [rule], JSON.stringify(tested.events.recorded));
  });
}

test('when the gate allows a plan, no plan.denied event is appended', { criterion: 'AC-SPEC-03-05' }, async () => {
  // The counter-example: only the clicked control's name differs from the denied plan above.
  const tested = await testGate();
  const decision = decideOn(tested, parsedPlan(SAVE_PLAN));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  assert.deepEqual(deniedCodes(tested.events), [], JSON.stringify(tested.events.recorded));
});

// ---- Run-time denials ---------------------------------------------------------------------------

const RUNTIME_DENIALS = [
  ['an irreversible click', DANGER_ZONE_PLAN, element({ role: 'button', name: 'Delete account' }), null, 'irreversible-action'],
  ['an irreversible submit', planOf([OPEN_ACCOUNT_PAGE, press(label('Password'), 'Enter')]),
    element({ role: 'textbox', name: 'Password', formSubmitName: 'Delete account' }), null, 'irreversible-submit'],
  ['an irreversible dialog', planOf([OPEN_ACCOUNT_PAGE, acceptDialog]), NO_ELEMENT, 'Revoke all API keys?', 'irreversible-dialog'],
  ['an unnamed control', planOf([OPEN_ACCOUNT_PAGE, click(testId('icon-only'))]), element({ role: 'button', name: null }), null, 'unnamed-control'],
] as const;

for (const [what, raw, resolved, dialogText, rule] of RUNTIME_DENIALS) {
  test(`when the runtime guard denies ${what}, core appends one plan.denied event whose code is ${rule}`, { criterion: 'AC-SPEC-03-05' }, async () => {
    const { gate, events, project } = await testGate();
    const verdict = gate.guardAction(stepAt(parsedPlan(raw), 1), 1, resolved, dialogText, localeOf(project, ENGLISH));
    assert.equal(verdict.kind, 'deny', JSON.stringify(verdict));
    assert.deepEqual(deniedCodes(events), [rule], JSON.stringify(events.recorded));
  });
}

test('when the runtime guard allows an action, no plan.denied event is appended', { criterion: 'AC-SPEC-03-05' }, async () => {
  const { gate, events, project } = await testGate();
  const plan = parsedPlan(DANGER_ZONE_PLAN);
  const verdict = gate.guardAction(stepAt(plan, 1), 1, element({ role: 'button', name: 'Download your data' }), null, localeOf(project, ENGLISH));
  assert.equal(verdict.kind, 'allow', JSON.stringify(verdict));
  assert.deepEqual(deniedCodes(events), [], JSON.stringify(events.recorded));
});

test('a denial reaches the JSON Lines sink as a plan.denied entry carrying the rule', { criterion: 'AC-SPEC-03-05' }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'revisum-policy-events-'));
  try {
    const path = join(folder, 'audit.jsonl');
    const project = await trustedProject();
    const gate = policyGate({ project, events: jsonLinesEventSink(path) });
    const plan = parsedPlan(DELETE_PLAN);
    assert.equal(gate.decide(plan, targetsOf(project, plan)).kind, 'deny');
    const entries = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.code]), [['plan.denied', 'irreversible-action']]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ---- Re-planning --------------------------------------------------------------------------------

// The sign-up plan's step 8 clicks "Create account". This project adds "create" to the German
// patterns of the sign-up plan's target, so the approved sign-up plan is denied there.
const signupProjectInput = () => policyProjectInput({
  matrix: [{
    id: TARGET_ID, adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
    locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce',
  }],
  policy: { ...POLICY, irreversiblePatterns: { 'de-DE': ['create'] } },
});

async function declaredSignupApproval(): Promise<Approval> {
  let approval: Approval | undefined;
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    if (!verified.ok) throw new Error(`the sign-up plan was not approved: ${verified.error}`);
    approval = verified.value.approval;
  });
  if (approval === undefined) throw new Error('no approval');
  return approval;
}

test('an approved plan is still denied by the gate: approval does not bypass policy', { criterion: 'AC-SPEC-03-05' }, async () => {
  const store = memoryApprovalStore([await declaredSignupApproval()]);
  const approved = parsedSignupPlan();
  const standing = planStanding(approved, store);
  assert.equal(standing.mode, 'approved');
  const tested = await testGate(signupProjectInput());
  assert.deepEqual(decideOn(tested, approved, standing), { kind: 'deny', rule: 'irreversible-action', stepIndex: 8 });
  assert.deepEqual(deniedCodes(tested.events), ['irreversible-action']);
});

test('the plan re-planned after a denial is a new plan that stands as a proposal, not under the denied plan\'s approval', { criterion: 'AC-SPEC-03-05' }, async () => {
  const store = memoryApprovalStore([await declaredSignupApproval()]);
  const denied = parsedSignupPlan();
  const replanned = parsedSignupPlan(withValue(signupPlan(), ['steps', 8, 'locator', 'name'], 'Register'));
  assert.notEqual(planHash(replanned), planHash(denied));
  const standing = planStanding(replanned, store);
  assert.deepEqual(standing, { mode: 'proposal' });
  assert.equal(mergeGateOpen(standing), false);
  // The re-planned plan passes the gate as a proposal, yet still needs an approval of its own.
  assert.equal(decideOn(await testGate(signupProjectInput()), replanned, standing).kind, 'allow');
});
