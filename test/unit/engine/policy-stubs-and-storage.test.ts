// The policy gate's static check over stubs and storage writes. A plan with no approval is a
// proposal: it may not start a stub or write a storage entry unless the declaration allows it in
// proposals (side-effect-in-proposal). Checking requests and reading storage change nothing, so a
// proposal may do both. Each denial is recorded as a plan.denied event with its rule, and a denied
// plan opens no browser.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, runUntrusted } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import {
  OPEN_ACCOUNT_PAGE, ORIGIN, approvedStanding, comparable, decideOn, deniedCodes, parsedPlan, parserProject, planOf, policyProjectInput,
  testGate, type JsonRecord,
} from './policy-examples.ts';
import { spyDriver } from './secret-examples.ts';

const request = (method: string, path: string): JsonRecord => ({ origin: ORIGIN, method, path, match: 'exact' });
const unavailable = { status: 503, mediaType: 'application/json', body: { json: { error: 'unavailable' } } };

const STUBS: JsonRecord = {
  // A stub the declaration does not allow in proposals.
  accountUnavailable: { request: request('GET', '/api/account'), parameters: {}, responses: [unavailable], allowInProposals: false },
  // A stub the declaration allows in proposals.
  noNotifications: {
    request: request('GET', '/api/notifications'), parameters: {}, responses: [{ status: 200, mediaType: 'application/json', body: { json: [] } }],
    allowInProposals: true,
  },
};
const OBSERVED_REQUESTS: JsonRecord = { accountLoads: { request: request('GET', '/api/account') } };
const STORAGE_ENTRIES: JsonRecord = {
  // A write the declaration does not allow in proposals.
  chosenLanguage: { area: 'local', origin: ORIGIN, key: 'account.language', access: 'readWrite', value: 'de', allowInProposals: false },
  // A write the declaration allows in proposals.
  bannerDismissed: { area: 'local', origin: ORIGIN, key: 'account.banner', access: 'readWrite', value: 'yes', allowInProposals: true },
  // An entry a plan may only check.
  consentRecord: { area: 'local', origin: ORIGIN, key: 'account.consent', access: 'read', allowInProposals: false },
};

const projectInput = (): JsonRecord =>
  policyProjectInput({ stubs: STUBS, observedRequests: OBSERVED_REQUESTS, storageEntries: STORAGE_ENTRIES });

const newerPlan = (steps: readonly unknown[]): JsonRecord => ({ ...planOf(steps), version: '1.2' });

const startStub = (name: string): JsonRecord => ({ type: 'stub', stub: name, action: 'start' });
const setStorage = (entry: string): JsonRecord => ({ type: 'setStorage', entry });
const removeStorage = (entry: string): JsonRecord => ({ type: 'removeStorage', entry });
const ACCOUNT_LOADED_ONCE: JsonRecord = { type: 'expectRequests', request: 'accountLoads', count: { equals: 1 }, criterionId: 'account.loaded-once' };
const ACCOUNT_LOADED_OK: JsonRecord = {
  type: 'expectResponse', request: 'accountLoads', assert: { kind: 'statusEquals', value: 200 }, criterionId: 'account.loaded-ok',
};
const CONSENT_KEPT: JsonRecord = { type: 'expectStorage', entry: 'consentRecord', assert: { kind: 'present' }, criterionId: 'account.consent-kept' };

async function decide(raw: JsonRecord, approved = false) {
  const input = projectInput();
  const tested = await testGate(input);
  const plan = parsedPlan(raw, input);
  const standing = approved ? await approvedStanding(plan) : undefined;
  return { decision: comparable(decideOn(tested, plan, standing)), events: tested.events };
}

// ---- Side effects in proposals ------------------------------------------------------------------------

test('a proposal that starts a stub its declaration does not allow in proposals is denied', { criterion: 'AC-SPEC-33-12' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, startStub('accountUnavailable')]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'side-effect-in-proposal', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

test('a proposal that writes a storage entry its declaration does not allow in proposals is denied', { criterion: 'AC-SPEC-33-12' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, setStorage('chosenLanguage')]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'side-effect-in-proposal', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

// Removing an entry is a storage write too.
test('a proposal that removes a storage entry its declaration does not allow in proposals is denied', { criterion: 'AC-SPEC-33-12' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, removeStorage('chosenLanguage')]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'side-effect-in-proposal', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

test('a removeStorage is allowed in an approved plan, and in a proposal when the declaration allows it', { criterion: 'AC-SPEC-33-12' }, async () => {
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, removeStorage('chosenLanguage')]), true)).decision, { kind: 'allow' });
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, removeStorage('bannerDismissed')]))).decision, { kind: 'allow' });
});

// Counter-examples: the same steps in an approved plan, declarations allowed in proposals, and checks.
test('the same stub start and storage write in an approved plan are allowed', { criterion: 'AC-SPEC-33-12' }, async () => {
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, startStub('accountUnavailable')]), true)).decision, { kind: 'allow' });
  assert.deepEqual((await decide(newerPlan([OPEN_ACCOUNT_PAGE, setStorage('chosenLanguage')]), true)).decision, { kind: 'allow' });
});

test('a proposal may start a stub and write an entry whose declarations set allowInProposals', { criterion: 'AC-SPEC-33-12' }, async () => {
  const { decision, events } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, startStub('noNotifications'), setStorage('bannerDismissed')]));
  assert.deepEqual(decision, { kind: 'allow' });
  assert.deepEqual(deniedCodes(events), []);
});

test('a proposal may check requests, check a response and check a storage entry', { criterion: 'AC-SPEC-33-12' }, async () => {
  const resetAccountLoads = { type: 'resetRequests', request: 'accountLoads' };
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, resetAccountLoads, ACCOUNT_LOADED_ONCE, ACCOUNT_LOADED_OK, CONSENT_KEPT]));
  assert.deepEqual(decision, { kind: 'allow' });
});

test('a denied stub start is found after steps the gate allows, at its own index', { criterion: 'AC-SPEC-33-12' }, async () => {
  const { decision } = await decide(newerPlan([OPEN_ACCOUNT_PAGE, startStub('noNotifications'), ACCOUNT_LOADED_ONCE, startStub('accountUnavailable')]));
  assert.deepEqual(decision, { kind: 'deny', rule: 'side-effect-in-proposal', stepIndex: 3 });
});

// ---- Nothing is dispatched for a denied plan ------------------------------------------------------------

test('a plan the gate denies for a stub or a storage write opens no browser', { criterion: 'AC-SPEC-33-12' }, async () => {
  const input = projectInput();
  const spy = spyDriver();
  const ports = {
    drivers: new Map([['cdp', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  };
  const base = { project: parserProject(input), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  const parse = (raw: unknown) => ({ ok: true as const, value: parsedPlan(raw as JsonRecord, input) });
  const rules: string[] = [];
  for (const raw of [newerPlan([OPEN_ACCOUNT_PAGE, startStub('accountUnavailable')]), newerPlan([OPEN_ACCOUNT_PAGE, setStorage('chosenLanguage')])]) {
    const outcome = await runUntrusted(raw, parse, base, ports);
    assert.ok('rule' in outcome, JSON.stringify(outcome));
    if ('rule' in outcome) rules.push(outcome.rule);
  }
  assert.deepEqual(rules, ['side-effect-in-proposal', 'side-effect-in-proposal']);
  assert.equal(spy.opens, 0, 'no browser was opened');
});

// Counter-example: the same spy is opened for a plan the gate allows, so the count above can fail.
test('counter-example: a proposal with a stub allowed in proposals opens the browser', { criterion: 'AC-SPEC-33-12' }, async () => {
  const input = projectInput();
  const spy = spyDriver();
  const ports = {
    drivers: new Map([['cdp', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  };
  const base = { project: parserProject(input), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  const parse = (raw: unknown) => ({ ok: true as const, value: parsedPlan(raw as JsonRecord, input) });
  await runUntrusted(newerPlan([OPEN_ACCOUNT_PAGE, startStub('noNotifications')]), parse, base, ports);
  assert.ok(spy.opens > 0, 'the browser was opened');
});
