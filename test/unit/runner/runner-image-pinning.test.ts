// The run image is pinned by digest. start() compares the digest it is given with the id of the
// local run image: when there is no local image it returns image-missing, when the ids differ it
// returns image-digest-mismatch, and in both cases nothing starts: no network, no container, so no
// browser. The container engine here is a fake that records every call; the matching digest is the
// counter-example that shows the same runner does start containers.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerRunner, type RunnerLogEntry } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { ENGINE_STARTING_CALLS, fakeContainerEngine, type FakeEngineSettings } from './fake-container-engine.ts';
import { egressPolicy, imageDigest, OTHER_IMAGE_ID, PINNED_IMAGE_ID } from './runner-examples.ts';

const POLICY = egressPolicy({ allowOrigins: ['https://staging.example.test'] });

function runnerOn(settings: FakeEngineSettings) {
  const engine = fakeContainerEngine(settings);
  const logged: RunnerLogEntry[] = [];
  const runner = dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT, log: (entry) => { logged.push(entry); } });
  return { engine, runner, logged };
}

const startingCalls = (calls: readonly string[]): readonly string[] => calls.filter((call) => ENGINE_STARTING_CALLS.includes(call));

test('with no local run image, start returns image-missing and starts nothing', { criterion: 'AC-SPEC-07-06' }, async () => {
  const { engine, runner } = runnerOn({ localImageId: null, internalNetworks: true, probe: 'blocked' });
  const started = await runner.start(imageDigest(PINNED_IMAGE_ID), POLICY);
  assert.ok(!started.ok);
  assert.deepEqual(started.error, { code: 'image-missing' });
  assert.deepEqual(startingCalls(engine.calls), []);
  assert.deepEqual(engine.started, []);
  assert.deepEqual(engine.existingNetworks(), []);
});

test('when the local run image has another id, start returns image-digest-mismatch and starts nothing', { criterion: 'AC-SPEC-07-06' }, async () => {
  const { engine, runner } = runnerOn({ localImageId: OTHER_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  const started = await runner.start(imageDigest(PINNED_IMAGE_ID), POLICY);
  assert.ok(!started.ok);
  assert.deepEqual(started.error, { code: 'image-digest-mismatch' });
  assert.deepEqual(startingCalls(engine.calls), []);
  assert.deepEqual(engine.started, []);
  assert.deepEqual(engine.existingNetworks(), []);
});

test('a refused image leaves the runner at the host guarantee level', { criterion: 'AC-SPEC-07-06' }, async () => {
  const { runner } = runnerOn({ localImageId: OTHER_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  await runner.start(imageDigest(PINNED_IMAGE_ID), POLICY);
  assert.equal(runner.guaranteeLevel(), 'host');
});

test('counter-example: with the pinned image present, the same runner starts its containers and removes them on stop', { criterion: 'AC-SPEC-07-06' }, async () => {
  const { engine, runner } = runnerOn({ localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  const started = await runner.start(imageDigest(PINNED_IMAGE_ID), POLICY);
  assert.ok(started.ok, JSON.stringify(started));
  try {
    assert.ok(engine.started.length >= 1, 'at least the run container started');
    assert.ok(engine.started.every((options) => options.image === PINNED_IMAGE_ID), 'every container runs the pinned image');
  } finally {
    await started.value.stop();
  }
  assert.deepEqual(engine.runningContainers(), [], 'stop removes every container the run started');
  assert.deepEqual(engine.existingNetworks(), [], 'stop removes the run\'s network');
});
