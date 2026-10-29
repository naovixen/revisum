// Declared stubs, request checks and web storage join plan language 1.2's published schema.
// golden/plans/ holds a 1.2 golden plan for each new step and check, `npm run lint` validates every
// golden plan against the schema, and the changelog's one 1.2 entry names each new step, check,
// project section, setting and error code. The schema-hash and entry-format checks are in
// plan-schema-newer-version.test.ts.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { changelogEntry } from '../support/plan-changelog.ts';
import { GOLDEN, REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';

const STUB_PLAN_PATH = 'golden/plans/login-code-stub.json';
const STORAGE_PLAN_PATH = 'golden/plans/pinned-menu-storage.json';
const TIMEOUT = 300_000;

type JsonRecord = Record<string, unknown>;

const readText = (relativePath: string): string => readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');

const newerGoldenPlans = (): JsonRecord[] =>
  readdirSync(join(GOLDEN, 'plans')).filter((name) => name.endsWith('.json')).sort()
    .map((name): JsonRecord => JSON.parse(readFileSync(join(GOLDEN, 'plans', name), 'utf8')))
    .filter((plan) => plan['version'] === '1.2');

// Every object inside a JSON value, depth first.
const objectsIn = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (typeof value !== 'object' || value === null) return [];
  const record: JsonRecord = { ...value };
  return [record, ...Object.values(record).flatMap(objectsIn)];
};

const stepsWhere = (plan: JsonRecord, matches: (step: JsonRecord) => boolean): boolean => objectsIn(plan['steps']).some(matches);
const usesStep = (type: string) => (plan: JsonRecord): boolean => stepsWhere(plan, (step) => step['type'] === type);
const countKindOf = (step: JsonRecord): string | undefined => {
  const count = step['count'];
  return typeof count === 'object' && count !== null ? Object.keys(count)[0] : undefined;
};
const responseRead = (step: JsonRecord): unknown => {
  const from = step['from'];
  return step['type'] === 'remember' && typeof from === 'object' && from !== null && 'response' in from && 'read' in from ? from.read : undefined;
};

const RESPONSE_CHECKS = ['statusEquals', 'fieldPresent', 'fieldAbsent', 'fieldEquals', 'fieldContains'];
const STORAGE_CHECKS = ['present', 'absent', 'equals'];

const FEATURES: Readonly<Record<string, (plan: JsonRecord) => boolean>> = {
  'a stub start with arguments': (plan) => stepsWhere(plan, (step) => step['type'] === 'stub' && step['action'] === 'start' && step['arguments'] !== undefined),
  'a stub stop': (plan) => stepsWhere(plan, (step) => step['type'] === 'stub' && step['action'] === 'stop'),
  'a resetRequests': usesStep('resetRequests'),
  ...Object.fromEntries(['equals', 'atLeast', 'atMost'].map((kind) => [
    `the request count "${kind}"`, (plan: JsonRecord) => stepsWhere(plan, (step) => step['type'] === 'expectRequests' && countKindOf(step) === kind),
  ])),
  ...Object.fromEntries(RESPONSE_CHECKS.map((kind) => [
    `the response check "${kind}"`,
    (plan: JsonRecord) => stepsWhere(plan, (step) => step['type'] === 'expectResponse' && objectsIn(step['assert']).some((assertion) => assertion['kind'] === kind)),
  ])),
  ...Object.fromEntries(['text', 'arrayLength'].map((read) => [
    `a remember reading a response field as "${read}"`, (plan: JsonRecord) => stepsWhere(plan, (step) => responseRead(step) === read),
  ])),
  'a setStorage with arguments': (plan) => stepsWhere(plan, (step) => step['type'] === 'setStorage' && step['arguments'] !== undefined),
  'a removeStorage': usesStep('removeStorage'),
  ...Object.fromEntries(STORAGE_CHECKS.map((kind) => [
    `the storage check "${kind}"`,
    (plan: JsonRecord) => stepsWhere(plan, (step) => step['type'] === 'expectStorage' && objectsIn(step['assert']).some((assertion) => assertion['kind'] === kind)),
  ])),
};

for (const [feature, uses] of Object.entries(FEATURES)) {
  test(`a 1.2 golden plan uses ${feature}`, { criterion: 'AC-SPEC-30-02' }, () => {
    assert.ok(newerGoldenPlans().some(uses), `no golden plan declaring 1.2 uses ${feature}`);
  });
}

// ---- The changelog's 1.2 entry ---------------------------------------------------------------------

const NAMED_IN_ENTRY = [
  'stub', 'resetRequests', 'expectRequests', 'expectResponse', 'setStorage', 'removeStorage', 'expectStorage',
  'atLeast', 'atMost', ...RESPONSE_CHECKS, 'arrayLength',
  'stubs', 'observedRequests', 'storageEntries', 'requestQuietMilliseconds', 'request-not-seen', 'storage-origin-mismatch',
];

test('the 1.2 changelog entry names each new step, check, section, setting and error code, in code type', { criterion: 'AC-SPEC-30-02' }, () => {
  const entry = changelogEntry('1.2');
  assert.match(entry, /^## 1\.2\b/);
  assert.deepEqual(NAMED_IN_ENTRY.filter((name) => !entry.includes(`\`${name}\``)), [], 'names the 1.2 entry leaves out');
});

// ---- The lint check ---------------------------------------------------------------------------------

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

const planAt = (path: string): JsonRecord => JSON.parse(readText(path));
const stepsOf = (plan: JsonRecord): JsonRecord[] => {
  const steps = plan['steps'];
  assert.ok(Array.isArray(steps));
  return steps;
};

test('the lint fails when a golden plan gives a stub an action the language does not have', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = planAt(STUB_PLAN_PATH);
  const stub = stepsOf(plan).find((step) => step['type'] === 'stub');
  assert.ok(stub !== undefined);
  stub['action'] = 'pause';
  assertFailsNaming(scratch.lintWith('golden/plans/planted-stub-action.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-stub-action.json');
});

test('the lint fails when a golden plan writes its own response into a stub step', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = planAt(STUB_PLAN_PATH);
  const stub = stepsOf(plan).find((step) => step['type'] === 'stub');
  assert.ok(stub !== undefined);
  stub['responses'] = [{ status: 200, mediaType: 'text/html', body: { text: 'hello' } }];
  assertFailsNaming(scratch.lintWith('golden/plans/planted-stub-response.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-stub-response.json');
});

test('the lint fails when a golden plan names its own storage key in a setStorage', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = planAt(STORAGE_PLAN_PATH);
  const write = stepsOf(plan).find((step) => step['type'] === 'setStorage');
  assert.ok(write !== undefined);
  write['key'] = 'auth.token';
  assertFailsNaming(scratch.lintWith('golden/plans/planted-storage-key.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-storage-key.json');
});

// Counter-example: a valid copy of the storage plan, with a stub added, passes, so the failures
// above come from the planted problems.
test('the lint accepts a new 1.2 golden plan with a stub, a request check and storage steps', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = planAt(STORAGE_PLAN_PATH);
  (plan['meta'] as JsonRecord)['title'] = 'A docked menu stays docked, second copy';
  stepsOf(plan).unshift({ type: 'stub', stub: 'loginNeedsCode', action: 'start', arguments: { reason: 'Code needed' } });
  stepsOf(plan).push({ type: 'expectRequests', request: 'likes', count: { atMost: 0 }, criterionId: 'menu.no-likes-loaded' });
  const outcome = scratch.lintWith('golden/plans/planted-valid-storage.json', `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(outcome.passed, true, outcome.failureOutput);
});
