// A run's replay-identical claim must match what replay will do. replayManifest refuses a plan that
// calls declared services with no recording, since a replay never sends a call again. So at the
// isolated level, where replay-identical is otherwise claimed, such a run loses it, with the loss
// reason replies-not-recorded. A run with a recording keeps it, and so does a plan with no calls. A
// host-level run already loses it to egress-unenforceable, and its statement, and so its committed
// hashes, stay as they were.
// The loss reason is read as text, as replay.test.ts reads determinism-unpinned.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { GuaranteeLevel } from '@revisum/contracts';
import { guaranteeStatement, replayManifest, type RunResult } from '@revisum/engine';
import {
  DATABASE_PASSWORD, OPEN_CART, SEED_ORDERS, WIPE_ORDERS, commandPlan, commandProjectFile,
} from './database-command-examples.ts';
import { closedScenario, refused, removeFakeExecutables, replayRun, replayed, runScenario, type Scenario } from './replay-examples.ts';
import { OPEN_ORDERS, planOf, projectFileWith, type JsonRecord } from './run-value-examples.ts';
import {
  CREATE_ORDER, DELETE_ORDER, ORDER_ID, RESET_SHOP, SECRET_VALUES, callPlanOf, callProjectFile, expectBackend, withCleanup,
} from './service-call-examples.ts';
import { DATABASE_SECRET } from './unsafe-feature-steps.ts';

after(removeFakeExecutables);

const RECORD_REPLIES = { replay: { recordReplies: true } };
const NOT_RECORDED = 'replay-identical replies-not-recorded';

// The plans that call a declared service, each in another place a call can be.
const ORDER_PAID = expectBackend('getOrder', { orderId: ORDER_ID }, 'status', { kind: 'equals', value: 'paid' });
const PLANS_WITH_CALLS: readonly { readonly title: string; readonly plan: JsonRecord }[] = [
  { title: 'a call step', plan: withCleanup(callPlanOf([CREATE_ORDER]), [DELETE_ORDER]) },
  { title: 'a backend check', plan: callPlanOf([ORDER_PAID]) },
  { title: 'a call only in its cleanup', plan: withCleanup(callPlanOf([]), [RESET_SHOP]) },
];
const [CALLING_PLAN] = PLANS_WITH_CALLS;
assert.ok(CALLING_PLAN !== undefined);

const callScenario = (plan: JsonRecord, fields: JsonRecord, level?: GuaranteeLevel): Scenario => ({
  ...closedScenario(callProjectFile({}, {}, fields), plan),
  environment: SECRET_VALUES,
  ...(level === undefined ? {} : { guaranteeLevel: level }),
});

const lossLines = (result: RunResult): readonly string[] => result.guarantees.lost.map((loss) => `${loss.guarantee} ${String(loss.because)}`);

// What a statement says when nothing but the run's isolation decides it.
const statementWith = (egressEnforced: boolean) => guaranteeStatement({ mode: 'plan', egressEnforced, unmaskedScreenshotsKept: false, unsafeFeatures: [] });

// ---- Isolated, calling services, with no recording ---------------------------------------------------

for (const { title, plan } of PLANS_WITH_CALLS) {
  test(`at the isolated level, a plan with ${title} and no recording loses replay-identical with replies-not-recorded`, { criterion: 'AC-SPEC-07-05' }, async () => {
    const { result } = await runScenario(callScenario(plan, {}, 'isolated'));
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(!result.guarantees.holds.includes('replay-identical'), JSON.stringify(result.guarantees));
    assert.deepEqual(lossLines(result), [NOT_RECORDED]);
  });

  test(`at the isolated level, replayManifest refuses a plan with ${title} and no recording, as its statement says`, { criterion: 'AC-SPEC-07-05' }, async () => {
    const ran = await runScenario(callScenario(plan, {}, 'isolated'));
    const claimed = replayManifest(ran.manifest);
    assert.equal(claimed.ok ? 'claimed' : claimed.error.code, 'replay-not-claimed');
    assert.equal(refused((await replayRun(ran)).answer).code, 'replay-not-claimed');
    assert.equal(ran.result.guarantees.holds.includes('replay-identical'), false, 'the run claims a replay that replay refuses');
  });
}

test('losing replay-identical takes nothing else away: egress and credentials still hold, and the level says host', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { result } = await runScenario(callScenario(CALLING_PLAN.plan, {}, 'isolated'));
  assert.deepEqual(lossLines(result), [NOT_RECORDED]);
  assert.ok(result.guarantees.holds.includes('egress-enforced'), JSON.stringify(result.guarantees));
  assert.ok(result.guarantees.holds.includes('no-ambient-credentials'), JSON.stringify(result.guarantees));
  assert.equal(result.guarantees.level, 'host', 'the level is isolated only when every guarantee holds');
});

// ---- Isolated, calling services, with a recording ---------------------------------------------------

for (const { title, plan } of PLANS_WITH_CALLS) {
  test(`counter-example: at the isolated level, a plan with ${title} keeps replay-identical when the project records replies`, { criterion: 'AC-SPEC-07-05' }, async () => {
    const ran = await runScenario(callScenario(plan, RECORD_REPLIES, 'isolated'), { record: true });
    assert.deepEqual(ran.result.guarantees, statementWith(true));
    assert.equal(replayManifest(ran.manifest).ok, true);
    assert.equal(replayed((await replayRun(ran)).answer).verdict, 'identical');
  });
}

test('at the isolated level, a project that sets the recording to false loses replay-identical like one that never mentions it',{ criterion: 'AC-SPEC-07-05' }, async () => {
  const { result } = await runScenario(callScenario(CALLING_PLAN.plan, { replay: { recordReplies: false } }, 'isolated'));
  assert.deepEqual(lossLines(result), [NOT_RECORDED]);
});

// ---- Isolated, with no calls -----------------------------------------------------------------------------

test('counter-example: at the isolated level, a plan with no calls keeps replay-identical and replays identically', { criterion: 'AC-SPEC-07-05' }, async () => {
  const ran = await runScenario({ ...closedScenario(projectFileWith(), planOf([OPEN_ORDERS])), guaranteeLevel: 'isolated' });
  assert.deepEqual(ran.result.guarantees, statementWith(true));
  assert.equal(replayManifest(ran.manifest).ok, true);
  assert.equal(replayed((await replayRun(ran)).answer).verdict, 'identical');
});

test('counter-example: at the isolated level, a plan with no calls keeps it even in a project that declares calls', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { result, manifest } = await runScenario(callScenario(callPlanOf([]), {}, 'isolated'));
  assert.deepEqual(result.guarantees, statementWith(true));
  assert.equal(replayManifest(manifest).ok, true);
});

// ---- The claim never outruns replay, whatever the plan ----------------------------------------------------

const commandScenario = (fields: JsonRecord): Scenario => ({
  ...closedScenario(commandProjectFile(fields), commandPlan([OPEN_CART, SEED_ORDERS], [WIPE_ORDERS])),
  environment: { [DATABASE_SECRET]: DATABASE_PASSWORD },
  guaranteeLevel: 'isolated',
});

const AT_THE_ISOLATED_LEVEL: readonly { readonly title: string; readonly scenario: Scenario; readonly record: boolean; readonly claims: boolean }[] = [
  { title: 'no calls', scenario: { ...closedScenario(projectFileWith(), planOf([OPEN_ORDERS])), guaranteeLevel: 'isolated' }, record: false, claims: true },
  { title: 'calls, recorded', scenario: callScenario(CALLING_PLAN.plan, RECORD_REPLIES, 'isolated'), record: true, claims: true },
  { title: 'calls, not recorded', scenario: callScenario(CALLING_PLAN.plan, {}, 'isolated'), record: false, claims: false },
  { title: 'database commands, recorded', scenario: commandScenario(RECORD_REPLIES), record: true, claims: false },
  { title: 'database commands, not recorded', scenario: commandScenario({}), record: false, claims: false },
  { title: 'a clock the adapter cannot pin', scenario: { ...closedScenario(projectFileWith(), planOf([OPEN_ORDERS])), cannotPin: ['clock'], guaranteeLevel: 'isolated' }, record: false, claims: false },
];

for (const { title, scenario, record, claims } of AT_THE_ISOLATED_LEVEL) {
  test(`at the isolated level, a run with ${title} ${claims ? 'claims a replay that replay allows' : 'claims no replay'}`, { criterion: 'AC-SPEC-07-05' }, async () => {
    const ran = await runScenario(scenario, { record });
    assert.equal(ran.result.guarantees.holds.includes('replay-identical'), claims, JSON.stringify(ran.result.guarantees));
    if (claims) assert.equal(replayManifest(ran.manifest).ok, true, 'the run claims a replay that replay refuses');
  });
}

// ---- The host level, whose committed hashes must stay valid ---------------------------------------------

for (const { title, plan } of PLANS_WITH_CALLS) {
  test(`at the host level, a plan with ${title} and no recording keeps the statement it always had`, { criterion: 'AC-SPEC-07-05' }, async () => {
    const { result } = await runScenario(callScenario(plan, {}, 'host'));
    assert.deepEqual(result.guarantees, statementWith(false));
    assert.ok(!lossLines(result).includes(NOT_RECORDED), JSON.stringify(result.guarantees.lost));
  });
}

test('a run given no level has the very hashes of a host run, with calls and no recording', { criterion: 'AC-SPEC-07-05' }, async () => {
  const host = await runScenario(callScenario(CALLING_PLAN.plan, {}, 'host'));
  const unset = await runScenario(callScenario(CALLING_PLAN.plan, {}));
  assert.deepEqual(unset.result.guarantees, statementWith(false));
  assert.equal(unset.result.resultHash, host.result.resultHash);
  assert.equal(unset.result.manifestHash, host.result.manifestHash);
});

test('at the host level, a recorded plan with calls keeps the statement it always had, and replays identically', { criterion: 'AC-SPEC-07-05' }, async () => {
  const ran = await runScenario(callScenario(CALLING_PLAN.plan, RECORD_REPLIES, 'host'), { record: true });
  assert.deepEqual(ran.result.guarantees, statementWith(false));
  assert.equal(replayed((await replayRun(ran)).answer).verdict, 'identical');
});
