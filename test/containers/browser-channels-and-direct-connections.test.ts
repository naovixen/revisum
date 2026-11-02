// Inside a real run container:
//   - the channels of egress events come from the browser's records, printed by the process inside
//     the container, so a WebSocket's event says websocket, not only its origin and decision;
//   - a direct connection that ignores the proxy, to a cloud metadata address, the Docker gateway or
//     host.docker.internal, finds nothing. A service really is listening on the Docker host for
//     these probes, and an ordinary container does reach it, and the same probe does reach the
//     run's proxy: the counter-examples that show the probe can succeed;
//   - cutting the gateway off does not cut the run off: the runner still reports the isolated level,
//     the proxy still carries a declared request out, and the network's peers still reach each other.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { platform } from 'node:os';
import { after, before, test } from 'node:test';
import { PRODUCT, type BrowserRequestRecord } from '@revisum/contracts';
import { runDocker } from '@revisum/runner';
import { declaredService, egressPolicy, hostOf } from '../unit/runner/runner-examples.ts';
import { jsonInside, pinnedRunImage, startIsolatedRun, type IsolatedRun } from './isolated-run.ts';

const TIMEOUT = 600_000;
const OUTSIDE_HOST = 'outside.invalid';

// A service listening on every interface of the Docker host, in a container on the host's own
// network. Without one, a probe of the gateway would find nothing even with a route to it.
type DockerHostService = { readonly name: string; readonly image: string; readonly port: number };

// Letters only, so it can be searched for in what comes back.
const DOCKER_HOST_SERVICE_BODY = 'dockerhostservicebody';
const DOCKER_HOST_SERVICE_NAME = 'docker-host-service';

const dockerHostServiceScript = `
  const server = require('node:http').createServer((request, response) => response.end(${JSON.stringify(DOCKER_HOST_SERVICE_BODY)}));
  server.listen(0, '0.0.0.0', () => console.log('listening ' + server.address().port));`;

async function startDockerHostService(): Promise<DockerHostService> {
  const image = await pinnedRunImage();
  const name = `${PRODUCT.name}-host-service-${randomBytes(6).toString('hex')}`;
  const started = await runDocker([
    'run', '--detach', '--rm', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'node', image, 'node', '-e', dockerHostServiceScript,
  ]);
  assert.equal(started.status, 0, `the service on the Docker host did not start: ${started.stderr}`);
  for (let tries = 0; tries < 50; tries++) {
    const port = /listening (\d+)/.exec((await runDocker(['logs', name])).stdout)?.[1];
    if (port !== undefined) return { name, image, port: Number(port) };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await runDocker(['stop', '--time', '1', name]);
  assert.fail('the service on the Docker host never said it was listening');
}

// A service on the machine host.docker.internal names under Docker Desktop: the machine running
// Docker Desktop, where a loopback listener answers it and raises no firewall prompt. On Linux the
// tests use the service on the Docker host's own network instead (see machineServicePort).
async function startMachineService(): Promise<TcpServer> {
  const server = createTcpServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// The address of the default bridge's gateway, which the proxy reaches and the run container must not.
async function gatewayOf(network: string): Promise<string> {
  const inspected = await runDocker(['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const subnet = /(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/\d+/.exec(inspected.stdout);
  assert.ok(subnet?.[1] !== undefined, `the network ${network} has an IPv4 subnet: ${inspected.stdout}`);
  // The subnet's first host, which is where Docker puts the gateway. A network made with no gateway
  // at all still has this address to try, and finds nothing.
  return `${subnet[1]}.1`;
}

let dockerHostService: DockerHostService;
let dockerHostServiceOrigin: string;
let machineService: TcpServer;
let run: IsolatedRun;
before(async () => {
  dockerHostService = await startDockerHostService();
  machineService = await startMachineService();
  dockerHostServiceOrigin = `http://${await gatewayOf('bridge')}:${dockerHostService.port}`;
  run = await startIsolatedRun({
    // The plan run below needs its script, the test helpers it imports and the fixture app.
    inputs: ['test', 'fixtures'],
    // The proxy, on the default bridge, may reach the Docker host's service, on a private address.
    policy: egressPolicy({ allowOrigins: [dockerHostServiceOrigin], allowServices: [DOCKER_HOST_SERVICE_NAME] }),
    services: [declaredService(DOCKER_HOST_SERVICE_NAME, dockerHostServiceOrigin, true)],
  });
}, { timeout: TIMEOUT });
after(async () => {
  await run?.stop();
  if (dockerHostService !== undefined) await runDocker(['stop', '--time', '1', dockerHostService.name]);
  machineService?.close();
}, { timeout: TIMEOUT });

// ---- The browser's records --------------------------------------------------------------------------

type PrintedRecords = { readonly browserRecords: readonly BrowserRequestRecord[]; readonly fixtureOrigin: string };
let printedRecords: PrintedRecords | undefined;

// The plan runs once; each test reads what it printed and what the proxy decided.
async function planRecords(): Promise<PrintedRecords> {
  if (printedRecords !== undefined) return printedRecords;
  const outcome = await run.handle.exec(['node', 'test/containers/plan-run-inside.ts']);
  assert.equal(outcome.exitCode, 0, `the plan run inside the container failed: ${outcome.stderr}`);
  const lines = outcome.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1) ?? 'null'), { state: 'Passed' });
  printedRecords = JSON.parse(lines.at(-2) ?? 'null') as PrintedRecords;
  return printedRecords;
}

test('a WebSocket to an undeclared origin is blocked and its event says websocket', { timeout: TIMEOUT }, async () => {
  const { browserRecords, fixtureOrigin } = await planRecords();
  const outside = run.handle.egressEvents(browserRecords, [fixtureOrigin]).filter((event) => hostOf(event.origin) === OUTSIDE_HOST);
  assert.ok(outside.some((event) => event.channel === 'websocket' && event.decision === 'blocked'), JSON.stringify(outside));
  assert.ok(outside.every((event) => event.decision === 'blocked'), JSON.stringify(outside));
});

test('the proxy\'s own decision for that WebSocket is read back from its container', { timeout: TIMEOUT }, async () => {
  await planRecords();
  const outside = run.handle.proxyDecisions().filter((decision) => hostOf(decision.origin) === OUTSIDE_HOST);
  assert.ok(outside.length >= 1, JSON.stringify(run.handle.proxyDecisions()));
  assert.ok(outside.every((decision) => decision.decision === 'blocked'), JSON.stringify(outside));
});

test('counter-example: without the browser\'s records the same decision has no channel, so the channel came from them', { timeout: TIMEOUT }, async () => {
  await planRecords();
  const outside = run.handle.egressEvents().filter((event) => hostOf(event.origin) === OUTSIDE_HOST);
  assert.ok(outside.length >= 1, JSON.stringify(run.handle.egressEvents()));
  assert.ok(outside.every((event) => event.channel === 'unattributed'), JSON.stringify(outside));
});

test('the page\'s request to its own loopback, which never reaches the proxy, is allowed only because the run names it direct', { timeout: TIMEOUT }, async () => {
  const { browserRecords, fixtureOrigin } = await planRecords();
  const named = run.handle.egressEvents(browserRecords, [fixtureOrigin]).filter((event) => event.origin === fixtureOrigin);
  assert.ok(named.some((event) => event.channel === 'page' && event.decision === 'allowed'), JSON.stringify(named));
  const unnamed = run.handle.egressEvents(browserRecords).filter((event) => event.origin === fixtureOrigin);
  assert.ok(unnamed.length >= 1 && unnamed.every((event) => event.decision === 'blocked'), JSON.stringify(unnamed));
});

// ---- Direct connections -----------------------------------------------------------------------------

// Tries a direct TCP connection from inside the container, ignoring the proxy, and prints whether
// it was reached, within a few seconds.
const directConnection = (host: string, port: number): string => `
  const socket = require('node:net').connect({ host: ${JSON.stringify(host)}, port: ${port} });
  const finish = (outcome) => { console.log(JSON.stringify(outcome)); socket.destroy(); process.exit(0); };
  socket.setTimeout(4000, () => finish('blocked'));
  socket.on('connect', () => finish('reached'));
  socket.on('error', () => finish('blocked'));`;

const METADATA_TARGETS = [
  { host: '169.254.169.254', port: 80 },
  { host: '100.100.100.200', port: 80 },
  { host: 'fd00:ec2::254', port: 80 },
  { host: 'metadata.google.internal', port: 80 },
];

for (const { host, port } of METADATA_TARGETS) {
  test(`a direct connection from inside to the metadata address ${host}:${port} finds nothing`, { timeout: TIMEOUT }, async () => {
    assert.equal(await jsonInside(run.handle, directConnection(host, port)), 'blocked');
  });
}

for (const network of ['the run\'s own network', 'the default bridge']) {
  test(`a direct connection from inside to the gateway of ${network} does not reach a service on the Docker host`, { timeout: TIMEOUT }, async () => {
    const gateway = await gatewayOf(network === 'the default bridge' ? 'bridge' : `${run.handle.runId}-network`);
    assert.equal(await jsonInside(run.handle, directConnection(gateway, dockerHostService.port)), 'blocked', `${gateway}:${dockerHostService.port}`);
  });
}

test('counter-example: an ordinary container on the default bridge does reach that service through its gateway', { timeout: TIMEOUT }, async () => {
  const gateway = await gatewayOf('bridge');
  const probed = await runDocker(['run', '--rm', '--network', 'bridge', '--user', 'node', dockerHostService.image, 'node', '-e', directConnection(gateway, dockerHostService.port)]);
  assert.equal(probed.status, 0, probed.stderr);
  assert.equal(JSON.parse(probed.stdout.trim()), 'reached', `${gateway}:${dockerHostService.port}`);
});

// On Linux the name leads to the Docker host. The test process may itself be in a container, as in
// CI, so only a service on the host's own network is sure to be there.
const machineServicePort = (): number => (
  platform() === 'linux' ? dockerHostService.port : (machineService.address() as AddressInfo).port
);

// A name that does not resolve counts as blocked too: the script's connection simply fails.
test('a direct connection from inside to host.docker.internal does not reach a service on that machine', { timeout: TIMEOUT }, async () => {
  assert.equal(await jsonInside(run.handle, directConnection('host.docker.internal', machineServicePort())), 'blocked');
});

test('counter-example: an ordinary container on the default bridge does reach that service through host.docker.internal', { timeout: TIMEOUT }, async () => {
  const probed = await runDocker([
    'run', '--rm', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', '--user', 'node', dockerHostService.image,
    'node', '-e', directConnection('host.docker.internal', machineServicePort()),
  ]);
  assert.equal(probed.status, 0, probed.stderr);
  assert.equal(JSON.parse(probed.stdout.trim()), 'reached', `host.docker.internal:${machineServicePort()}`);
});

test('counter-example: the same probe reaches the run\'s proxy, which is on the container\'s network', { timeout: TIMEOUT }, async () => {
  const proxyAddress = await jsonInside(run.handle, 'console.log(JSON.stringify(process.env.HTTP_PROXY ?? ""))');
  assert.ok(typeof proxyAddress === 'string' && proxyAddress !== '', 'the run container is told where its proxy is');
  const proxy = new URL(proxyAddress);
  assert.equal(await jsonInside(run.handle, directConnection(proxy.hostname, Number(proxy.port))), 'reached');
});

// ---- The run still works on its network ------------------------------------------------------------

test('the runner reports the isolated level on the run\'s network, with nothing logged as unenforceable', { timeout: TIMEOUT }, () => {
  assert.equal(run.runner.guaranteeLevel(), 'isolated');
  assert.ok(!run.logged.some((entry) => entry.code === 'egress-unenforceable'), JSON.stringify(run.logged));
});

// Asks the run's proxy for a URL, from inside the run container, and prints the answer.
const throughProxy = (url: string): string => `
  const proxy = new URL(process.env.HTTP_PROXY);
  const target = new URL(${JSON.stringify(url)});
  const outgoing = require('node:http').request({ host: proxy.hostname, port: proxy.port, path: target.href, headers: { host: target.host } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })));
  });
  outgoing.on('error', (error) => { console.error(error.message); process.exit(1); });
  outgoing.end();`;

test('the proxy still carries a declared request out of the run\'s network', { timeout: TIMEOUT }, async () => {
  assert.deepEqual(await jsonInside(run.handle, throughProxy(`${dockerHostServiceOrigin}/`)), { status: 200, body: DOCKER_HOST_SERVICE_BODY });
});

test('counter-example: the proxy still refuses an undeclared request from the run\'s network', { timeout: TIMEOUT }, async () => {
  const answer = await jsonInside(run.handle, throughProxy('http://undeclared.invalid/'));
  assert.equal((answer as { readonly status: number }).status, 403);
});

test('peers on the run\'s network still reach each other by name, in both directions', { timeout: TIMEOUT }, async () => {
  const peerPort = 4500;
  const runContainer = `${run.handle.runId}-run`;
  const proxyContainer = `${run.handle.runId}-proxy`;
  const listening = await runDocker([
    'exec', '--detach', runContainer, 'node', '-e', `require('node:net').createServer((socket) => socket.end()).listen(${peerPort}, '0.0.0.0')`,
  ]);
  assert.equal(listening.status, 0, listening.stderr);
  let fromProxy: unknown = null;
  for (let tries = 0; tries < 20 && fromProxy !== 'reached'; tries++) {
    const probed = await runDocker(['exec', proxyContainer, 'node', '-e', directConnection(runContainer, peerPort)]);
    assert.equal(probed.status, 0, probed.stderr);
    fromProxy = JSON.parse(probed.stdout.trim());
    if (fromProxy !== 'reached') await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(fromProxy, 'reached', 'the proxy reached the run container');
  assert.equal(await jsonInside(run.handle, directConnection(proxyContainer, 3128)), 'reached', 'the run container reached the proxy');
});
