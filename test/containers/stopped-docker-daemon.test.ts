// A Docker daemon that is not running says nothing about whether an image exists, so the isolated
// runner must report start-failed and the workload runner workload-start-failed, not image-missing.
// The test points the real Docker client at an address where no daemon listens, as a stopped daemon
// looks to the client; it stops nothing. The counter-examples ask the running daemon for an image it
// really does not have, which is image-missing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerCliEngine, dockerRunner, type ContainerEngine, type RunnerLogEntry } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from '../unit/runner/runner-examples.ts';
import { errorCode, runnerOn, workloadRequest } from '../unit/runner/workload-examples.ts';
import { holdRunOpen, requireDocker } from './isolated-run.ts';

const TIMEOUT = 120_000;
const POLICY = egressPolicy({ allowOrigins: [] });
const NO_DAEMON_HERE = 'tcp://127.0.0.1:1';

function startOn(engine: ContainerEngine) {
  const logged: RunnerLogEntry[] = [];
  const runner = dockerRunner({ engine, repositoryRoot: REPOSITORY_ROOT, log: (entry) => { logged.push(entry); } });
  return { logged, runner, started: holdRunOpen(runner, imageDigest(PINNED_IMAGE_ID), POLICY) };
}

// Runs `body` with the Docker client pointed where no daemon listens, then points it back.
async function withNoDaemon(body: () => Promise<void>): Promise<void> {
  const previous = process.env['DOCKER_HOST'];
  process.env['DOCKER_HOST'] = NO_DAEMON_HERE;
  try {
    await body();
  } finally {
    if (previous === undefined) {Reflect.deleteProperty(process.env, 'DOCKER_HOST');}
    else {process.env['DOCKER_HOST'] = previous;}
  }
}

// The real daemon, asked about a tag that does not exist in place of the run image's own, which this machine may hold.
function engineWithoutTheImage(): ContainerEngine {
  const engine = dockerCliEngine();
  return { ...engine, imageId: (reference) => engine.imageId(`${reference}-absent-for-this-test`) };
}

test('with no Docker daemon to answer, start gives start-failed, not image-missing', { timeout: TIMEOUT }, async () => {
  requireDocker();
  await withNoDaemon(async () => {
    const { logged, started } = startOn(dockerCliEngine());
    const outcome = await started;
    assert.ok(!outcome.ok, 'nothing can start without a daemon');
    assert.deepEqual(outcome.error, { code: 'start-failed' });
    assert.ok(logged.some((entry) => entry.code === 'start-failed'), JSON.stringify(logged));
  });
});

test('counter-example: with the daemon running and the run image absent, start gives image-missing', { timeout: TIMEOUT }, async () => {
  requireDocker();
  const outcome = await startOn(engineWithoutTheImage()).started;
  if (outcome.ok) {await outcome.value.stop();}
  assert.ok(!outcome.ok, 'the image is absent');
  assert.deepEqual(outcome.error, { code: 'image-missing' });
});

test('with no Docker daemon to answer, the workload runner gives workload-start-failed, not image-missing', { timeout: TIMEOUT }, async () => {
  requireDocker();
  await withNoDaemon(async () => {
    const { runner, logged } = runnerOn(dockerCliEngine());
    const outcome = await runner.run(workloadRequest());
    assert.equal(errorCode(outcome), 'workload-start-failed');
    assert.ok(logged.some((entry) => entry.code === 'workload-start-failed'), JSON.stringify(logged));
  });
});

test('counter-example: with the daemon running and the run image absent, the workload runner gives image-missing', { timeout: TIMEOUT }, async () => {
  requireDocker();
  const outcome = await runnerOn(engineWithoutTheImage()).runner.run(workloadRequest());
  assert.equal(errorCode(outcome), 'image-missing');
});
