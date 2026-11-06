// The type system stops a forged Plan at compile time, but a cast defeats it. So run() checks the
// brand again at run time, first: an object that looks like a plan but was not made by the plan
// parser is refused before any driver call, log entry or stored artefact. run() takes only a run the
// gate cleared, so each forgery is cast past the gate's own types and cleared by it, which is the one
// way a cast can put one inside a cleared run.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { assertBranded, planParser, run, type ClearedRun, type Plan, type TargetId } from '@revisum/engine';
import { baseUrlOf, clearRun, trustedProjectFrom } from '../support/policy-clearance.ts';
import { ORIGIN, TARGET_ID, signupPlan, testProject, testProjectInput } from '../unit/engine/plan-examples.ts';
import { fakeArtifactStore } from '#test-support/fakes/FakeArtifactStore.ts';
import { fakeDriverNeverLaunching } from '#test-support/fakes/FakeDriver.ts';
import { driversOf, fakePorts } from '#test-support/fakes/FakePorts.ts';

const project = testProject();
const parsePlan = planParser(project);

function genuinePlan(): Plan {
  const parsed = parsePlan(signupPlan());
  if (!parsed.ok) throw new Error(`the sign-up plan was rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// Every way a caller might build a plan-shaped object without the parser. Each is cast to Plan,
// which is exactly what the run-time check exists to catch.
const FORGERIES: readonly (readonly [string, () => Plan])[] = [
  ['raw JSON from disk, cast to Plan', () => signupPlan() as unknown as Plan],
  ['raw JSON with a hand-written brand field', () => ({ ...signupPlan(), __brand: 'Plan' }) as unknown as Plan],
  ['a spread copy of a parsed plan', () => ({ ...genuinePlan() }) as Plan],
  ['a structured clone of a parsed plan', () => structuredClone(genuinePlan())],
  ['a JSON round trip of a parsed plan', () => JSON.parse(JSON.stringify(genuinePlan())) as Plan],
  ['an object whose prototype is a parsed plan', () => Object.create(genuinePlan()) as Plan],
  ['a parsed plan with its steps swapped for raw ones', () => ({ ...genuinePlan(), steps: [{ type: 'navigate', url: '/' }] }) as unknown as Plan],
];

// The brand check's own refusal. A later check refuses most forgeries too, so only the reason shows
// that this one stopped them first.
const REFUSED_AS_NOT_PARSED = { name: 'TypeError', message: 'refused a plan that the plan parser did not make' };

type Watched = { readonly ports: Parameters<typeof run>[2]; readonly driverCalls: () => number; readonly storeWrites: () => number };

function watchedPorts(): Watched {
  const spy = fakeDriverNeverLaunching();
  const artifacts = fakeArtifactStore();
  return {
    ports: fakePorts({ drivers: driversOf(spy), artifacts }),
    driverCalls: () => spy.calls.count(),
    storeWrites: () => artifacts.calls.count('put'),
  };
}

// The plan cleared through the policy gate as every run requires.
const clearedRunOf = async (plan: Plan): Promise<ClearedRun> => clearRun(plan, await trustedProjectFrom(testProjectInput()), TARGET_ID as TargetId);
const clearedRun = (): Promise<ClearedRun> => clearedRunOf(genuinePlan());

const INPUTS = {
  baseUrl: baseUrlOf(ORIGIN), seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
};

for (const [name, forge] of FORGERIES) {
  test(`run() refuses ${name} before any side effect`, async () => {
    const watched = watchedPorts();
    const cleared = await clearedRunOf(forge());
    await assert.rejects(run(cleared, INPUTS, watched.ports), REFUSED_AS_NOT_PARSED);
    assert.equal(watched.driverCalls(), 0, 'no driver method was called');
    assert.equal(watched.ports.events.read().length, 0, 'nothing was logged');
    assert.equal(watched.storeWrites(), 0, 'nothing was stored');
  });

  test(`assertBranded rejects ${name}`, () => {
    assert.throws(() => assertBranded(forge()), REFUSED_AS_NOT_PARSED);
  });
}

test('assertBranded rejects values that are not plans at all', () => {
  for (const value of [null, undefined, 'plan', 42, [], {}]) assert.throws(() => assertBranded(value), REFUSED_AS_NOT_PARSED, `accepted ${JSON.stringify(value)}`);
});

// Counter-examples: the parser's own output passes the check and reaches the driver, so the
// refusals above come from the forgery, not from the run being broken.
test('assertBranded accepts a plan made by the parser', () => {
  assert.doesNotThrow(() => assertBranded(genuinePlan()));
});

test('run() accepts a plan made by the parser and reaches the driver', async () => {
  const watched = watchedPorts();
  const result = await run(await clearedRun(), INPUTS, watched.ports);
  assert.equal(result.state, 'TargetUnavailable', 'the spy driver cannot launch, so the target is unavailable');
  assert.ok(watched.driverCalls() > 0, 'the driver was asked to open a session');
  assert.ok(watched.ports.events.read().length > 0, 'the run was logged');
});

test('a parser-made plan passes the check each time it is run', async () => {
  const cleared = await clearedRun();
  for (let attempt = 0; attempt < 2; attempt++) {
    const watched = watchedPorts();
    await run(cleared, INPUTS, watched.ports);
    assert.ok(watched.driverCalls() > 0, `run ${attempt + 1} reached the driver`);
  }
});
