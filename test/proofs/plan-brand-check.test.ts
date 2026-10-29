// The type system stops a forged Plan at compile time, but a cast defeats it. So run() checks the
// brand again at run time, first: an object that looks like a plan but was not made by the plan
// parser is refused before any driver call, log entry or stored artefact.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import {
  assertBranded, defaultRedactor, failure, planParser, run,
  type Authorised, type BrowserDriver, type Plan, type TargetId,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { ORIGIN, TARGET_ID, signupPlan, testProject, testProjectInput } from '../unit/engine/plan-examples.ts';

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

type Watched = { readonly ports: Parameters<typeof run>[1]; readonly driverCalls: () => number; readonly storeWrites: () => number };

function watchedPorts(): Watched {
  let driverCalls = 0;
  let storeWrites = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { driverCalls++; return { ok: true, value: true }; },
    async open() { driverCalls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const store = memoryArtifactStore();
  const events = memoryRunEventSink();
  return {
    ports: {
      drivers: new Map([['playwright', spy]]), clock: systemClock, redactor: defaultRedactor(), audit: memoryEventSink(), events,
      artifacts: { put: async (name, bytes, mediaType) => { storeWrites++; return store.put(name, bytes, mediaType); } },
    },
    driverCalls: () => driverCalls,
    storeWrites: () => storeWrites,
  };
}

// The parser's own output, cleared through the policy gate as every run requires.
const authorisedPlan = async (): Promise<Authorised> => authorise(genuinePlan(), await trustedProjectFrom(testProjectInput()));

const inputs = (plan: Authorised) => ({
  plan, project, targetId: TARGET_ID as TargetId, baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0,
  fixtures: [], host: { platform: platform(), arch: arch() },
});

for (const [name, forge] of FORGERIES) {
  test(`run() refuses ${name} before any side effect`, { criterion: 'AC-SPEC-01-05' }, async () => {
    const watched = watchedPorts();
    // The forgery is cast past the gate too: the run-time check must catch it all the same.
    await assert.rejects(run(inputs(forge() as Authorised), watched.ports));
    assert.equal(watched.driverCalls(), 0, 'no driver method was called');
    assert.equal(watched.ports.events.read().length, 0, 'nothing was logged');
    assert.equal(watched.storeWrites(), 0, 'nothing was stored');
  });

  test(`assertBranded rejects ${name}`, { criterion: 'AC-SPEC-01-05' }, () => {
    assert.throws(() => assertBranded(forge()));
  });
}

test('assertBranded rejects values that are not plans at all', { criterion: 'AC-SPEC-01-05' }, () => {
  for (const value of [null, undefined, 'plan', 42, [], {}]) assert.throws(() => assertBranded(value), `accepted ${JSON.stringify(value)}`);
});

// Counter-examples: the parser's own output passes the check and reaches the driver, so the
// refusals above come from the forgery, not from the run being broken.
test('assertBranded accepts a plan made by the parser', { criterion: 'AC-SPEC-01-05' }, () => {
  assert.doesNotThrow(() => assertBranded(genuinePlan()));
});

test('run() accepts a plan made by the parser and reaches the driver', { criterion: 'AC-SPEC-01-05' }, async () => {
  const watched = watchedPorts();
  const result = await run(inputs(await authorisedPlan()), watched.ports);
  assert.equal(result.state, 'TargetUnavailable', 'the spy driver cannot launch, so the target is unavailable');
  assert.ok(watched.driverCalls() > 0, 'the driver was asked to open a session');
  assert.ok(watched.ports.events.read().length > 0, 'the run was logged');
});

test('a parser-made plan passes the check each time it is run', { criterion: 'AC-SPEC-01-05' }, async () => {
  const plan = await authorisedPlan();
  for (let attempt = 0; attempt < 2; attempt++) {
    const watched = watchedPorts();
    await run(inputs(plan), watched.ports);
    assert.ok(watched.driverCalls() > 0, `run ${attempt + 1} reached the driver`);
  }
});
