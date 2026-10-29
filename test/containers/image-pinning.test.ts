// With the real Docker, start() refuses an image digest that is not the local run image's id:
// it returns image-digest-mismatch, and no container or network is created, so no browser can
// launch. Starting with the right id, which does create them, is the counter-example; stopping
// that run removes everything it created.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerCliEngine, dockerRunner } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { egressPolicy, imageDigest } from '../unit/runner/runner-examples.ts';
import { dockerIds, newIds, pinnedRunImage } from './isolated-run.ts';

const TIMEOUT = 600_000;
const POLICY = egressPolicy({ allowOrigins: [] });

// Another well-formed digest: the pinned id with its last hex digit changed.
const alteredDigest = (digest: string): string => `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;

test('a digest that differs from the local run image\'s id is refused with image-digest-mismatch, and nothing is created', { criterion: 'AC-SPEC-07-06', timeout: TIMEOUT }, async () => {
  const pinned = await pinnedRunImage();
  const containersBefore = dockerIds('containers');
  const networksBefore = dockerIds('networks');
  const runner = dockerRunner({ engine: dockerCliEngine(), repositoryRoot: REPOSITORY_ROOT });
  const started = await runner.start(imageDigest(alteredDigest(pinned)), POLICY);
  if (started.ok) await started.value.stop();
  assert.ok(!started.ok, 'the altered digest must be refused');
  assert.deepEqual(started.error, { code: 'image-digest-mismatch' });
  assert.deepEqual(newIds(containersBefore, dockerIds('containers')), [], 'no container was created');
  assert.deepEqual(newIds(networksBefore, dockerIds('networks')), [], 'no network was created');
  assert.equal(runner.guaranteeLevel(), 'host');
});

test('counter-example: the pinned id starts the run, and stopping it removes every container and network it created', { criterion: 'AC-SPEC-07-06', timeout: TIMEOUT }, async () => {
  const pinned = await pinnedRunImage();
  const containersBefore = dockerIds('containers');
  const networksBefore = dockerIds('networks');
  const runner = dockerRunner({ engine: dockerCliEngine(), repositoryRoot: REPOSITORY_ROOT });
  const started = await runner.start(pinned, POLICY);
  assert.ok(started.ok, JSON.stringify(started));
  try {
    assert.ok(newIds(containersBefore, dockerIds('containers')).length >= 1, 'the run created its containers');
    assert.ok(newIds(networksBefore, dockerIds('networks')).length >= 1, 'the run created its network');
  } finally {
    await started.value.stop();
  }
  assert.deepEqual(newIds(containersBefore, dockerIds('containers')), [], 'stop left no container behind');
  assert.deepEqual(newIds(networksBefore, dockerIds('networks')), [], 'stop left no network behind');
});
