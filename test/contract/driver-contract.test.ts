// The driver contract: the same tests, unchanged, against every driver and browser engine.
// A driver, hand-written or AI-generated, is substitutable only if it passes all of them.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { defaultRedactor, seededRandom, type A11yNode, type Session, type SessionEnvironment, type Step } from '@revisum/engine';
import {
  CONTRACT_TARGETS, EMAIL, FIXED_TIME_MILLISECONDS, LOCALE, SEED, TIMEZONE,
  environmentPlan, harness, makeDrivers, signupPlan, stepsPlan, type Harness,
} from '../support/signup-harness.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

let testHarness: Harness;
before(async () => { testHarness = await harness(); });
after(async () => { await testHarness.close(); });

async function withSession<Value>(targetId: string, use: (session: Session) => Promise<Value>): Promise<Value> {
  const target = testHarness.project.matrix.find((candidate) => candidate.id === targetId);
  assert.ok(target);
  const driver = makeDrivers().get(target.adapter);
  assert.ok(driver);
  const environment: SessionEnvironment = {
    baseUrl: testHarness.server.origin, allowedOrigins: testHarness.project.origins, seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
  };
  const opened = await driver.open(target, environment);
  assert.ok(opened.ok, 'session opens');
  try { return await use(opened.value); } finally { await opened.value.close(); }
}

// Parses one raw step through the real parser, so direct session calls get branded values.
function parsedStep<StepType extends Step['type']>(raw: object, type: StepType): Extract<Step, { type: StepType }> {
  const step = testHarness.plan(stepsPlan([CONTRACT_TARGETS[0]], [raw])).steps[1];
  assert.ok(step !== undefined && step.type === type);
  return step as Extract<Step, { type: StepType }>;
}

const flatten = (node: A11yNode): A11yNode[] => [node, ...node.children.flatMap(flatten)];

for (const targetId of CONTRACT_TARGETS) {
  describe(`contract: ${targetId}`, () => {
    test('runs the sign-up flow to Passed and captures two PNGs', { criterion: 'AC-SPEC-00-01' }, async () => {
      const { result, store } = await testHarness.run(testHarness.plan(signupPlan([targetId])), targetId);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps.filter((step) => step.outcome !== 'passed')));
      const shots = store.references();
      assert.deepEqual(shots.map((reference) => reference.name), [`${targetId}/form-filled.png`, `${targetId}/signed-up.png`]);
      for (const reference of shots) assert.deepEqual([...(store.get(reference.name) ?? []).slice(0, 4)], PNG_SIGNATURE);
    });

    test('pins locale, time zone, clock, randomness, motion and colour scheme', { criterion: 'AC-SPEC-00-01' }, async () => {
      const expected = {
        'env-lang': LOCALE, 'env-tz': TIMEZONE, 'env-now': new Date(FIXED_TIME_MILLISECONDS).toISOString(), 'env-hour': '19',
        'env-random': seededRandom(SEED).next().toFixed(6), 'env-motion': 'reduce', 'env-scheme': 'dark',
      };
      const { result } = await testHarness.run(testHarness.plan(environmentPlan([targetId], expected)), targetId);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps.filter((step) => step.outcome !== 'passed')));
    });

    test('a missing element fails with not-found and skips the rest', { criterion: 'AC-SPEC-00-01' }, async () => {
      const plan = testHarness.plan(stepsPlan([targetId], [
        { type: 'click', locator: { by: 'role', role: 'button', name: 'Does not exist' } },
        { type: 'capture', name: 'never' },
      ]));
      const { result } = await testHarness.run(plan, targetId);
      assert.equal(result.state, 'Failed');
      assert.equal(result.steps[1]?.code, 'not-found');
      assert.equal(result.steps[2]?.outcome, 'skipped');
    });

    test('a non-unique locator fails with ambiguous (no first-match guessing)', { criterion: 'AC-SPEC-00-01' }, async () => {
      const plan = testHarness.plan(stepsPlan([targetId], [
        { type: 'expect', locator: { by: 'role', role: 'link', name: 'Learn more' }, assert: { kind: 'visible' } },
      ]));
      const { result } = await testHarness.run(plan, targetId);
      assert.equal(result.state, 'Failed');
      assert.equal(result.steps[1]?.code, 'ambiguous');
    });

    test('the accessibility audit finds the seeded image-alt issue, and gate mode fails on it', { criterion: 'AC-SPEC-00-01' }, async () => {
      const report = await testHarness.run(testHarness.plan(stepsPlan([targetId], [{ type: 'a11yAudit', mode: 'report' }])), targetId);
      assert.equal(report.result.state, 'Passed');
      assert.deepEqual(report.result.steps[1]?.findings?.map((finding) => finding.ruleId), ['image-alt']);
      const gate = await testHarness.run(testHarness.plan(stepsPlan([targetId], [{ type: 'a11yAudit', mode: 'gate' }])), targetId);
      assert.equal(gate.result.state, 'Failed');
      assert.equal(gate.result.steps[1]?.code, 'a11y-violations');
    });

    test('blocks every origin not on the allow-list and records it', { criterion: 'AC-SPEC-00-01' }, async () => {
      const { result, events } = await testHarness.run(testHarness.plan(stepsPlan([targetId], [])), targetId);
      assert.equal(result.state, 'Passed');
      assert.deepEqual(result.blockedOrigins, ['https://tracker.example']);
      assert.ok(events.read().some((event) => event.kind === 'network.blocked' && event.origin === 'https://tracker.example'));
    });

    test('accessibility snapshot exposes the heading and named form controls', { criterion: 'AC-SPEC-00-01' }, async () => {
      const nodes = await withSession(targetId, async (session) => {
        assert.ok((await session.navigate(`${testHarness.server.origin}/`)).ok);
        return flatten(await session.accessibilitySnapshot());
      });
      const has = (role: string, name: string): boolean => nodes.some((node) => node.role === role && node.name === name);
      assert.ok(has('heading', 'Create your account'));
      assert.ok(has('textbox', 'Email'));
      assert.ok(has('button', 'Create account'));
    });

    test('probes report value, box and PII sensitivity consistently', { criterion: 'AC-SPEC-00-01' }, async () => {
      const probe = await withSession(targetId, async (session) => {
        assert.ok((await session.navigate(`${testHarness.server.origin}/`)).ok);
        const fill = parsedStep({ type: 'fill', locator: { by: 'label', label: 'Email' }, value: EMAIL }, 'fill');
        const filled = await session.act(fill);
        assert.ok(filled.ok);
        return session.probe(fill.locator);
      });
      assert.equal(probe.count, 1);
      assert.equal(probe.value, EMAIL);
      assert.equal(probe.sensitive, true);
      assert.ok(probe.box !== null && probe.box.width > 0 && probe.box.height > 0);
    });
  });
}
