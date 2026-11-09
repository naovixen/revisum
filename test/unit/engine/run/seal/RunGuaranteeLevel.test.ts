// A run's result claims egress control only when its isolation port says the runner enforced it.
// Only 'isolated' makes the result state that egress was enforced. At 'host', and with the host's
// own isolation, the result is what every committed hash already holds. Each test reads the real
// result of a real run, on a recording driver.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunIsolation } from '@revisum/contracts';
import { createRunService, HOST_ISOLATION, guaranteeStatement, parseProject, planParser, type RunResult } from '@revisum/engine';
import { baseUrlOf, clearRun, trustedProjectFrom } from '../../../../support/builders/ClearRun.ts';
import { ORIGIN } from '../../plan/examples/GoldenPlan.ts';
import { DEFAULT_CLOCK_START, DEFAULT_SEED, OPEN_ORDERS, accepted, planOf, projectFileWith, recordingDriver } from '../values/examples/RunPlan.ts';
import { driversOf, fakePorts } from '#test-support/fakes/FakePorts.ts';
import { fakeRunIsolation } from '#test-support/fakes/session/FakeRunIsolation.ts';
import { RunMode } from '@revisum/contracts';

// Runs one plan on the shared test project, isolated as the port given says.
async function runWith(isolation: RunIsolation): Promise<RunResult> {
  const projectFile = projectFileWith();
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const project = parsed.value;
  const plan = accepted(planParser(project), planOf([OPEN_ORDERS]));
  const trusted = await trustedProjectFrom(projectFile);
  const target = project.matrix[0];
  assert.ok(target !== undefined, 'the test project has a target');
  const { driver } = recordingDriver();
  return createRunService(fakePorts({ drivers: driversOf(driver), isolation })).run(clearRun(plan, trusted, target.id), { baseUrl: baseUrlOf(ORIGIN), seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START,
    fixtures: [], host: { platform: 'test', arch: 'test' },
  });
}

const statementWith = (egressEnforced: boolean) => guaranteeStatement({ mode: RunMode.Plan, egressEnforced, unmaskedScreenshotsKept: false, unsafeFeatures: [] });

test('a run started at the isolated level states that egress was enforced', async () => {
  const { guarantees, state } = await runWith(fakeRunIsolation('isolated'));
  assert.equal(state, 'Passed');
  assert.deepEqual(guarantees, statementWith(true));
  assert.equal(guarantees.level, 'isolated');
  assert.ok(guarantees.holds.includes('egress-enforced'));
  assert.ok(guarantees.holds.includes('no-ambient-credentials'));
  assert.ok(!guarantees.lost.some((loss) => loss.because === 'egress-unenforceable'), JSON.stringify(guarantees.lost));
});

test('counter-example: a run started at the host level loses egress to egress-unenforceable and claims no isolation', async () => {
  const { guarantees, state } = await runWith(fakeRunIsolation('host'));
  assert.equal(state, 'Passed');
  assert.deepEqual(guarantees, statementWith(false));
  assert.equal(guarantees.level, 'host');
  assert.ok(!guarantees.holds.includes('egress-enforced'));
  assert.ok(guarantees.lost.some((loss) => loss.guarantee === 'egress-enforced' && loss.because === 'egress-unenforceable'), JSON.stringify(guarantees.lost));
});

test('a run handed the host isolation claims what a host-level run claims', async () => {
  const { guarantees } = await runWith(HOST_ISOLATION);
  assert.deepEqual(guarantees, statementWith(false));
});

test('a run handed the host isolation has the very hashes of a host-level run, so committed hashes stay valid', async () => {
  const hostIsolation = await runWith(HOST_ISOLATION);
  const host = await runWith(fakeRunIsolation('host'));
  assert.equal(hostIsolation.resultHash, host.resultHash);
  assert.equal(hostIsolation.manifestHash, host.manifestHash);
});

test('the level a run claims is part of its result hash, so the claim cannot be changed unnoticed', async () => {
  const isolated = await runWith(fakeRunIsolation('isolated'));
  const host = await runWith(fakeRunIsolation('host'));
  assert.notEqual(isolated.resultHash, host.resultHash);
});
