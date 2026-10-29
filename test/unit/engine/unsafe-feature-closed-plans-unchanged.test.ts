// Plan language 1.3 changes nothing for a closed plan. With no unsafe feature enabled, every 1.1
// and 1.2 golden plan parses to the plan it gave before 1.3 existed, byte for byte, and a run of a
// closed plan gives the result hash and manifest hash it gave then. The hashes in
// golden/closed-language/hashes.json were recorded from the 1.2 engine before any 1.3 code existed:
// the plan hash of each golden plan, parsed against the shared test project, and the result and
// manifest hashes of four runs on the recording driver (run-value-examples.ts). The golden report
// replay (test/replay/golden-report.test.ts) covers the report and its replay hashes.
//
// A change that makes a closed plan's result or manifest carry an unsafe field, even an empty
// list, changes these hashes, so the unsafe fields must be absent from closed runs.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planHash } from '@revisum/engine';
import { GOLDEN } from '../../support/repository.ts';
import { defaultParser, goldenPlan, goldenPlanNames } from './plan-examples.ts';
import { OPEN_ORDERS, planOf, runPlan, type JsonRecord } from './run-value-examples.ts';

type RecordedRun = { readonly state: string; readonly resultHash: string; readonly manifestHash: string | null };
type RecordedHashes = { readonly plans: Readonly<Record<string, string>>; readonly runs: Readonly<Record<string, RecordedRun>> };

const recorded = (): RecordedHashes => JSON.parse(readFileSync(join(GOLDEN, 'closed-language', 'hashes.json'), 'utf8'));

const parsePlan = defaultParser();

test('a plan hash is recorded for every golden plan, and only for those', { criterion: 'AC-SPEC-36-03' }, () => {
  const names = goldenPlanNames();
  assert.ok(names.length >= 20, `only ${names.length} golden plans`);
  assert.deepEqual(Object.keys(recorded().plans).sort(), [...names]);
});

for (const name of goldenPlanNames()) {
  test(`the golden plan "${name}" parses to exactly the plan it gave before 1.3, by plan hash`, { criterion: 'AC-SPEC-36-03' }, () => {
    const parsed = parsePlan(goldenPlan(name));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(planHash(parsed.value), recorded().plans[name]);
  });
}

test('every golden plan keeps the version it declares once parsed', { criterion: 'AC-SPEC-36-03' }, () => {
  for (const name of goldenPlanNames()) {
    const declared = goldenPlan(name)['version'];
    const parsed = parsePlan(goldenPlan(name));
    assert.ok(parsed.ok, name);
    assert.equal(parsed.value.version, declared, name);
    assert.ok(declared === '1.1' || declared === '1.2', `${name} declares ${String(declared)}: golden/plans/ holds closed plans only`);
  }
});

// The runs whose hashes were recorded, by name.
const RECORDED_RUNS: Readonly<Record<string, () => JsonRecord>> = {
  'open-orders': () => planOf([OPEN_ORDERS]),
  signup: () => goldenPlan('signup'),
  'order-page-by-path': () => goldenPlan('order-page-by-path'),
  'order-backend-state': () => goldenPlan('order-backend-state'),
};

test('a run hash is recorded for every run below', { criterion: 'AC-SPEC-36-03' }, () => {
  assert.deepEqual(Object.keys(recorded().runs).sort(), Object.keys(RECORDED_RUNS).sort());
});

for (const [name, plan] of Object.entries(RECORDED_RUNS)) {
  test(`a run of "${name}" gives the state, result hash and manifest hash it gave before 1.3`, { criterion: 'AC-SPEC-36-03' }, async () => {
    const { result } = await runPlan(plan());
    assert.deepEqual({ state: result.state, resultHash: result.resultHash, manifestHash: result.manifestHash }, recorded().runs[name]);
  });
}

// Counter-example: the recorded hashes are sensitive to a one-byte change, so equal hashes above
// mean equal plans and runs.
test('a one-character change to a golden plan\'s title changes its plan hash, and another seed changes a run\'s hashes', { criterion: 'AC-SPEC-36-03' }, async () => {
  const changed = { ...goldenPlan('signup'), meta: { ...(goldenPlan('signup')['meta'] as JsonRecord), title: 'Sign-up happy path!' } };
  const parsed = parsePlan(changed);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.notEqual(planHash(parsed.value), recorded().plans['signup']);
  const { result } = await runPlan(planOf([OPEN_ORDERS]), { seed: 8 });
  assert.notEqual(result.resultHash, recorded().runs['open-orders']?.resultHash);
});

test('a closed run\'s result and manifest hold no unsafe field at all, not even an empty one', { criterion: 'AC-SPEC-36-03' }, async () => {
  for (const [name, plan] of Object.entries(RECORDED_RUNS)) {
    const { result } = await runPlan(plan());
    assert.equal(Object.hasOwn(result, 'unsafeFeatures'), false, name);
    if (result.manifest === null) continue;
    assert.equal(Object.hasOwn(result.manifest, 'unsafeFeatures'), false, name);
    assert.equal(Object.hasOwn(result.manifest, 'unsafeDeclarations'), false, name);
  }
});
