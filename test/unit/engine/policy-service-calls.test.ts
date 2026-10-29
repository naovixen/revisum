// The policy gate's static check over declared calls. A plan with no approval is a proposal: it may
// not make a write call unless the declaration allows it in proposals (side-effect-in-proposal).
// Calls and cleanup calls together count toward the project's maximumCalls (over-limit). A call to
// a service on a production origin is denied (production-origin). Each denial is recorded as a
// plan.denied event with its rule, and a denied plan makes no call at all.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, runUntrusted } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import {
  OPEN_ACCOUNT_PAGE, ORIGIN, POLICY, PRODUCTION_ORIGIN, approvedStanding, comparable, decideOn, deniedCodes, parsedPlan, parserProject,
  planOf, policyProjectInput, testGate, type JsonRecord,
} from './policy-examples.ts';
import { fakeServiceCaller } from './service-call-examples.ts';
import { spyDriver } from './secret-examples.ts';

const SHOP_ORIGIN = 'http://127.0.0.1:4180';
const SERVICES = [
  { name: 'shop', origin: SHOP_ORIGIN, private: true },
  // The live shop's API, on the project's production origin.
  { name: 'live', origin: PRODUCTION_ORIGIN, private: false },
];

const order = { orderId: { kind: 'identifier' } };
const CALLS: JsonRecord = {
  // A write the declaration does not allow in proposals.
  createOrder: { service: 'shop', method: 'POST', path: '/api/orders', parameters: {}, effect: 'write', successStatuses: [201], fields: { orderId: '/id' } },
  // A write the declaration allows in proposals.
  seedCatalogue: { service: 'shop', method: 'POST', path: '/api/test/catalogue', parameters: {}, effect: 'write', successStatuses: [204], allowInProposals: true },
  getOrder: { service: 'shop', method: 'GET', path: '/api/orders/{orderId}', parameters: order, effect: 'read', successStatuses: [200], fields: { status: '/status' } },
  // A read of the live shop.
  liveOrderCount: { service: 'live', method: 'GET', path: '/api/orders/count', parameters: {}, effect: 'read', successStatuses: [200], fields: { count: '/count' } },
};

// `policy` changes the shared policy, such as allowing production for approved plans.
const projectInput = (limits: Readonly<Record<string, number>> = {}, policy: JsonRecord = {}): JsonRecord =>
  policyProjectInput({ services: SERVICES, calls: CALLS, limits: { stepTimeoutMilliseconds: 2000, ...limits }, policy: { ...POLICY, ...policy } });

const newerPlan = (steps: readonly unknown[], cleanup?: readonly unknown[]): JsonRecord =>
  ({ ...planOf(steps), version: '1.2', ...(cleanup === undefined ? {} : { cleanup }) });

const call = (name: string): JsonRecord => ({ type: 'call', call: name, arguments: {} });
const readOrderStatus: JsonRecord = {
  type: 'expectBackend', call: 'getOrder', arguments: { orderId: 'ord_1' }, field: 'status', assert: { kind: 'equals', value: 'paid' },
  criterionId: 'account.order-paid',
};
const liveCount: JsonRecord = {
  type: 'expectBackend', call: 'liveOrderCount', arguments: {}, field: 'count', assert: { kind: 'present' }, criterionId: 'account.orders-counted',
};

type DecideOptions = { readonly limits?: Readonly<Record<string, number>>; readonly approved?: boolean; readonly policy?: JsonRecord };

async function decide(raw: JsonRecord, options: DecideOptions = {}) {
  const input = projectInput(options.limits, options.policy);
  const tested = await testGate(input);
  const plan = parsedPlan(raw, input);
  const standing = options.approved === true ? await approvedStanding(plan) : undefined;
  return { decision: comparable(decideOn(tested, plan, standing)), events: tested.events };
}

// ---- Writes in proposals ----------------------------------------------------------------------------

test('a proposal that makes a write call its declaration does not allow in proposals is denied', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('createOrder')]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'side-effect-in-proposal', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

test('a proposal whose only such write is in cleanup is denied too', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE], [call('createOrder')]));
  assert.equal(decision['kind'], 'deny');
  assert.equal(decision['rule'], 'side-effect-in-proposal');
});

// Counter-examples: the same write in an approved plan, a write allowed in proposals, and reads.
test('the same write call in an approved plan is allowed', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('createOrder')]), { approved: true });
  assert.deepEqual(decision, { kind: 'allow' });
});

test('a proposal may make a write call whose declaration sets allowInProposals', { criterion: 'AC-SPEC-32-06' }, async () => {
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('seedCatalogue')], [call('seedCatalogue')]))).decision, { kind: 'allow' });
});

test('a proposal may make read calls and backend checks', { criterion: 'AC-SPEC-32-06' }, async () => {
  const readCall = { type: 'call', call: 'getOrder', arguments: { orderId: 'ord_1' } };
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, readCall, readOrderStatus]))).decision, { kind: 'allow' });
});

// ---- The call limit ---------------------------------------------------------------------------------

test('calls plus cleanup calls over maximumCalls are denied as over-limit', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('seedCatalogue'), call('seedCatalogue')], [call('seedCatalogue')]), { limits: { maximumCalls: 2 } });
  assert.equal(decision['kind'], 'deny');
  assert.equal(decision['rule'], 'over-limit');
  assert.deepEqual(deniedCodes(events), ['over-limit']);
});

test('calls plus cleanup calls up to maximumCalls are allowed', { criterion: 'AC-SPEC-32-06' }, async () => {
  for (const [steps, cleanup] of [[2, 0], [1, 1], [0, 2]] as const) {
    const plan = newerPlan([OPEN_ACCOUNT_PAGE, ...Array.from({ length: steps }, () => call('seedCatalogue'))], Array.from({ length: cleanup }, () => call('seedCatalogue')));
    assert.deepEqual((await decide(plan, { limits: { maximumCalls: 2 } })).decision, { kind: 'allow' }, `${steps} steps, ${cleanup} cleanup`);
  }
});

test('with no limit set, 20 calls are allowed and 21 are denied as over-limit', { criterion: 'AC-SPEC-32-06' }, async () => {
  const calls = (count: number) => Array.from({ length: count }, () => call('seedCatalogue'));
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, ...calls(19)], calls(1)))).decision, { kind: 'allow' });
  const denied = (await decide(newerPlan([OPEN_ACCOUNT_PAGE, ...calls(20)], calls(1)))).decision;
  assert.equal(denied['rule'], 'over-limit');
});

// ---- Production services -------------------------------------------------------------------------------

test('a call to a service on a production origin is denied as production-origin, in a proposal', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, liveCount]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'production-origin', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['production-origin']);
});

test('a call to a service on a production origin is denied in an approved plan too', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, liveCount]), { approved: true });
  assert.deepEqual(decision, { kind: 'deny', rule: 'production-origin', stepIndex: 1 });
});

test('a cleanup call to a production service is denied as production-origin', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE], [{ type: 'call', call: 'liveOrderCount', arguments: {} }]));
  assert.equal(decision['rule'], 'production-origin');
});

test('a production service is allowed for an approved plan when the policy allows production for approved plans', { criterion: 'AC-SPEC-32-06' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, liveCount]), { approved: true, policy: { allowProductionForApprovedPlans: true } });
  assert.deepEqual(decision, { kind: 'allow' });
});

test('a proposal calling a production service is denied even when the policy allows production for approved plans', { criterion: 'AC-SPEC-32-06' }, async () => {
  const policy = { allowProductionForApprovedPlans: true };
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, liveCount]), { policy })).decision, { kind: 'deny', rule: 'production-origin', stepIndex: 1 });
  const cleanup = (await decide(newerPlan([OPEN_ACCOUNT_PAGE], [{ type: 'call', call: 'liveOrderCount', arguments: {} }]), { policy })).decision;
  assert.equal(cleanup['rule'], 'production-origin');
});

test('a backend check counts once toward maximumCalls, as a call step does', { criterion: 'AC-SPEC-32-06' }, async () => {
  const limits = { maximumCalls: 2 };
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('seedCatalogue'), readOrderStatus]), { limits })).decision, { kind: 'allow' });
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, readOrderStatus, readOrderStatus]), { limits })).decision, { kind: 'allow' });
  const over = (await decide(newerPlan([OPEN_ACCOUNT_PAGE, call('seedCatalogue'), readOrderStatus], [call('seedCatalogue')]), { limits })).decision;
  assert.equal(over['rule'], 'over-limit');
  const overByChecks = (await decide(newerPlan([OPEN_ACCOUNT_PAGE, readOrderStatus, readOrderStatus, readOrderStatus]), { limits })).decision;
  assert.equal(overByChecks['rule'], 'over-limit');
});

// ---- No call is made for a denied plan -----------------------------------------------------------------

test('a plan the gate denies for any of these rules makes zero calls and opens no browser', { criterion: 'AC-SPEC-32-06' }, async () => {
  const input = projectInput({ maximumCalls: 2 });
  const project = parserProject(input);
  const { caller, requests } = fakeServiceCaller();
  const spy = spyDriver();
  const ports = {
    drivers: new Map([['cdp', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(),
    events: memoryRunEventSink(), services: caller,
  };
  const base = { project, baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  const planParserFor = (raw: unknown) => ({ ok: true as const, value: parsedPlan(raw as JsonRecord, input) });
  const denied = [
    newerPlan([OPEN_ACCOUNT_PAGE, call('createOrder')]),
    newerPlan([OPEN_ACCOUNT_PAGE, call('seedCatalogue'), call('seedCatalogue')], [call('seedCatalogue')]),
    newerPlan([OPEN_ACCOUNT_PAGE, liveCount]),
  ];
  const rules: string[] = [];
  for (const raw of denied) {
    const outcome = await runUntrusted(raw, planParserFor, base, ports);
    assert.ok('rule' in outcome, JSON.stringify(outcome));
    if ('rule' in outcome) rules.push(outcome.rule);
  }
  assert.deepEqual(rules, ['side-effect-in-proposal', 'over-limit', 'production-origin']);
  assert.equal(requests.length, 0, 'no call was made');
  assert.equal(spy.opens, 0, 'no browser was opened');
});
