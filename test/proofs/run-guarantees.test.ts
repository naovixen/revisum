// Proofs that the run's promises are structural or checked, not hoped for: replay, AI containment,
// the logging manifest, redaction, no target substitution and deterministic release notes.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  LOGGING_MANIFEST, LoggingManifestViolation, SENSITIVE_PLACEHOLDER, defaultRedactor, failure, manifestLogger,
  planWithAi, releaseNoteDraft, runUntrusted, writeReleaseNotes,
  type AiPlanner, type AiWriter, type Box, type BrowserDriver, type RunResult, type Step,
} from '@revisum/engine';
import { hostilePlans } from '../support/hostile-plans.ts';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { decodePng } from '../support/png-decoder.ts';
import {
  CONTRACT_TARGETS, EMAIL, FIXED_TIME_MILLISECONDS, NAME, SEED,
  harness, makeDrivers, signupPlan, stepsPlan, type Harness,
} from '../support/signup-harness.ts';

let testHarness: Harness;
before(async () => { testHarness = await harness(); });
after(async () => { await testHarness.close(); });

// A driver that counts every call. If containment works, it is never called.
function spyDriver(id: string): BrowserDriver & { calls: number } {
  const spy = {
    calls: 0,
    info: { id, version: 'spy', protocol: 'none' },
    supports() { spy.calls++; return { ok: true as const, value: true as const }; },
    async open() { spy.calls++; return failure({ reason: 'launch-failed' as const, detail: 'spy never launches' }); },
  };
  return spy;
}
const spyPorts = (drivers: ReadonlyMap<string, BrowserDriver>) => ({
  drivers, clock: systemClock, artifacts: { put: async () => { throw new Error('no side effects allowed'); } },
  redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
});

// ---- (a) Replay ---------------------------------------------------------------------------------

describe('(a) replay: same manifest, same result hash', () => {
  for (const targetId of CONTRACT_TARGETS) {
    test(`${targetId}: two runs give identical manifest, result hash and event log`, { criterion: 'AC-SPEC-00-01' }, async () => {
      const plan = testHarness.plan(signupPlan([targetId]));
      const first = await testHarness.run(plan, targetId);
      const second = await testHarness.run(plan, targetId);
      assert.equal(first.result.state, 'Passed');
      assert.equal(first.result.manifestHash, second.result.manifestHash);
      const screenshotHashes = (result: RunResult) => result.steps.map((step) => step.artifact?.sha256 ?? step.outcome);
      assert.deepEqual(screenshotHashes(first.result), screenshotHashes(second.result), 'screenshot hashes match');
      const withoutTimings = (events: readonly object[]) =>
        events.map(({ durationMilliseconds: _duration, ...rest }: { durationMilliseconds?: number }) => rest);
      assert.deepEqual(withoutTimings(first.events.read()), withoutTimings(second.events.read()));
      assert.ok(first.result.resultHash === second.result.resultHash, 'result hashes are identical');
    });
  }

  test('the manifest pins plan, target, adapter, browser, seeds, clock, fixtures, host and engine version', { criterion: 'AC-SPEC-00-01' }, async () => {
    const { result } = await testHarness.run(testHarness.plan(stepsPlan(['playwright-chromium'], [])), 'playwright-chromium');
    const manifest = result.manifest;
    assert.ok(manifest);
    assert.deepEqual(Object.keys(manifest).sort(), [
      'adapter', 'browser', 'clock', 'engineVersion', 'fixtures', 'host', 'nonHermeticInputs', 'planHash', 'schema', 'seeds', 'target',
    ]);
    assert.equal(manifest.seeds.random, SEED);
    assert.equal(manifest.clock.fixedTimeMilliseconds, FIXED_TIME_MILLISECONDS);
    assert.equal(manifest.fixtures.length, 4);
    assert.deepEqual(manifest.nonHermeticInputs, []);
  });
});

// ---- (b) AI containment -------------------------------------------------------------------------

describe('(b) AI containment: hostile plans are rejected before any side effect', () => {
  test('every hostile plan is rejected with the expected code and the driver is never touched', { criterion: 'AC-SPEC-00-01' }, async () => {
    const spies = [spyDriver('playwright'), spyDriver('cdp')];
    const ports = spyPorts(new Map(spies.map((spy) => [spy.info.id, spy])));
    const hostile = hostilePlans(testHarness.server.origin);
    for (const plan of hostile) {
      const outcome = await runUntrusted(plan.input, testHarness.parse, testHarness.base(), ports);
      assert.ok(!Array.isArray(outcome) && 'errors' in outcome, `${plan.name}: rejected`);
      assert.ok(outcome.errors.some((error) => error.code === plan.code), `${plan.name}: expected ${plan.code}, got ${JSON.stringify(outcome.errors)}`);
    }
    const driverCalls = spies.reduce((total, spy) => total + spy.calls, 0);
    assert.equal(driverCalls, 0, 'no driver method was called');
    assert.ok(hostile.length >= 12);
  });

  test('positive control: a valid plan does reach the (spy) driver', { criterion: 'AC-SPEC-00-01' }, async () => {
    const spy = spyDriver('playwright');
    const outcome = await runUntrusted(signupPlan(['playwright-chromium']), testHarness.parse, testHarness.base(), spyPorts(new Map([['playwright', spy]])));
    assert.ok(Array.isArray(outcome));
    assert.equal(outcome[0]?.state, 'TargetUnavailable');
    assert.equal(spy.calls, 2);
  });

  test('an AI planner\'s output is only usable after parsing', { criterion: 'AC-SPEC-00-01' }, async () => {
    const hostile: AiPlanner = { propose: async () => ({ ...signupPlan(['playwright-chromium']), steps: [{ type: 'eval', code: '1' }] }) };
    const honest: AiPlanner = { propose: async () => signupPlan(['playwright-chromium']) };
    const throws: AiPlanner = { propose: async () => { throw new Error('model refused'); } };
    const spec = { specReference: 'specs/signup.md', text: 'A user can sign up.' };
    assert.equal((await planWithAi(hostile, spec, testHarness.parse)).ok, false);
    assert.equal((await planWithAi(throws, spec, testHarness.parse)).ok, false);
    assert.equal((await planWithAi(honest, spec, testHarness.parse)).ok, true);
  });

  test('errors never echo the hostile value', { criterion: 'AC-SPEC-00-01' }, async () => {
    const parsed = testHarness.parse({ ...signupPlan(['playwright-chromium']), meta: { featureId: 'X-1', specReference: 's', title: '<script>steal()</script>' } });
    assert.ok(!parsed.ok);
    assert.ok(!JSON.stringify(parsed.error).includes('steal'));
  });
});

// ---- (c) Logging manifest -----------------------------------------------------------------------

describe('(c) logging manifest', () => {
  test('a non-manifest field is rejected at run time (and at compile time: compile-time-guarantees.ts)', { criterion: 'AC-SPEC-00-01' }, () => {
    const logger = manifestLogger(memoryRunEventSink(), defaultRedactor(), 'run');
    const smuggled: Record<string, unknown> = { kind: 'step.end', email: EMAIL };
    assert.throws(() => logger.log(smuggled as never), LoggingManifestViolation);
  });

  test('every event of a real run uses only manifest fields and contains no typed value', { criterion: 'AC-SPEC-00-01' }, async () => {
    const { events } = await testHarness.run(testHarness.plan(signupPlan(['playwright-chromium'])), 'playwright-chromium');
    const allowed = new Set(Object.keys(LOGGING_MANIFEST));
    for (const event of events.read()) for (const key of Object.keys(event)) assert.ok(allowed.has(key), `field ${key}`);
    const everything = JSON.stringify(events.read());
    assert.ok(!everything.includes(EMAIL) && !everything.includes(NAME));
  });
});

// ---- (d) Redaction ------------------------------------------------------------------------------

function blackFraction(png: Uint8Array, box: Box): number {
  const image = decodePng(png);
  let black = 0;
  let total = 0;
  for (let y = Math.ceil(box.y) + 2; y < Math.floor(box.y + box.height) - 2; y++) {
    for (let x = Math.ceil(box.x) + 2; x < Math.floor(box.x + box.width) - 2; x++) {
      const index = (y * image.width + x) * image.channels;
      total++;
      if (image.data[index] === 0 && image.data[index + 1] === 0 && image.data[index + 2] === 0) black++;
    }
  }
  return total === 0 ? 0 : black / total;
}

describe('(d) redaction by default', () => {
  for (const targetId of CONTRACT_TARGETS) {
    test(`${targetId}: PII fields are solid black in screenshots, and visible without the mask`, { criterion: 'AC-SPEC-00-01' }, async () => {
      const target = testHarness.project.matrix.find((candidate) => candidate.id === targetId);
      assert.ok(target);
      const driver = makeDrivers().get(target.adapter);
      assert.ok(driver);
      const redactor = defaultRedactor();
      const opened = await driver.open(target, {
        baseUrl: testHarness.server.origin, allowedOrigins: testHarness.project.origins, seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: redactor.selectors, timeoutMilliseconds: 2000,
      });
      assert.ok(opened.ok);
      const session = opened.value;
      try {
        const plan = testHarness.plan(stepsPlan([targetId], [
          { type: 'fill', locator: { by: 'label', label: 'Full name' }, value: NAME },
          { type: 'fill', locator: { by: 'label', label: 'Email' }, value: EMAIL },
        ]));
        assert.ok((await session.navigate(`${testHarness.server.origin}/`)).ok);
        // Steps 1 and 2 are the two fills; the probe plan adds a final check after them.
        for (const step of plan.steps.slice(1, 3) as Extract<Step, { type: 'fill' }>[]) {
          assert.ok((await session.act(step)).ok);
        }
        const boxes = await Promise.all(plan.steps.slice(1, 3).map(async (step) => (await session.probe((step as Extract<Step, { type: 'fill' }>).locator)).box));
        const masked = await session.screenshot(redactor.selectors);
        const unmasked = await session.screenshot([]);
        for (const box of boxes) {
          assert.ok(box);
          assert.equal(blackFraction(masked, box), 1, 'masked region is fully black');
          assert.ok(blackFraction(unmasked, box) < 0.5, 'control: region is not black without the mask');
        }
      } finally {
        await session.close();
      }
    });

    test(`${targetId}: PII text never reaches events or results`, { criterion: 'AC-SPEC-00-01' }, async () => {
      const fill = [
        { type: 'fill', locator: { by: 'label', label: 'Full name' }, value: NAME },
        { type: 'fill', locator: { by: 'label', label: 'Email' }, value: EMAIL },
        { type: 'click', locator: { by: 'role', role: 'checkbox', name: 'I agree to the terms' } },
        { type: 'click', locator: { by: 'role', role: 'button', name: 'Create account' } },
        { type: 'capture', name: 'after-submit' },
      ];
      const echo = await testHarness.run(testHarness.plan(stepsPlan([targetId], [...fill,
        { type: 'expect', locator: { by: 'testId', testId: 'echo' }, assert: { kind: 'textEquals', value: 'deliberately wrong' } }])), targetId);
      const status = await testHarness.run(testHarness.plan(stepsPlan([targetId], [...fill,
        { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'textEquals', value: 'deliberately wrong' } }])), targetId);
      assert.equal(echo.result.steps.at(-1)?.observed, 'Signed up as [redacted:email]');
      assert.equal(status.result.steps.at(-1)?.observed, SENSITIVE_PLACEHOLDER);
      for (const ran of [echo, status]) {
        const everything = JSON.stringify([ran.result, ran.events.read()]);
        assert.ok(!everything.includes(EMAIL), 'email absent');
        assert.ok(!everything.includes(NAME), 'name absent');
      }
    });
  }
});

// ---- (e) No silent target substitution ----------------------------------------------------------

describe('(e) targets are never substituted', () => {
  test('unsupported device and unregistered adapter become explicit TargetUnavailable results', { criterion: 'AC-SPEC-00-01' }, async () => {
    const plan = testHarness.plan(stepsPlan(['playwright-firefox-phone', 'appium-android'], []));
    const phone = await testHarness.run(plan, 'playwright-firefox-phone');
    const appium = await testHarness.run(plan, 'appium-android');
    assert.equal(phone.result.state, 'TargetUnavailable');
    assert.equal(phone.result.unavailable?.reason, 'device-not-supported');
    assert.equal(appium.result.state, 'TargetUnavailable');
    assert.equal(appium.result.unavailable?.reason, 'adapter-not-registered');
    assert.equal(phone.store.references().length + appium.store.references().length, 0);
  });

  test('a target missing from the plan is refused even if it is in the matrix', { criterion: 'AC-SPEC-00-01' }, async () => {
    const plan = testHarness.plan(stepsPlan(['playwright-chromium'], []));
    const ran = await testHarness.run(plan, 'playwright-webkit');
    assert.equal(ran.result.state, 'TargetUnavailable');
    assert.equal(ran.result.unavailable?.reason, 'not-declared');
  });
});

// ---- (f) Release artefacts ----------------------------------------------------------------------

describe('(f) release artefacts', () => {
  test('the release-note draft is deterministic, value-free and never replaced by AI', { criterion: 'AC-SPEC-00-01' }, async () => {
    const plan = testHarness.plan(signupPlan(['playwright-chromium']));
    const first = await testHarness.run(plan, 'playwright-chromium');
    const second = await testHarness.run(plan, 'playwright-chromium');
    const draft = releaseNoteDraft(plan, [first.result]);
    assert.equal(draft, releaseNoteDraft(plan, [second.result]), 'byte-identical drafts');
    assert.ok(!draft.includes(EMAIL) && !draft.includes(NAME), 'no typed values');
    assert.ok(draft.includes('image-alt'));

    const store = memoryArtifactStore();
    const polite: AiWriter = { suggest: async (text) => `${text}\n\nNow with friendlier wording.` };
    const written = await writeReleaseNotes(plan, [first.result], store, polite);
    assert.equal(new TextDecoder().decode(store.get('release-notes.md')), draft, 'draft stored unchanged');
    assert.equal(written.suggestion?.name, 'release-notes.suggestion.md');

    for (const [writer, reason] of [
      [{ suggest: async () => ({ markdown: 'object, not text' }) }, 'not-text'],
      [{ suggest: async () => 'Great release! <script>steal()</script>' }, 'unsafe-text'],
      [{ suggest: async () => { throw new Error('model down'); } }, 'writer-error'],
    ] as const) {
      const rejectingStore = memoryArtifactStore();
      const outcome = await writeReleaseNotes(plan, [first.result], rejectingStore, writer);
      assert.equal(outcome.suggestionRejected, reason);
      assert.equal(rejectingStore.references().length, 1, 'only the deterministic draft is stored');
    }
  });
});
