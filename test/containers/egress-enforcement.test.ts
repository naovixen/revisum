// Egress is enforced in a real run: the run container sits on a Docker network with no route out,
// so a connection from inside that does not go through the proxy has nowhere to go, and the runner
// reports the isolated guarantee level. One plan then runs inside the container, through exec,
// with the CDP driver behind the run's proxy: its page opens a WebSocket to an undeclared origin,
// which the browser's own request interception cannot see, and the proxy blocks and records it.
// Reaching the proxy itself from inside is the counter-example that shows the probe can succeed.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hostOf } from '../unit/runner/runner-examples.ts';
import { jsonInside, startIsolatedRun, type IsolatedRun } from './isolated-run.ts';

const TIMEOUT = 600_000;
// Public addresses that answer on these ports from any ordinary network.
const OUTSIDE_TARGETS = [{ host: '1.1.1.1', port: 443 }, { host: '8.8.8.8', port: 53 }, { host: 'example.com', port: 80 }];

let run: IsolatedRun;
before(async () => {
  // The plan run below needs its script, the test helpers it imports and the fixture app.
  run = await startIsolatedRun({ inputs: ['test', 'fixtures'] });
}, { timeout: TIMEOUT });
after(async () => { await run?.stop(); }, { timeout: TIMEOUT });

// Tries a direct TCP connection from inside the container, bypassing the proxy, and prints
// "reached" or "blocked" within a few seconds.
const directConnection = (host: string, port: number): string => `
  const socket = require('node:net').connect({ host: ${JSON.stringify(host)}, port: ${port} });
  const finish = (outcome) => { console.log(JSON.stringify(outcome)); socket.destroy(); process.exit(0); };
  socket.setTimeout(4000, () => finish('blocked'));
  socket.on('connect', () => finish('reached'));
  socket.on('error', () => finish('blocked'));`;

test('the runner reports the isolated level once the probe from inside has failed', { criterion: 'AC-SPEC-07-05', timeout: TIMEOUT }, () => {
  assert.equal(run.runner.guaranteeLevel(), 'isolated');
  assert.ok(!run.logged.some((entry) => entry.code === 'egress-unenforceable'), JSON.stringify(run.logged));
});

for (const { host, port } of OUTSIDE_TARGETS) {
  test(`a direct connection from inside to ${host}:${port}, bypassing the proxy, finds no route out`, { criterion: 'AC-SPEC-07-05', timeout: TIMEOUT }, async () => {
    assert.equal(await jsonInside(run.handle, directConnection(host, port)), 'blocked');
  });
}

test('counter-example: the same probe reaches the run\'s proxy, which is on the container\'s network', { criterion: 'AC-SPEC-07-05', timeout: TIMEOUT }, async () => {
  const proxyAddress = await jsonInside(run.handle, 'console.log(JSON.stringify(process.env.HTTP_PROXY ?? ""))');
  assert.ok(typeof proxyAddress === 'string' && proxyAddress !== '', 'the run container is told where its proxy is');
  const proxy = new URL(proxyAddress);
  assert.equal(await jsonInside(run.handle, directConnection(proxy.hostname, Number(proxy.port))), 'reached');
});

test('a plan run inside the container passes while its WebSocket to an undeclared origin is blocked by the proxy', { criterion: 'AC-SPEC-07-01', timeout: TIMEOUT }, async () => {
  const outcome = await run.handle.exec(['node', 'test/containers/plan-run-inside.ts']);
  assert.equal(outcome.exitCode, 0, `the plan run inside the container failed: ${outcome.stderr}`);
  const printed: unknown = JSON.parse(outcome.stdout.trim().split('\n').at(-1) ?? 'null');
  // The plan's last check passes only once the page shows its WebSocket was closed.
  assert.deepEqual(printed, { state: 'Passed' });
  const outside = run.handle.egressEvents().filter((event) => hostOf(String(event.origin)) === 'outside.invalid');
  assert.ok(outside.length >= 1, `the proxy recorded the WebSocket: ${JSON.stringify(run.handle.egressEvents())}`);
  assert.ok(outside.every((event) => event.decision === 'blocked'), JSON.stringify(outside));
});
