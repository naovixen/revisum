// A run's result claims egress control only when whoever started the run says the runner enforced
// it. RunInputs.guaranteeLevel is set from Runner.guaranteeLevel(); only 'isolated' makes the result
// state that egress was enforced. Without it, or at 'host', the result is what every committed
// hash already holds. Each test reads the real result of a real run, on a recording driver.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GuaranteeLevel } from '@revisum/contracts';
import { defaultRedactor, guaranteeStatement, parseProject, planParser, run, type RunResult } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { ORIGIN } from './plan-examples.ts';
import { DEFAULT_CLOCK_START, DEFAULT_SEED, OPEN_ORDERS, accepted, planOf, projectFileWith, recordingDriver } from './run-value-examples.ts';

// Runs one plan on the shared test project, at the level given, or with no level at all.
async function runAt(level?: GuaranteeLevel): Promise<RunResult> {
  const projectFile = projectFileWith();
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const project = parsed.value;
  const plan = accepted(planParser(project), planOf([OPEN_ORDERS]));
  const trusted = await trustedProjectFrom(projectFile);
  const target = project.matrix[0];
  assert.ok(target !== undefined, 'the test project has a target');
  const { driver } = recordingDriver();
  return run({
    plan: authorise(plan, trusted), project, targetId: target.id, baseUrl: ORIGIN, seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START,
    fixtures: [], host: { platform: 'test', arch: 'test' }, ...(level === undefined ? {} : { guaranteeLevel: level }),
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(),
    audit: memoryEventSink(), events: memoryRunEventSink(),
  });
}

const statementWith = (egressEnforced: boolean) => guaranteeStatement({ mode: 'plan', egressEnforced, unmaskedScreenshotsKept: false, unsafeFeatures: [] });

test('a run started at the isolated level states that egress was enforced', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { guarantees, state } = await runAt('isolated');
  assert.equal(state, 'Passed');
  assert.deepEqual(guarantees, statementWith(true));
  assert.equal(guarantees.level, 'isolated');
  assert.ok(guarantees.holds.includes('egress-enforced'));
  assert.ok(guarantees.holds.includes('no-ambient-credentials'));
  assert.ok(!guarantees.lost.some((loss) => loss.because === 'egress-unenforceable'), JSON.stringify(guarantees.lost));
});

test('counter-example: a run started at the host level loses egress to egress-unenforceable and claims no isolation', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { guarantees, state } = await runAt('host');
  assert.equal(state, 'Passed');
  assert.deepEqual(guarantees, statementWith(false));
  assert.equal(guarantees.level, 'host');
  assert.ok(!guarantees.holds.includes('egress-enforced'));
  assert.ok(guarantees.lost.some((loss) => loss.guarantee === 'egress-enforced' && loss.because === 'egress-unenforceable'), JSON.stringify(guarantees.lost));
});

test('a run given no level claims what a host run claims, so no one has to say host for the claim to be safe', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { guarantees } = await runAt();
  assert.deepEqual(guarantees, statementWith(false));
});

test('a run given no level has the very hashes of a host run, so committed hashes stay valid', { criterion: 'AC-SPEC-07-05' }, async () => {
  const unset = await runAt();
  const host = await runAt('host');
  assert.equal(unset.resultHash, host.resultHash);
  assert.equal(unset.manifestHash, host.manifestHash);
});

test('the level a run claims is part of its result hash, so the claim cannot be changed unnoticed', { criterion: 'AC-SPEC-07-05' }, async () => {
  const isolated = await runAt('isolated');
  const host = await runAt('host');
  assert.notEqual(isolated.resultHash, host.resultHash);
});
