// What a run handle keeps of the proxy container's evidence, on a fake container engine that answers
// reads of the proxy's files. Three things a real run depends on:
//   - each applied rewrite is read back, so a mutated run's manifest differs from a plain run's;
//   - the proxy's decisions are read back, and joined with the browser's records the run hands in;
//   - a read that fails keeps what was already read, unless the file simply does not exist yet.
// What these tests assume about shapes the spec leaves open: the runner reads each file with a
// command naming its path, the rewrites' path holds "rewrite" and the decisions' path "decision",
// and each applied rewrite is one JSON line of { origin, name }, as each decision is of { origin, decision }.
// The tests in test/containers/proxy-evidence.test.ts run the same behaviour on the real proxy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { success, type ExecOutcome } from '@revisum/contracts';
import { buildManifest, manifestHash, type AdapterInfo } from '@revisum/engine';
import { dockerRunner, type ContainerEngine } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { defaultParser, signupPlan, testProject } from '../engine/plan-examples.ts';
import { fakeContainerEngine } from './fake-container-engine.ts';
import { egressPolicy, imageDigest, origin, PINNED_IMAGE_ID, startRun, type StartedRun } from './runner-examples.ts';

const POLICY = egressPolicy({ allowOrigins: ['http://app.test'] });
const APP = origin('http://app.test');
const OUTSIDE = 'outside.test:443';

// What reading one of the proxy's files finds: each read takes the next answer, then keeps the last.
type FileAnswers = { readonly decisions?: readonly ExecOutcome[]; readonly rewrites?: readonly ExecOutcome[] };

const lines = (...entries: readonly unknown[]): ExecOutcome => ({ exitCode: 0, stdout: entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), stderr: '' });
const notWrittenYet: ExecOutcome = { exitCode: 1, stdout: '', stderr: 'cat: /tmp/proxy-file.jsonl: No such file or directory\n' };

function engineWithProxyFiles(answers: FileAnswers): ContainerEngine {
  const inner = fakeContainerEngine({ localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked' });
  const reads = { decisions: 0, rewrites: 0 };
  const answer = (kind: 'decisions' | 'rewrites'): ExecOutcome => {
    const kept = answers[kind] ?? [];
    const found = kept[Math.min(reads[kind], kept.length - 1)] ?? notWrittenYet;
    reads[kind] += 1;
    return found;
  };
  return {
    ...inner,
    async exec(containerId, command, environmentNames) {
      const words = command.join(' ');
      if (/rewrite/i.test(words)) {return success(answer('rewrites'));}
      if (/decision/i.test(words)) {return success(answer('decisions'));}
      return inner.exec(containerId, command, environmentNames);
    },
  };
}

async function startedHandle(answers: FileAnswers): Promise<StartedRun> {
  const runner = dockerRunner({ engine: engineWithProxyFiles(answers), repositoryRoot: REPOSITORY_ROOT });
  const started = await startRun(runner, imageDigest(PINNED_IMAGE_ID), POLICY);
  assert.ok(started.ok, JSON.stringify(started));
  return started.value;
}

// ---- Applied rewrites -------------------------------------------------------------------------------

const HEADING_CHANGED = { origin: APP, name: 'heading-changed' };
const STATUS_FLIPPED = { origin: APP, name: 'status-flipped' };

test('the handle gives back each rewrite the proxy container wrote to its file', async () => {
  const handle = await startedHandle({ rewrites: [lines(HEADING_CHANGED, STATUS_FLIPPED)] });
  await handle.exec(['true']);
  assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED, STATUS_FLIPPED]);
  await handle.stop();
});

test('the applied rewrites are still there after the run has stopped and its containers are gone', async () => {
  const handle = await startedHandle({ rewrites: [lines(HEADING_CHANGED)] });
  await handle.stop();
  assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
});

test('a line in the rewrites file that is not an applied rewrite is left out', async () => {
  const handle = await startedHandle({
    rewrites: [{ exitCode: 0, stdout: `not json\n${JSON.stringify({ origin: APP })}\n${JSON.stringify(HEADING_CHANGED)}\n`, stderr: '' }],
  });
  await handle.stop();
  assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
});

test('counter-example: a run whose proxy applied no rewrite has none, so its file does not exist', async () => {
  const handle = await startedHandle({ rewrites: [notWrittenYet] });
  await handle.stop();
  assert.deepEqual(handle.rewritesApplied(), []);
});

test('a mutated run\'s manifest hash differs from a plain run\'s, from what each handle read back', async () => {
  const parsed = defaultParser()(signupPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const target = testProject().matrix[0];
  assert.ok(target !== undefined);
  const adapter: AdapterInfo = { id: 'cdp', version: '0.1.0', protocol: 'Chrome DevTools Protocol (raw WebSocket)' };
  const manifestOf = (handle: StartedRun) => buildManifest({
    plan: parsed.value, target, adapter, browser: { name: 'chromium', version: '156.0.8078.47' }, seed: 42,
    fixedTimeMilliseconds: Date.UTC(2026, 10, 1, 9, 0, 0), fixtures: [], host: { platform: 'linux', arch: 'x64' }, responseRewrites: handle.rewritesApplied(),
  });
  const mutated = await startedHandle({ rewrites: [lines(HEADING_CHANGED)] });
  const plain = await startedHandle({ rewrites: [notWrittenYet] });
  await mutated.stop();
  await plain.stop();
  assert.deepEqual(manifestOf(mutated).responseRewrites, [HEADING_CHANGED]);
  assert.ok(!Object.hasOwn(manifestOf(plain), 'responseRewrites'));
  assert.notEqual(manifestHash(manifestOf(mutated)), manifestHash(manifestOf(plain)));
});

// ---- Decisions and the browser's records ----------------------------------------------------------------

const OUTSIDE_BLOCKED = { origin: OUTSIDE, decision: 'blocked' };
const APP_ALLOWED = { origin: APP, decision: 'allowed' };

test('the handle gives back the proxy\'s decisions, in the order they were made', async () => {
  const handle = await startedHandle({ decisions: [lines(APP_ALLOWED, OUTSIDE_BLOCKED)] });
  await handle.exec(['true']);
  assert.deepEqual(handle.proxyDecisions(), [APP_ALLOWED, OUTSIDE_BLOCKED]);
  await handle.stop();
});

test('egress events take their channels from the browser\'s records the run hands in', async () => {
  const handle = await startedHandle({ decisions: [lines(OUTSIDE_BLOCKED)] });
  await handle.exec(['true']);
  assert.deepEqual(handle.egressEvents([{ origin: 'wss://outside.test', channel: 'websocket' }]), [
    { origin: 'wss://outside.test', channel: 'websocket', decision: 'blocked' },
  ]);
  await handle.stop();
});

test('egress events judge a record with no decision by the direct origins the run hands in', async () => {
  const handle = await startedHandle({ decisions: [notWrittenYet] });
  await handle.exec(['true']);
  const loopback = origin('http://127.0.0.1:4310');
  const records = [{ origin: loopback, channel: 'page' as const }];
  assert.deepEqual(handle.egressEvents(records, [loopback]), [{ origin: loopback, channel: 'page', decision: 'allowed' }]);
  assert.deepEqual(handle.egressEvents(records), [{ origin: loopback, channel: 'page', decision: 'blocked' }]);
  await handle.stop();
});

test('counter-example: with no records handed in, every decision stays unattributed', async () => {
  const handle = await startedHandle({ decisions: [lines(OUTSIDE_BLOCKED)] });
  await handle.exec(['true']);
  assert.deepEqual(handle.egressEvents(), [{ origin: OUTSIDE, channel: 'unattributed', decision: 'blocked' }]);
  await handle.stop();
});

// ---- A read that fails ------------------------------------------------------------------------------------

const FAILED_READS: readonly { readonly why: string; readonly read: ExecOutcome }[] = [
  { why: 'the proxy container has stopped', read: { exitCode: 1, stdout: '', stderr: 'Error response from daemon: container fake-container-1 is not running\n' } },
  { why: 'the proxy container is gone', read: { exitCode: 1, stdout: '', stderr: 'Error response from daemon: No such container: fake-container-1\n' } },
  { why: 'Docker could not start the read', read: { exitCode: 125, stdout: '', stderr: 'docker: error during connect\n' } },
  { why: 'the read was killed', read: { exitCode: 137, stdout: '', stderr: '' } },
  { why: 'the file could not be read', read: { exitCode: 1, stdout: '', stderr: 'cat: /tmp/proxy-file.jsonl: Input/output error\n' } },
];

for (const { why, read } of FAILED_READS) {
  test(`the decisions already read survive a failed read: ${why}`, async () => {
    const handle = await startedHandle({ decisions: [lines(OUTSIDE_BLOCKED), read] });
    await handle.exec(['true']);
    assert.deepEqual(handle.proxyDecisions(), [OUTSIDE_BLOCKED], 'the first read found the decision');
    await handle.exec(['true']);
    assert.deepEqual(handle.proxyDecisions(), [OUTSIDE_BLOCKED]);
    assert.deepEqual(handle.egressEvents(), [{ origin: OUTSIDE, channel: 'unattributed', decision: 'blocked' }]);
    await handle.stop();
    assert.deepEqual(handle.proxyDecisions(), [OUTSIDE_BLOCKED], 'stopping does not lose them either');
  });

  test(`the rewrites already read survive a failed read: ${why}`, async () => {
    const handle = await startedHandle({ rewrites: [lines(HEADING_CHANGED), read] });
    await handle.exec(['true']);
    await handle.stop();
    assert.deepEqual(handle.rewritesApplied(), [HEADING_CHANGED]);
  });
}

test('counter-example: a file that does not exist yet reads as no lines, and later lines still arrive', async () => {
  const handle = await startedHandle({ decisions: [notWrittenYet, lines(OUTSIDE_BLOCKED)] });
  await handle.exec(['true']);
  assert.deepEqual(handle.proxyDecisions(), []);
  await handle.exec(['true']);
  assert.deepEqual(handle.proxyDecisions(), [OUTSIDE_BLOCKED]);
  await handle.stop();
});
