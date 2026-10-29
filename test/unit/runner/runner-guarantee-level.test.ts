// The runner reports the isolated guarantee level only once the internal network, the proxy and
// the run container have all started and a probe from inside the container to an undeclared
// address outside has failed. When egress cannot be enforced, as on a CI provider whose Docker
// cannot cut a network off or lets the probe out, the level is host, the run logs
// egress-unenforceable, and the run's guarantee statement says egress is not enforced, so no report
// can claim hermetic isolation. The container engine is a fake; the probe that is blocked is the
// counter-example.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guaranteeStatement } from '@revisum/engine';
import { dockerRunner, type RunnerLogEntry } from '@revisum/runner';
import type { GuaranteeLevel } from '@revisum/contracts';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { fakeContainerEngine, type FakeEngineSettings } from './fake-container-engine.ts';
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from './runner-examples.ts';

const POLICY = egressPolicy({ allowOrigins: ['https://staging.example.test'] });

// The level is read while the run is up, before it is stopped.
type Started = { readonly level: GuaranteeLevel; readonly logged: readonly RunnerLogEntry[]; readonly startedCode: string | null };

// Starts a run on a fake engine with the given settings, notes the level and outcome, and stops it again.
async function startOn(settings: Omit<FakeEngineSettings, 'localImageId'>): Promise<Started> {
  const engine = fakeContainerEngine({ localImageId: PINNED_IMAGE_ID, ...settings });
  const logged: RunnerLogEntry[] = [];
  const runner = dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT, log: (entry) => { logged.push(entry); } });
  const started = await runner.start(imageDigest(PINNED_IMAGE_ID), POLICY);
  const level = runner.guaranteeLevel();
  if (started.ok) await started.value.stop();
  return { level, logged, startedCode: started.ok ? null : started.error.code };
}

const loggedCodes = (logged: readonly RunnerLogEntry[]): readonly string[] => logged.map((entry) => entry.code);

// What a run with this guarantee level vouches for, as its result and report state it.
const statementFor = (level: GuaranteeLevel) =>
  guaranteeStatement({ mode: 'plan', egressEnforced: level === 'isolated', unmaskedScreenshotsKept: false, unsafeFeatures: [] });

test('before any run has started, the runner claims only the host level', { criterion: 'AC-SPEC-07-05' }, () => {
  const engine = fakeContainerEngine({ localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  assert.equal(dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT }).guaranteeLevel(), 'host');
});

test('when the probe from inside the container reaches outside, the level is host and egress-unenforceable is logged', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { level, logged, startedCode } = await startOn({ internalNetworks: true, probe: 'reached' });
  assert.equal(level, 'host');
  assert.ok(loggedCodes(logged).includes('egress-unenforceable'), JSON.stringify(logged));
  assert.ok(startedCode === null || startedCode === 'egress-unenforceable', `start failed with ${String(startedCode)}`);
});

test('when Docker cannot create a network with no route out, the level is host and egress-unenforceable is logged', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { level, logged, startedCode } = await startOn({ internalNetworks: false, probe: 'blocked' });
  assert.equal(level, 'host');
  assert.ok(loggedCodes(logged).includes('egress-unenforceable'), JSON.stringify(logged));
  assert.ok(startedCode === null || startedCode === 'egress-unenforceable', `start failed with ${String(startedCode)}`);
});

test('a run at the host level states egress and credentials as lost to egress-unenforceable, and claims no isolation', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { level } = await startOn({ internalNetworks: true, probe: 'reached' });
  const statement = statementFor(level);
  assert.equal(statement.level, 'host');
  assert.ok(!statement.holds.includes('egress-enforced'));
  assert.ok(!statement.holds.includes('no-ambient-credentials'));
  assert.ok(statement.lost.some((loss) => loss.guarantee === 'egress-enforced' && loss.because === 'egress-unenforceable'), JSON.stringify(statement.lost));
});

test('counter-example: when every part started and the probe was blocked, the level is isolated and nothing is logged as unenforceable', { criterion: 'AC-SPEC-07-05' }, async () => {
  const { level, logged, startedCode } = await startOn({ internalNetworks: true, probe: 'blocked' });
  assert.equal(startedCode, null);
  assert.equal(level, 'isolated');
  assert.ok(!loggedCodes(logged).includes('egress-unenforceable'), JSON.stringify(logged));
  const statement = statementFor(level);
  assert.ok(statement.holds.includes('egress-enforced'));
  assert.ok(statement.holds.includes('no-ambient-credentials'));
});
