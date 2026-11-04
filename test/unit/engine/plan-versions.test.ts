// The plan language has one version. A plan declaring any other, older or newer, is rejected, never
// run with the parts this engine reads differently skipped: a skipped check would turn into a
// silent pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arch, platform } from 'node:os';
import { runUntrusted } from '@revisum/engine';
import {
  CURRENT_VERSION, ORIGIN, accountClosurePlan, defaultParser, signupPlan, stepsOf, testProject, withValue,
  type JsonRecord,
} from './plan-examples.ts';
import { fakeDriverNeverLaunching } from '#test-support/fakes/FakeDriver.ts';
import { driversOf, fakePorts } from '#test-support/fakes/FakePorts.ts';
import { futureVersions } from '../../support/plan-changelog.ts';

const parsePlan = defaultParser();

// Step types a later language version or a later phase may add. The running engine knows none.
const NEWER_STEPS: readonly JsonRecord[] = [
  { type: 'popup', locator: { by: 'role', role: 'button', name: 'Open help' } },
  { type: 'switchPage', index: 1 },
  { type: 'drag', locator: { by: 'label', label: 'Card' }, to: { by: 'label', label: 'Done' } },
];

const insertAt = (plan: JsonRecord, index: number, step: JsonRecord): JsonRecord => {
  const steps = [...stepsOf(plan)];
  steps.splice(index, 0, step);
  return { ...plan, steps };
};

// ---- Any other declared version -----------------------------------------------------------------

for (const version of [...futureVersions(), '1.2', '1.1', '1']) {
  test(`rejects a plan that declares the version ${version} with version_unsupported`, () => {
    const parsed = parsePlan({ ...signupPlan(), version });
    assert.deepEqual(parsed, { ok: false, error: [{ code: 'version_unsupported', path: '$.version' }] });
  });
}

test('accepts the same plan at the version the engine runs', () => {
  const parsed = parsePlan({ ...signupPlan(), version: CURRENT_VERSION });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

// ---- A newer step in a current plan -------------------------------------------------------------

for (const step of NEWER_STEPS) {
  test(`rejects a plan containing the newer step "${String(step['type'])}" rather than skipping it`, () => {
    const parsed = parsePlan(insertAt(signupPlan(), 8, step));
    assert.deepEqual(parsed, { ok: false, error: [{ code: 'unknown_step', path: '$.steps[8].type' }] });
  });
}

test('rejects a newer step nested inside a frame rather than skipping it', () => {
  const frameSteps = [...(stepsOf(accountClosurePlan())[3]?.['steps'] as JsonRecord[]), NEWER_STEPS[0]];
  const parsed = parsePlan(withValue(accountClosurePlan(), ['steps', 3, 'steps'], frameSteps));
  assert.deepEqual(parsed, { ok: false, error: [{ code: 'unknown_step', path: '$.steps[3].steps[2].type' }] });
});

test('rejects a newer step even when it comes after every assertion', () => {
  const plan = signupPlan();
  const parsed = parsePlan(insertAt(plan, stepsOf(plan).length, { type: 'popup', locator: { by: 'text', text: 'Receipt' } }));
  assert.deepEqual(parsed, { ok: false, error: [{ code: 'unknown_step', path: `$.steps[${stepsOf(plan).length}].type` }] });
});

// Counter-example: without the newer step, every step the author wrote is kept, in order.
test('a plan without newer steps keeps every step, in order', () => {
  const plan = accountClosurePlan();
  const parsed = parsePlan(plan);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.value.steps.map((step) => step.type), stepsOf(plan).map((step) => step['type']));
});

// ---- At run time --------------------------------------------------------------------------------

test('a run of a plan with a newer step is refused before any driver is touched', async () => {

  const spy = fakeDriverNeverLaunching();
  const project = testProject();
  const ports = fakePorts({ drivers: driversOf(spy) });
  const base = {
    project, baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
  };
  const parse = defaultParser();
  const refused = await runUntrusted(insertAt(signupPlan(), 8, NEWER_STEPS[1] ?? {}), parse, base, ports);
  assert.ok(!Array.isArray(refused) && 'errors' in refused, 'the run was refused');
  assert.equal(spy.calls.count(), 0, 'no driver method was called');
  assert.equal(ports.events.read().length, 0, 'nothing was logged');

  // Positive control: the plan without the newer step does reach the driver.
  const accepted = await runUntrusted(signupPlan(), parse, base, ports);
  assert.ok(Array.isArray(accepted), JSON.stringify(accepted));
  assert.ok(spy.calls.count() > 0, 'a valid plan reaches the driver, so the zero above is meaningful');
});
